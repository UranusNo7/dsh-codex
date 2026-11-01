import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

const netProxyMock = vi.hoisted(() => ({
  networkProxyToolStatus: vi.fn(),
  enableNetworkProxyForTool: vi.fn(),
  testNetworkProxyForTool: vi.fn(),
  selectNetworkProxyNodeForTool: vi.fn(),
}));

vi.mock("../src/net-proxy/index.js", () => netProxyMock);

import { localNetworkProxyTool, LOCAL_NETWORK_PROXY_TOOL_NAME } from "../src/local-network-proxy-tool.ts";

const status = {
  enabled: true,
  scope: "codex" as const,
  ready: true,
  proxyUrl: "http://127.0.0.1:23456",
  mixedPort: 23456,
  kernelStatus: "running",
  routing: { installed: true, via: "codex-transport" },
  fixedNode: "node-a",
  fixedNodeAvailable: true,
  current: "node-a",
  group: "GLOBAL",
  alive: 2,
  total: 3,
  testing: false,
  lastTestAt: 1_700_000_000_000,
  nodes: [
    { name: "node-a", status: "ok", delay: 40 },
    { name: "node-b", status: "ok", delay: 90 },
  ],
};

function tool(): ToolDefinition {
  return localNetworkProxyTool();
}

function execute(args: Record<string, unknown>): Promise<unknown> {
  return tool().execute(args, {} as never) as Promise<unknown>;
}

describe("local_network_proxy tool", () => {
  it("is registered under a single stable name with proxy usage guidance", () => {
    const definition = tool();
    expect(definition.name).toBe(LOCAL_NETWORK_PROXY_TOOL_NAME);
    expect(definition.name).toBe("local_network_proxy");
    const description = definition.description;
    expect(description).toContain("--proxy");
    expect(description).toContain("HTTPS_PROXY");
    expect(description).toContain("127.0.0.1");
    expect(description).toContain("Remote SSH");
    expect(description).toContain("web_fetch");
    expect(description).toContain("different healthy node");
    expect(description).toContain("Codex");
    expect(description).toContain("global");
  });

  it("only exposes action/node/auto_select and never a targets parameter", () => {
    const parameters = tool().parameters as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(parameters.properties).sort()).toEqual([
      "action",
      "auto_select",
      "node",
    ]);
    expect(parameters.properties["targets"]).toBeUndefined();
    expect(parameters.properties["action"]).toMatchObject({
      type: "string",
      enum: ["status", "enable", "test", "select"],
    });
    expect(parameters.required).toEqual(["action"]);
    expect(tool().isConcurrencySafe?.({ action: "status" } as never)).toBe(true);
    expect(tool().isConcurrencySafe?.({ action: "test" } as never)).toBe(false);
  });

  it("reports status without starting anything", async () => {
    netProxyMock.networkProxyToolStatus.mockReturnValue(status);

    const value = await execute({ action: "status" });

    expect(value).toMatchObject({
      action: "status",
      ok: true,
      status: { ready: true, proxyUrl: "http://127.0.0.1:23456" },
    });
    expect(netProxyMock.enableNetworkProxyForTool).not.toHaveBeenCalled();
    expect(netProxyMock.testNetworkProxyForTool).not.toHaveBeenCalled();
    expect(netProxyMock.selectNetworkProxyNodeForTool).not.toHaveBeenCalled();
  });

  it("enables on request and forwards the real readiness result", async () => {
    netProxyMock.enableNetworkProxyForTool.mockResolvedValue({
      started: true,
      status,
    });

    const value = await execute({ action: "enable" });

    expect(netProxyMock.enableNetworkProxyForTool).toHaveBeenCalledTimes(1);
    expect(value).toMatchObject({
      action: "enable",
      ok: true,
      started: true,
    });
  });

  it("passes auto_select through to the measurement", async () => {
    netProxyMock.testNetworkProxyForTool.mockResolvedValue({
      measured: { alive: 2, total: 3, aborted: false },
      selected: "node-b",
      autoSelected: true,
      status,
    });

    const value = await execute({ action: "test", auto_select: true });

    expect(netProxyMock.testNetworkProxyForTool).toHaveBeenCalledWith({
      autoSelect: true,
    });
    expect(value).toMatchObject({
      action: "test",
      measured: { alive: 2, total: 3, aborted: false },
      selected: "node-b",
      autoSelected: true,
    });
  });

  it("forwards an explicit node selection and its fixed-node result", async () => {
    netProxyMock.selectNetworkProxyNodeForTool.mockResolvedValue({
      selected: "node-b",
      fixedNode: "node-b",
      status,
    });

    const value = await execute({ action: "select", node: "node-b" });

    expect(netProxyMock.selectNetworkProxyNodeForTool).toHaveBeenCalledWith(
      "node-b"
    );
    expect(value).toMatchObject({
      action: "select",
      selected: "node-b",
      fixedNode: "node-b",
    });
  });

  it("projects the status onto the public shape, dropping private fields", async () => {
    netProxyMock.networkProxyToolStatus.mockReturnValue({
      ...status,
      subscriptionUrl: "https://secret-sub.example/list",
      lastError: "secret-last-error",
      kernel: { log: "secret-log", path: "C:\\secret" },
      nodes: [{ name: "node-a", status: "ok", delay: 40, error: "secret-node" }],
    });

    const value = await execute({ action: "status" });
    const text = JSON.stringify(value);

    expect(text).not.toContain("secret");
    expect(text).not.toContain("subscriptionUrl");
    expect((value as { status: { nodes: unknown[] } }).status.nodes).toEqual([
      { name: "node-a", status: "ok", delay: 40 },
    ]);
  });

  it("propagates the manager's safe error without leaking extra data", async () => {
    netProxyMock.selectNetworkProxyNodeForTool.mockRejectedValue(
      new Error("未知节点「x」：请先调用 action=\"test\" 获取当前节点列表。")
    );

    await expect(execute({ action: "select", node: "x" })).rejects.toThrow(
      /未知节点/u
    );
  });

  it("renders the canonical value as JSON text", async () => {
    netProxyMock.networkProxyToolStatus.mockReturnValue(status);
    const value = await execute({ action: "status" });
    const blocks = tool().output.render({ action: "status" } as never, value as never);
    expect(blocks[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(blocks[0])).toContain('\\"action\\": \\"status\\"');
  });
});
