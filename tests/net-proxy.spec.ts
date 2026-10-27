import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import type { Dispatcher } from "undici";
import * as netProxy from "../src/net-proxy/index.js";

const BASE = netProxy.NETWORK_PROXY_BASE_PATH;

const PROXY_ENVIRONMENT = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
] as const;

const ROUTES = [
  "/status",
  "/log",
  "/enabled",
  "/scope",
  "/subscription",
  "/refresh",
  "/test",
  "/select",
  "/kernel",
  "/failover-test",
] as const;

interface FakeRoute {
  method: string;
  path: string;
  handler: (req: never, res: never) => unknown;
}

function fakeContext(): {
  ctx: Record<string, unknown>;
  routes: FakeRoute[];
  dispose: () => void;
} {
  const routes: FakeRoute[] = [];
  const disposers: Array<() => void> = [];
  const ctx = {
    webServer: {
      register(route: FakeRoute) {
        routes.push(route);
        return () => undefined;
      },
    },
    effect(fn: () => unknown) {
      const disposer = fn();
      if (typeof disposer === "function") disposers.push(disposer as () => void);
    },
  };
  return {
    ctx,
    routes,
    dispose() {
      for (const disposer of disposers.reverse()) disposer();
    },
  };
}

interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

async function callRoute(
  route: FakeRoute,
  body?: unknown,
  remoteAddress = "127.0.0.1"
): Promise<{ status: number; headers: Record<string, string>; json: any }> {
  const req = Object.assign(
    Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
    { socket: { remoteAddress } }
  );
  const res: FakeResponse = {
    status: 0,
    headers: {},
    text: "",
    writeHead(status: number, headers: Record<string, string>) {
      this.status = status;
      this.headers = headers;
    },
    end(text: string) {
      this.text = text;
    },
  } as FakeResponse;
  await route.handler(req as never, res as never);
  return {
    status: res.status,
    headers: res.headers,
    json: res.text === "" ? undefined : JSON.parse(res.text),
  };
}

function route(routes: FakeRoute[], method: string, path: string): FakeRoute {
  const found = routes.find((item) => item.method === method && item.path === path);
  if (found === undefined) throw new Error(`route ${method} ${path} not registered`);
  return found;
}

async function startController(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    if (request.url === "/version") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: "test-core", meta: true }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

function resetState(): void {
  const config = {
    enabled: false,
    scope: "codex",
    subscriptionUrl: "",
    mixedPort: 0,
    apiPort: 0,
    apiSecret: "",
    testTargets: ["https://github.com"],
    testTimeoutMs: 4000,
    testConcurrency: 2,
    failoverCooldownMs: 300_000,
    maxFailover: 2,
    autoTestIntervalMs: 1_800_000,
    refreshIntervalMs: 86_400_000,
    bypass: ["localhost", "127.0.0.1", "::1", "[::1]"],
    proxyModelCalls: false,
    pinnedNode: "auto",
    writeMemory: false,
    autoEnabled: false,
    subscriptionSeeded: false,
  };
  netProxy._state.config = config as unknown as typeof netProxy._state.config;
  netProxy._state.kernel = { status: "stopped" } as typeof netProxy._state.kernel;
  netProxy._state.nodes = [];
  netProxy._state.group = undefined;
  netProxy._state.current = undefined;
  netProxy._state.testing = false;
  netProxy._state.lastTestAt = undefined;
  netProxy._state.lastError = undefined;
  netProxy._state.busy = undefined;
  netProxy._state.testAbort = false;
  netProxy._state.routing = { installed: false, via: "none", error: undefined } as unknown as typeof netProxy._state.routing;
}

const originalRuntime = { ...netProxy._runtime };
const savedEnvironment = new Map<string, string | undefined>();
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dsh-codex-net-proxy-"));
  for (const key of [...PROXY_ENVIRONMENT, "DSH_HOME", "APPDATA", "CODEX_HOME"]) {
    savedEnvironment.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.DSH_HOME = home;
  process.env.APPDATA = join(home, "appdata");
  resetState();
  for (const [key, value] of Object.entries(originalRuntime)) {
    netProxy._runtime[key] = value;
  }
});

afterEach(() => {
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnvironment.clear();
  rmSync(home, { recursive: true, force: true });
});

