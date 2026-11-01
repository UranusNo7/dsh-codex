/** AI-callable control surface for the bundle's built-in local (mihomo) proxy. */

import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
  enableNetworkProxyForTool,
  networkProxyToolStatus,
  selectNetworkProxyNodeForTool,
  testNetworkProxyForTool,
} from "./net-proxy/index.js";
import type { NetworkProxyToolStatus } from "./net-proxy/index.js";

/** Project the manager status onto the canonical output shape (omitting absent optional fields). */
function statusValue(status: NetworkProxyToolStatus) {
  return {
    enabled: status.enabled,
    scope: status.scope,
    ready: status.ready,
    kernelStatus: status.kernelStatus,
    routing: { installed: status.routing.installed, via: status.routing.via },
    fixedNode: status.fixedNode,
    fixedNodeAvailable: status.fixedNodeAvailable,
    alive: status.alive,
    total: status.total,
    testing: status.testing,
    nodes: status.nodes.map((node) => ({
      name: node.name,
      status: node.status,
      ...(node.delay === undefined ? {} : { delay: node.delay }),
    })),
    ...(status.proxyUrl === undefined ? {} : { proxyUrl: status.proxyUrl }),
    ...(status.mixedPort === undefined ? {} : { mixedPort: status.mixedPort }),
    ...(status.current === undefined ? {} : { current: status.current }),
    ...(status.group === undefined ? {} : { group: status.group }),
    ...(status.lastTestAt === undefined ? {} : { lastTestAt: status.lastTestAt }),
    ...(status.busy === undefined ? {} : { busy: status.busy }),
  };
}

/** Tool name exposed to the model. */
export const LOCAL_NETWORK_PROXY_TOOL_NAME = "local_network_proxy";

const DESCRIPTION = [
  "Manage the bundled local mihomo proxy that dsh-codex uses for Codex traffic, so local shell commands can reach a blocked network.",
  "Actions: status (read-only; no kernel start and no measurement), enable (start for the Codex-only scope and wait until the kernel is really running), test (measure the proxy's configured targets, then keep or auto-clear the fixed node), select (pin one already-listed node, or \"auto\").",
  "When a node stops working: call status first, then test if you need fresh results, and explicitly select a different healthy node from the returned nodes (status \"ok\"), not the failing current one. Do not rely on test alone: the proxy's GitHub latency targets can still rank a network-failed node first, and automatic selection is only used when the fixed node is \"auto\". Selecting a node pins it; only select \"auto\" (or test with auto_select=true) to clear the pin and return to automatic selection.",
  "The returned proxyUrl is a loopback HTTP proxy (http://127.0.0.1:<port>) on the machine that runs dsh. Use it explicitly, for example: `curl --proxy http://127.0.0.1:<port> https://github.com`, `git -c http.proxy=http://127.0.0.1:<port> clone ...`, or once per command `HTTPS_PROXY=http://127.0.0.1:<port> HTTP_PROXY=http://127.0.0.1:<port> npm install`. On a Remote SSH session, 127.0.0.1 refers to the remote host, not to this dsh machine: do not claim or use this address there unless the remote host itself exposes the same proxy. web_fetch is not guaranteed to support an explicit proxy, so do not promise it will.",
  "The tool never enables or takes over the whole-DSH (global) scope: with scope=codex it only affects Codex traffic. If status reports scope=global and the proxy is already running, the tool reuses it without changing the scope; if scope=global and the proxy is off, enable is refused so the tool never takes over global networking.",
  "Readiness is reported truthfully: enable returns only after the kernel is running and has a proxy port, and failures return an actionable message instead of claiming a background start succeeded. The tool never replays model or business requests; subscription links, credentials, raw logs, and node error text are never returned.",
].join(" ");

/**
 * Build the AI tool definition. It only calls the existing net-proxy manager
 * functions; no kernel, routing, or protocol logic lives here.
 */
export function localNetworkProxyTool(): ToolDefinition {
  return defineTool({
    name: LOCAL_NETWORK_PROXY_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      action: {
        type: "string",
        required: true,
        enum: ["status", "enable", "test", "select"],
        description:
          'What to do: "status" reads the current state; "enable" starts the bundled proxy for Codex traffic and waits for real readiness; "test" measures the configured targets and reports the usable nodes; "select" pins one node or returns to automatic selection.',
      },
      node: {
        type: "string",
        description:
          'Required for action="select": an exact node name from the last status/test result, or "auto" to clear the fixed node and use automatic selection.',
      },
      auto_select: {
        type: "boolean",
        description:
          'Only for action="test": when true, explicitly clear the fixed node before measuring so the fastest node is selected automatically. Ordinary tests keep the current fixed node.',
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", required: true },
          ok: { type: "boolean", required: true },
          started: { type: "boolean" },
          selected: { type: "string" },
          autoSelected: { type: "boolean" },
          fixedNode: { type: "string" },
          measured: {
            type: "object",
            additionalProperties: false,
            properties: {
              alive: { type: "integer", required: true },
              total: { type: "integer", required: true },
              aborted: { type: "boolean", required: true },
            },
          },
          status: {
            type: "object",
            required: true,
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean", required: true },
              scope: { type: "string", required: true, enum: ["codex", "global"] },
              ready: { type: "boolean", required: true },
              proxyUrl: { type: "string" },
              mixedPort: { type: "integer" },
              kernelStatus: { type: "string", required: true },
              routing: {
                type: "object",
                required: true,
                additionalProperties: false,
                properties: {
                  installed: { type: "boolean", required: true },
                  via: { type: "string", required: true },
                },
              },
              fixedNode: { type: "string", required: true },
              fixedNodeAvailable: { type: "boolean", required: true },
              current: { type: "string" },
              group: { type: "string" },
              alive: { type: "integer", required: true },
              total: { type: "integer", required: true },
              testing: { type: "boolean", required: true },
              lastTestAt: { type: "integer" },
              busy: { type: "string" },
              nodes: {
                type: "array",
                required: true,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    name: { type: "string", required: true },
                    status: { type: "string", required: true },
                    delay: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: "text", text: JSON.stringify(value, null, 2) },
      ],
    },
    isConcurrencySafe: (args) => args.action === "status",
    async execute(args) {
      switch (args.action) {
        case "status":
          return { action: "status", ok: true, status: statusValue(networkProxyToolStatus()) };
        case "enable": {
          const result = await enableNetworkProxyForTool();
          return {
            action: "enable",
            ok: true,
            started: result.started,
            status: statusValue(result.status),
          };
        }
        case "test": {
          const result = await testNetworkProxyForTool({
            autoSelect: args.auto_select === true,
          });
          return {
            action: "test",
            ok: true,
            status: statusValue(result.status),
            measured: result.measured,
            autoSelected: result.autoSelected,
            ...(result.selected === undefined ? {} : { selected: result.selected }),
          };
        }
        case "select": {
          const result = await selectNetworkProxyNodeForTool(args.node ?? "");
          return {
            action: "select",
            ok: true,
            status: statusValue(result.status),
            fixedNode: result.fixedNode,
            ...(result.selected === undefined ? {} : { selected: result.selected }),
          };
        }
      }
    },
  });
}
