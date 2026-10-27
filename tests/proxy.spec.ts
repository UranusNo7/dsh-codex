import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EnvHttpProxyAgent,
  getGlobalDispatcher,
  ProxyAgent,
  setGlobalDispatcher,
} from "undici";
import type { Dispatcher } from "undici";
import {
  normalizeProxyUrl,
  OPENAI_CODEX_PROBE_URL,
  OpenAICodexProxyTransport,
  probeProxyConnectivity,
} from "../src/proxy.ts";
import type { ProxyPreferences } from "../src/proxy.ts";

const undiciMock = vi.hoisted(() => ({
  fetch: vi.fn(),
  actualFetch: undefined as typeof import("undici").fetch | undefined,
}));

vi.mock("undici", async importOriginal => {
  const actual = await importOriginal<typeof import("undici")>();
  undiciMock.actualFetch = actual.fetch;
  undiciMock.fetch.mockImplementation(actual.fetch);
  return { ...actual, fetch: undiciMock.fetch };
});

const PROXY_ENVIRONMENT = [
  "DSH_CODEX_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "http_proxy",
  "HTTP_PROXY",
  "all_proxy",
  "ALL_PROXY",
  "no_proxy",
  "NO_PROXY",
] as const;

function clearProxyEnvironment(): () => void {
  const saved = new Map<string, string | undefined>();
  for (const name of PROXY_ENVIRONMENT) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

const transports = new Set<OpenAICodexProxyTransport>();

afterEach(async () => {
  await Promise.all([...transports].map(async (transport) => transport.dispose()));
  transports.clear();
  vi.unstubAllGlobals();
  undiciMock.fetch.mockReset();
  if (undiciMock.actualFetch !== undefined) {
    undiciMock.fetch.mockImplementation(undiciMock.actualFetch);
  }
});

function transportFor(preferences: ProxyPreferences): OpenAICodexProxyTransport {
  const transport = new OpenAICodexProxyTransport(() => preferences);
  transports.add(transport);
  return transport;
}

describe("OpenAICodexProxyTransport", () => {
  it("accepts only HTTP(S) proxy URLs without reflecting credentials", () => {
    expect(normalizeProxyUrl("  http://127.0.0.1:7890  ")).toBe(
      "http://127.0.0.1:7890"
    );
    expect(() => normalizeProxyUrl("socks5://secret@example.test:1080")).toThrow(
      "http:// or https://"
    );
    expect(() => normalizeProxyUrl("socks5://secret@example.test:1080")).not.toThrow(
      /secret/u
    );
  });

  it("leaves the process dispatcher untouched when disabled", async () => {
    const original = getGlobalDispatcher();
    const transport = transportFor({ proxyMode: "off", proxyUrl: "" });

    await transport.apply();

    expect(getGlobalDispatcher()).toBe(original);
  });

  it("restores the previous process dispatcher after global mode", async () => {
    const original = getGlobalDispatcher();
    const preferences: ProxyPreferences = {
      proxyMode: "global",
      proxyUrl: "http://127.0.0.1:7890",
    };
    const transport = transportFor(preferences);

    await transport.apply();
    expect(getGlobalDispatcher()).not.toBe(original);

    preferences.proxyMode = "off";
    await transport.apply();
    expect(getGlobalDispatcher()).toBe(original);
  });

  it("routes a scoped Codex request through the configured proxy", async () => {
    let observedUrl: string | undefined;
    const server = createServer((request, response) => {
      observedUrl = request.url;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("proxied");
    });
    const address = await new Promise<AddressInfo>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve(server.address() as AddressInfo);
      });
    });
    try {
      const transport = transportFor({
        proxyMode: "scoped",
        proxyUrl: `http://127.0.0.1:${String(address.port)}`,
      });

      const response = await transport.fetch("http://codex-probe.invalid/test");

      expect(await response.text()).toBe("proxied");
      expect(observedUrl).toBe("http://codex-probe.invalid/test");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
  });

  it("routes Codex traffic through the bundled network proxy mixed port", async () => {
    let dispatcher: Dispatcher | undefined;
    undiciMock.fetch.mockImplementation(async (_input, init) => {
      dispatcher = init?.dispatcher as Dispatcher;
      return { status: 200, body: null } as unknown as Response;
    });
    const transport = new OpenAICodexProxyTransport(
      () => ({ proxyMode: "off", proxyUrl: "" }),
      { managedProxyUrl: () => "http://127.0.0.1:2345" }
    );
    transports.add(transport);

    await transport.fetch("http://codex-probe.invalid/test");

    expect(dispatcher).toBeInstanceOf(ProxyAgent);
    expect(undiciMock.fetch).toHaveBeenCalledWith(
      "http://codex-probe.invalid/test",
      expect.objectContaining({ dispatcher })
    );
  });

  it("keeps an explicit scoped proxy ahead of the bundled network proxy", async () => {
    const managed = vi.fn(() => "http://127.0.0.1:2345");
    undiciMock.fetch.mockImplementation(
      async () => ({ status: 200, body: null }) as unknown as Response
    );
    const transport = new OpenAICodexProxyTransport(
      () => ({ proxyMode: "scoped", proxyUrl: "http://127.0.0.1:7890" }),
      { managedProxyUrl: managed }
    );
    transports.add(transport);

    await transport.fetch("http://codex-probe.invalid/test");

    expect(managed).not.toHaveBeenCalled();
    expect(undiciMock.fetch).toHaveBeenCalledTimes(1);
    const [, init] = undiciMock.fetch.mock.calls[0] as [string, Record<string, unknown>];
    expect(init["dispatcher"]).toBeInstanceOf(ProxyAgent);
  });

  it("does not stack a second global policy while the bundled proxy owns the dispatcher", async () => {
    const original = getGlobalDispatcher();
    const transport = new OpenAICodexProxyTransport(
      () => ({ proxyMode: "global", proxyUrl: "http://127.0.0.1:7890" }),
      { netProxyOwnsGlobal: () => true }
    );
    transports.add(transport);

    await transport.apply();

    expect(getGlobalDispatcher()).toBe(original);
  });

  it("keeps the bundled dispatcher when ownership moves while a manual global policy is active", async () => {
    const original = getGlobalDispatcher();
    let owns = false;
    const transport = new OpenAICodexProxyTransport(
      () => ({ proxyMode: "global", proxyUrl: "http://127.0.0.1:7890" }),
      { netProxyOwnsGlobal: () => owns }
    );
    transports.add(transport);

    // 1. Manual global policy is active and owns the dispatcher.
    await transport.apply();
    const manualDispatcher = getGlobalDispatcher();
    expect(manualDispatcher).not.toBe(original);

    // 2. The bundled proxy takes the slot over in "global" scope.
    const bundledDispatcher = {
      dispatch() {
        throw new Error("bundled dispatcher must stay installed");
      },
    } as unknown as Dispatcher;
    owns = true;
    setGlobalDispatcher(bundledDispatcher);

    // 3. A Codex fetch must not restore the older manual dispatcher over it.
    const globalFetch = vi.fn(async () => await Promise.resolve(new Response("ok")));
    vi.stubGlobal("fetch", globalFetch);
    const response = await transport.fetch("http://codex-probe.invalid/test");
    expect(await response.text()).toBe("ok");
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(getGlobalDispatcher()).toBe(bundledDispatcher);

    // 4. Bundled proxy off: it hands the manual dispatcher back; the next Codex
    //    call reconciles against the saved preferences without re-installing a
    //    duplicate policy on top.
    owns = false;
    setGlobalDispatcher(manualDispatcher);
    await transport.apply();
    expect(getGlobalDispatcher()).toBe(manualDispatcher);

    await transport.dispose();
    transports.delete(transport);
  });
});