describe("network proxy host API contract", () => {
  it("registers exactly one route prefix and never the standalone one", () => {
    const { ctx, routes, dispose } = fakeContext();
    try {
      netProxy.apply(ctx);
      for (const path of ROUTES) {
        expect(routes.map((item) => item.path)).toContain(`${BASE}${path}`);
      }
      expect(routes.every((item) => item.path.startsWith(BASE))).toBe(true);
      expect(routes.some((item) => item.path.startsWith("/dsh-net-proxy"))).toBe(false);
      expect(BASE).toBe("/plugins/dsh-openai-codex/network-proxy");
      expect(netProxy.NETWORK_PROXY_SCOPE_DEFAULT).toBe("codex");
      expect(netProxy.getNetworkProxyScope()).toBe("codex");
    } finally {
      dispose();
    }
  });

  it("serves a status snapshot without the subscription URL", async () => {
    const { ctx, routes, dispose } = fakeContext();
    try {
      netProxy.apply(ctx);
      const saved = await callRoute(route(routes, "POST", `${BASE}/subscription`), {
        url: "https://subscription.invalid/private",
      });
      expect(saved.status).toBe(200);
      expect(saved.json).toEqual({ ok: true });

      const status = await callRoute(route(routes, "GET", `${BASE}/status`));
      expect(status.status).toBe(200);
      expect(status.json.scope).toBe("codex");
      expect(status.json.enabled).toBe(false);
      expect(status.json).not.toHaveProperty("subscriptionUrl");
      expect(JSON.stringify(status.json)).not.toContain("subscription.invalid");
    } finally {
      dispose();
    }
  });

  it("restricts the settings API to loopback and switches scope through the route", async () => {
    const { ctx, routes, dispose } = fakeContext();
    try {
      netProxy.apply(ctx);
      const status = route(routes, "GET", `${BASE}/status`);
      const denied = await callRoute(status, undefined, "10.1.2.3");
      expect(denied.status).toBe(403);

      const scope = route(routes, "POST", `${BASE}/scope`);
      const switched = await callRoute(scope, { scope: "global" });
      expect(switched.json.scope).toBe("global");
      expect(netProxy.getNetworkProxyScope()).toBe("global");

      const invalid = await callRoute(scope, { scope: "everything" });
      expect(invalid.status).toBe(500);

      await callRoute(scope, { scope: "codex" });
      expect(netProxy.getNetworkProxyScope()).toBe("codex");
    } finally {
      dispose();
    }
  });

  it("does not start a kernel or touch host routing when mounted", () => {
    const dispatcher = getGlobalDispatcher();
    const { ctx, dispose } = fakeContext();
    try {
      netProxy.apply(ctx);
      expect(netProxy._state.kernel.status).toBe("stopped");
      expect(netProxy._state.routing.installed).toBe(false);
      expect(getGlobalDispatcher()).toBe(dispatcher);
      expect(process.env.HTTP_PROXY).toBeUndefined();
    } finally {
      dispose();
    }
  });
});

describe("mihomo controller transport", () => {
  it("reaches the loopback controller through an active hostile global dispatcher and proxy environment", async () => {
    const controller = await startController();
    const previous = getGlobalDispatcher();
    process.env.HTTP_PROXY = "http://127.0.0.1:1";
    process.env.HTTPS_PROXY = "http://127.0.0.1:1";
    process.env.NODE_USE_ENV_PROXY = "1";
    const blocked = {
      dispatch() {
        throw new Error("the global dispatcher must not see loopback controller traffic");
      },
    } as unknown as Dispatcher;
    setGlobalDispatcher(blocked);
    try {
      netProxy._state.config.apiPort = controller.port;
      netProxy._state.config.apiSecret = "controller-secret";

      await expect(netProxy._api("/version")).resolves.toEqual({
        version: "test-core",
        meta: true,
      });
      // The temporary download helper probes the same way.
      await expect(
        netProxy._coreRequest({
          port: controller.port,
          path: "/version",
          secret: "controller-secret",
          timeoutMs: 2_000,
        })
      ).resolves.toEqual({ version: "test-core", meta: true });

      expect(getGlobalDispatcher()).toBe(blocked);
    } finally {
      setGlobalDispatcher(previous);
      await controller.close();
    }
  });

  it("fails cleanly instead of silently succeeding when the controller is absent", async () => {
    const controller = await startController();
    const port = controller.port;
    await controller.close();
    netProxy._state.config.apiPort = port;
    await expect(netProxy._api("/version", { timeoutMs: 500 })).rejects.toThrow(/ECONNREFUSED|core API/);
  });
});

