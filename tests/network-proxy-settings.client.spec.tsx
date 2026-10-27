// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NetworkProxySettings } from "../src/client/NetworkProxySettings.tsx";
import type { NetworkProxyStatus } from "../src/client/NetworkProxySettings.tsx";
import { en } from "../src/client/locales.ts";
import type { OpenAICodexSettingsKey } from "../src/client/locales.ts";

function t(
  key: OpenAICodexSettingsKey,
  params: Record<string, unknown> = {}
): string {
  const text = en[key];
  return Object.entries(params).reduce(
    (value, [name, replacement]) =>
      value.replaceAll(`{${name}}`, String(replacement)),
    text
  );
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const baseStatus: NetworkProxyStatus = {
  enabled: false,
  scope: "codex",
  kernel: { status: "stopped" },
  routing: { installed: false },
  testing: false,
  proxyUrl: "http://127.0.0.1:7890",
  pinnedNode: "auto",
  nodes: [
    { name: "Node A", delay: 120, status: "ok" },
    { name: "Node B", delay: 240, status: "ok" },
  ],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("network proxy settings", () => {
  it("loads the status snapshot and never renders a stored subscription URL", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => json({
      ...baseStatus,
      current: "Node A",
      subscriptionUrl: "https://secret.example/subscription",
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<NetworkProxySettings t={t} />);

    expect(await screen.findByText("Core not running")).toBeTruthy();
    expect(screen.getAllByText("Node A").length).toBeGreaterThan(0);
    expect(screen.getByText("http://127.0.0.1:7890")).toBeTruthy();
    expect(screen.queryByText("https://secret.example/subscription")).toBeNull();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/plugins/dsh-openai-codex/network-proxy/status"
    );
  });

  it("enables and disables the proxy through the master switch", async () => {
    let status = { ...baseStatus };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/status")) return json(status);
      if (path.endsWith("/enabled")) {
        const body = JSON.parse(String(init?.body)) as { enabled: boolean };
        status = { ...status, enabled: body.enabled };
        return json(status);
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<NetworkProxySettings t={t} />);

    fireEvent.click(await screen.findByRole("button", { name: "Enable proxy" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input]) =>
        String(input).endsWith("/enabled")
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ enabled: true });
    });
    expect(await screen.findByRole("button", { name: "Disable proxy" })).toBeTruthy();
  });

  it("defaults to the Codex-only scope and switches to the whole dsh", async () => {
    let status = { ...baseStatus };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/status")) return json(status);
      if (path.endsWith("/scope")) {
        const body = JSON.parse(String(init?.body)) as { scope: "codex" | "global" };
        status = { ...status, scope: body.scope };
        return json(status);
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<NetworkProxySettings t={t} />);

    const codex = await screen.findByRole("button", { name: "Codex only" });
    expect(codex.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/Only Codex traffic uses the proxy/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Whole dsh" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input]) =>
        String(input).endsWith("/scope")
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ scope: "global" });
    });
    expect(
      (await screen.findByRole("button", { name: "Whole dsh" })).getAttribute(
        "aria-pressed"
      )
    ).toBe("true");
  });

  it("saves the subscription then refreshes the node list without echoing the URL", async () => {
    let status: NetworkProxyStatus = { ...baseStatus, nodes: [] };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/status")) return json(status);
      if (path.endsWith("/subscription")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          url: "https://sub.example/clash",
        });
        return json({ ok: true });
      }
      if (path.endsWith("/refresh")) {
        status = { ...status, nodes: baseStatus.nodes };
        return json({ nodes: 2, source: "remote", status });
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<NetworkProxySettings t={t} />);

    fireEvent.change(await screen.findByLabelText("Subscription link"), {
      target: { value: "https://sub.example/clash" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update subscription" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).endsWith("/refresh"))
      ).toBe(true);
    });
    expect(await screen.findByText("Node A")).toBeTruthy();
    expect(screen.queryByDisplayValue("https://sub.example/clash")).toBeTruthy();
  });

  it("re-tests nodes and pins or un-pins a node", async () => {
    let status = {
      ...baseStatus,
      enabled: true,
      pinnedNode: "Node A",
      current: "Node A",
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/status")) return json(status);
      if (path.endsWith("/test")) {
        status = { ...status, testing: false };
        return json({ tested: 2, status });
      }
      if (path.endsWith("/select")) {
        const body = JSON.parse(String(init?.body)) as { node: string };
        status = {
          ...status,
          pinnedNode: body.node,
          current: body.node === "auto" ? "Node B" : body.node,
        };
        return json(status);
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<NetworkProxySettings t={t} />);

    fireEvent.click(await screen.findByRole("button", { name: "Re-test nodes" }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).endsWith("/test"))
      ).toBe(true);
    });

    fireEvent.click(await screen.findByText("Node B"));
    await waitFor(() => {
      const selectCalls = fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/select")
      );
      expect(selectCalls.length).toBeGreaterThan(0);
      expect(JSON.parse(String(selectCalls[0]?.[1]?.body))).toEqual({
        node: "Node B",
      });
    });

    fireEvent.click(await screen.findByRole("button", { name: "Fastest (automatic)" }));
    await waitFor(() => {
      const selectCalls = fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/select")
      );
      expect(JSON.parse(String(selectCalls.at(-1)?.[1]?.body))).toEqual({
        node: "auto",
      });
    });
  });

  it("surfaces a background status error and a failed action", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.endsWith("/status")) {
        return json({ ...baseStatus, lastError: "内核启动失败：端口被占用" });
      }
      if (path.endsWith("/test")) {
        return new Response(JSON.stringify({ error: "内核未运行" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<NetworkProxySettings t={t} />);

    expect(await screen.findByText("内核启动失败：端口被占用")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Re-test nodes" }));
    expect(await screen.findByText("内核未运行")).toBeTruthy();
  });
});