describe("probeProxyConnectivity", () => {
  it("issues the fixed unauthenticated probe through a temporary dispatcher", async () => {
    const globalBefore = getGlobalDispatcher();
    let dispatcher: Dispatcher | undefined;
    const cancel = vi.fn(async () => undefined);
    let destroyed = false;
    undiciMock.fetch.mockImplementation(async (_input, init) => {
      dispatcher = init?.dispatcher as Dispatcher;
      const spy = vi.spyOn(dispatcher, "destroy");
      spy.mockImplementation(async () => {
        destroyed = true;
      });
      return { status: 200, body: { cancel } } as unknown as Response;
    });

    const result = await probeProxyConnectivity("http://127.0.0.1:7890", 1_000);

    expect(result.outcome).toBe("ok");
    expect(result.status).toBe(200);
    expect(result.explicitProxy).toBe(true);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    const [url, init] = undiciMock.fetch.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(url).toBe(OPENAI_CODEX_PROBE_URL);
    expect(init["method"]).toBe("GET");
    expect(init["redirect"]).toBe("manual");
    expect(init["headers"]).toBeUndefined();
    expect(init["body"]).toBeUndefined();
    expect(dispatcher).toBeInstanceOf(ProxyAgent);
    expect(dispatcher).not.toBe(globalBefore);
    expect(cancel).toHaveBeenCalled();
    expect(destroyed).toBe(true);
    expect(getGlobalDispatcher()).toBe(globalBefore);
  });

  it("uses the environment proxy settings when the saved URL is empty", async () => {
    const restore = clearProxyEnvironment();
    try {
      let dispatcher: Dispatcher | undefined;
      undiciMock.fetch.mockImplementation(async (_input, init) => {
        dispatcher = init?.dispatcher as Dispatcher;
        return { status: 200, body: null } as unknown as Response;
      });

      const result = await probeProxyConnectivity("", 1_000);

      expect(result.outcome).toBe("ok");
      expect(result.explicitProxy).toBe(false);
      expect(dispatcher).toBeInstanceOf(EnvHttpProxyAgent);
      expect(dispatcher).not.toBe(getGlobalDispatcher());
    } finally {
      restore();
    }
  });

  it("keeps the HTTP status of a rejected probe", async () => {
    undiciMock.fetch.mockImplementation(
      async () => ({ status: 403, body: null }) as unknown as Response
    );

    const result = await probeProxyConnectivity("http://127.0.0.1:7890", 1_000);

    expect(result).toMatchObject({
      outcome: "http-error",
      status: 403,
      explicitProxy: true,
    });
  });

  it("classifies a stalled probe as a timeout and destroys the dispatcher", async () => {
    let destroyed = false;
    undiciMock.fetch.mockImplementation(async (_input, init) => {
      const dispatcher = init?.dispatcher as Dispatcher;
      vi.spyOn(dispatcher, "destroy").mockImplementation(async () => {
        destroyed = true;
      });
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          },
          { once: true }
        );
      });
    });

    const started = Date.now();
    const result = await probeProxyConnectivity("http://127.0.0.1:7890", 25);

    expect(result.outcome).toBe("timeout");
    expect(result.elapsedMs).toBeLessThan(5_000);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(destroyed).toBe(true);
  });

  it("classifies connection failures without echoing the proxy URL", async () => {
    undiciMock.fetch.mockRejectedValue(
      new TypeError("connect ECONNREFUSED http://user:topsecret@127.0.0.1:7890")
    );

    const result = await probeProxyConnectivity(
      "http://user:topsecret@127.0.0.1:7890",
      1_000
    );

    expect(result.outcome).toBe("network-error");
    expect(result.explicitProxy).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/topsecret|user|7890|ECONNREFUSED/u);
  });

  it("returns a safe network error when the proxy environment is invalid", async () => {
    const restore = clearProxyEnvironment();
    process.env.DSH_CODEX_PROXY = "socks5://user:topsecret@127.0.0.1:1080";
    try {
      const result = await probeProxyConnectivity("", 1_000);

      expect(result.outcome).toBe("network-error");
      expect(JSON.stringify(result)).not.toMatch(/topsecret|user|socks5/u);
      expect(undiciMock.fetch).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