describe("proxy scope", () => {
  it("keeps host routing untouched in codex scope and exposes only the mixed port", async () => {
    const previous = getGlobalDispatcher();
    const envBefore = process.env.HTTP_PROXY;
    netProxy._state.config.enabled = true;
    netProxy._state.config.mixedPort = 12_345;
    netProxy._state.kernel = { status: "running", pid: 5 } as typeof netProxy._state.kernel;

    await expect(netProxy._installScopeRouting()).resolves.toBe(true);
    expect(netProxy._state.routing).toMatchObject({
      installed: true,
      via: "codex-transport",
    });
    expect(getGlobalDispatcher()).toBe(previous);
    expect(process.env.HTTP_PROXY).toBe(envBefore);
    expect(netProxy.networkProxyCodexUrl()).toBe("http://127.0.0.1:12345");
    expect(netProxy.networkProxyOwnsGlobal()).toBe(false);

    netProxy._uninstallScopeRouting();
    expect(netProxy._state.routing).toEqual({
      installed: false,
      via: "none",
      error: undefined,
    });
    expect(netProxy.networkProxyCodexUrl()).toBeUndefined();
  });

  it("takes over the process dispatcher in global scope and restores host values", async () => {
    const previous = getGlobalDispatcher();
    process.env.HTTP_PROXY = "http://host-owned.invalid:8080";
    netProxy._state.config.enabled = true;
    netProxy._state.config.scope = "global";
    netProxy._state.config.mixedPort = 23_456;
    try {
      await expect(netProxy._installScopeRouting()).resolves.toBe(true);
      expect(netProxy._state.routing.via).toBe("global dispatcher + child env");
      expect(getGlobalDispatcher()).not.toBe(previous);
      expect(process.env.HTTP_PROXY).toBe("http://127.0.0.1:23456");
      expect(process.env.NODE_USE_ENV_PROXY).toBe("1");
      expect(netProxy.networkProxyOwnsGlobal()).toBe(true);
      // Whole-DSH scope must cover model traffic, so no deepseek bypass applies.
      expect(netProxy._shouldProxyHost("chat.deepseek.com")).toBe(true);
    } finally {
      netProxy._uninstallScopeRouting();
    }
    expect(getGlobalDispatcher()).toBe(previous);
    expect(process.env.HTTP_PROXY).toBe("http://host-owned.invalid:8080");
    expect(netProxy.networkProxyOwnsGlobal()).toBe(false);
  });

  it("never uninstalls a dispatcher owned by the Codex transport across scope switches", async () => {
    const original = getGlobalDispatcher();
    const manual = {
      dispatch() {
        throw new Error("manual dispatcher must stay installed");
      },
    } as unknown as Dispatcher;
    setGlobalDispatcher(manual);
    netProxy._state.config.enabled = true;
    netProxy._state.config.mixedPort = 34_567;
    netProxy._state.kernel = { status: "running", pid: 6 } as typeof netProxy._state.kernel;
    try {
      // codex scope: no global install, no global uninstall.
      netProxy._state.config.scope = "codex";
      await expect(netProxy._installScopeRouting()).resolves.toBe(true);
      expect(getGlobalDispatcher()).toBe(manual);
      netProxy._uninstallScopeRouting();
      expect(getGlobalDispatcher()).toBe(manual);

      // global scope: captures the manual dispatcher and restores exactly it.
      netProxy._state.config.scope = "global";
      await expect(netProxy._installScopeRouting()).resolves.toBe(true);
      expect(getGlobalDispatcher()).not.toBe(manual);
      netProxy._uninstallScopeRouting();
      expect(getGlobalDispatcher()).toBe(manual);
      expect(netProxy._state.routing.installed).toBe(false);
    } finally {
      setGlobalDispatcher(original);
    }
  });

  it("bypasses model traffic only while scoped to Codex", () => {
    netProxy._state.config.scope = "codex";
    expect(netProxy._shouldProxyHost("api.deepseek.com")).toBe(false);
    expect(netProxy._shouldProxyHost("github.com")).toBe(true);
    expect(netProxy._shouldProxyHost("localhost")).toBe(false);

    netProxy._state.config.scope = "global";
    expect(netProxy._shouldProxyHost("api.deepseek.com")).toBe(true);
  });
});

describe("enable flows", () => {
  it("re-measures nodes after enabling and leaves global state alone", async () => {
    const previous = getGlobalDispatcher();
    const node = {
      name: "node-a",
      type: "Trojan",
      status: "ok",
      delay: 120,
      failCount: 0,
      cooldownUntil: 0,
      cooldownMs: 0,
    };
    netProxy._state.nodes = [node as typeof netProxy._state.nodes[number]];
    netProxy._state.config.mixedPort = 11_111;
    const testAllNodes = vi.fn(async () => ({ alive: 1, total: 1 }));
    netProxy._runtime.api = vi.fn(async () => ({ version: "test-core" }));
    netProxy._runtime.startKernel = vi.fn(async () => {
      netProxy._state.kernel = { status: "running" } as typeof netProxy._state.kernel;
      return netProxy._state.kernel;
    });
    netProxy._runtime.testAllNodes = testAllNodes;
    netProxy._runtime.selectBest = vi.fn(async () => "node-a");

    await expect(netProxy._enableProxy()).resolves.toBe(true);
    await vi.waitFor(() => {
      expect(testAllNodes).toHaveBeenCalledTimes(1);
    });
    expect(netProxy._state.config.enabled).toBe(true);
    expect(netProxy._state.routing).toMatchObject({
      installed: true,
      via: "codex-transport",
    });
    expect(getGlobalDispatcher()).toBe(previous);
    expect(process.env.HTTP_PROXY).toBeUndefined();

    await expect(netProxy._disableProxy()).resolves.toBe(true);
    expect(netProxy._state.config.enabled).toBe(false);
    expect(netProxy._state.routing.installed).toBe(false);
  });

  it("re-tests on demand while the proxy is already enabled", async () => {
    const { ctx, routes, dispose } = fakeContext();
    try {
      netProxy.apply(ctx);
      netProxy._state.config.enabled = true;
      netProxy._state.routing = {
        installed: true,
        via: "codex-transport",
        error: undefined,
      } as unknown as typeof netProxy._state.routing;
      const reTest = vi.fn(async () => ({ alive: 2, total: 3 }));
      netProxy._runtime.testAllNodes = reTest;

      const result = await callRoute(route(routes, "POST", `${BASE}/test`), {});
      expect(reTest).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(200);
      expect(result.json.alive).toBe(2);
      expect(result.json.status.enabled).toBe(true);
      expect(result.json.status.scope).toBe("codex");
    } finally {
      dispose();
    }
  });
});

describe("agent memory instructions", () => {
  it("writes the embedded proxy API, scope contract, and settings entry once", () => {
    netProxy._state.config.writeMemory = true;
    const file = join(home, "AGENTS.md");

    expect(netProxy._writeAgentMemory()).toEqual(["AGENTS.md"]);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("<!-- dsh-codex-network-proxy:begin -->");
    expect(text).toContain("<!-- /dsh-codex-network-proxy -->");
    expect(text).toContain("/plugins/dsh-openai-codex/network-proxy/enabled");
    expect(text).toContain("设置 → 网络代理");
    expect(text).toContain("scope=codex");
    expect(text).toContain("scope=global");
    expect(text).toContain("整个 DSH");
    expect(text).not.toContain("/dsh-net-proxy/");
    expect(text).not.toContain("subscriptionUrl");

    // Second run: write-only-if-absent means no rewrite at all.
    expect(netProxy._writeAgentMemory()).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  it("treats the legacy standalone marker as already taught", () => {
    const file = join(home, "AGENTS.md");
    writeFileSync(file, "# 全局工作偏好\n\n<!-- dsh-net-proxy:begin -->\n旧版说明\n", "utf8");
    netProxy._state.config.writeMemory = true;

    expect(netProxy._writeAgentMemory()).toEqual([]);
    expect(readFileSync(file, "utf8")).toContain("<!-- dsh-net-proxy:begin -->");
    expect(readFileSync(file, "utf8")).not.toContain("dsh-codex-network-proxy");
  });

  it("skips the write when memory was disabled", () => {
    netProxy._state.config.writeMemory = false;
    expect(netProxy._writeAgentMemory()).toEqual([]);
    expect(() => readFileSync(join(home, "AGENTS.md"), "utf8")).toThrow();
  });
});

describe("bundled asset location", () => {
  it("resolves package-root/bin/net-proxy from both source and bundled layouts", () => {
    const root = process.cwd();
    expect(netProxy._paths.binDir()).toBe(join(root, "bin", "net-proxy"));
    expect(netProxy._resolvePackageRoot(join(root, "src", "net-proxy"))).toBe(root);
    expect(netProxy._resolvePackageRoot(join(root, "lib"))).toBe(root);
  });
});
