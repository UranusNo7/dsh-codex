/**
 * Codex-only compatibility for redundant sandbox escalation arguments.
 *
 * Codex/GPT transports send `sandbox_permissions` and `justification` with
 * native DSH tool calls. When the requested target cannot widen the caller's
 * resolved policy those fields are redundant: the native escalation validation
 * would reject the call instead of letting its original work proceed. This
 * module removes them only under that fail-closed contract and leaves every
 * widening, unknown, or unresolvable request untouched.
 *
 * Adapted from dsh-gpt-compat (MIT, Copyright (c) 2026 dsh-gpt-compat
 * contributors). See docs/third-party-notices.md.
 * @module dsh-codex/tool-compat
 */

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-sandbox-policy";
import type { ToolDefinition, ToolExecution } from "@deepseek-ai/dsh-tools";
import { OPENAI_CODEX_PROVIDER } from "./store.ts";

/** Native tool names whose schema may advertise the escalation contract. */
export const TOOL_COMPAT_TOOL_NAMES = ["bash", "pwsh", "write", "edit"] as const;

const SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;

type SandboxMode = (typeof SANDBOX_MODES)[number];

const ESCALATION_TARGETS = ["workspace-write", "danger-full-access"] as const;

type EscalationTarget = (typeof ESCALATION_TARGETS)[number];

const MODE_RANK: Readonly<Record<SandboxMode, number>> = {
  "read-only": 0,
  "workspace-write": 1,
  "danger-full-access": 2,
};

function isSandboxMode(value: unknown): value is SandboxMode {
  return (
    typeof value === "string" &&
    (SANDBOX_MODES as readonly string[]).includes(value)
  );
}

function isEscalationTarget(value: unknown): value is EscalationTarget {
  return (
    typeof value === "string" &&
    (ESCALATION_TARGETS as readonly string[]).includes(value)
  );
}

function isStrictlyWider(
  requested: EscalationTarget,
  current: SandboxMode
): boolean {
  return MODE_RANK[requested] > MODE_RANK[current];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** True when the registered schema explicitly advertises the escalation pair. */
function advertisesEscalation(definition: ToolDefinition | undefined): boolean {
  const parameters = asRecord(definition?.parameters);
  const properties = asRecord(parameters?.properties);
  const mode = asRecord(properties?.sandbox_permissions);
  const justification = asRecord(properties?.justification);
  const targets = mode?.enum;
  return (
    mode?.type === "string" &&
    Array.isArray(targets) &&
    ESCALATION_TARGETS.every((target) => targets.includes(target)) &&
    justification?.type === "string"
  );
}

/** Session-routed provider first; the agent's configured route only as fallback. */
function currentProvider(exec: ToolExecution): string | undefined {
  const agent = exec.agent;
  if (agent === undefined || agent.session === undefined) return undefined;
  try {
    const routed = agent.session.requestHeader()?.config.provider;
    return routed ?? agent.options.provider;
  } catch {
    return undefined;
  }
}

/**
 * Return a new frozen argument object with the escalation pair removed when the
 * request is a known non-widening target; otherwise return undefined.
 */
export function stripRedundantEscalation(
  args: Record<string, unknown>,
  currentMode: unknown
): Readonly<Record<string, unknown>> | undefined {
  if (args.sandbox_permissions === undefined && args.justification === undefined) {
    return undefined;
  }
  if (!isSandboxMode(currentMode)) return undefined;
  const requested = args.sandbox_permissions;
  if (!isEscalationTarget(requested)) return undefined;
  if (isStrictlyWider(requested, currentMode)) return undefined;
  return Object.freeze(
    Object.fromEntries(
      Object.entries(args).filter(
        ([key]) => key !== "sandbox_permissions" && key !== "justification"
      )
    )
  );
}

/**
 * Mount the guard where native tools, the sandbox policy, and their lifecycle
 * are all present. Removing the mounting fiber removes the listener.
 */
export function installOpenAICodexToolCompat(ctx: Context): void {
  let warnedPolicyFailure = false;
  ctx.on("tools/pre-execute", (exec, next) => {
    if (!(TOOL_COMPAT_TOOL_NAMES as readonly string[]).includes(exec.name)) {
      return next();
    }
    const args = asRecord(exec.arguments);
    if (args === undefined) return next();
    if (
      args.sandbox_permissions === undefined &&
      args.justification === undefined
    ) {
      return next();
    }
    if (currentProvider(exec) !== OPENAI_CODEX_PROVIDER) return next();
    if (!advertisesEscalation(ctx.tools.get(exec.name, exec.agent))) {
      return next();
    }
    const session = exec.agent?.session;
    if (session === undefined) return next();

    let currentMode: unknown;
    try {
      currentMode = ctx.sandboxPolicy.resolve({ session }).mode;
    } catch (error: unknown) {
      if (!warnedPolicyFailure) {
        warnedPolicyFailure = true;
        ctx.logger.warn(
          "dsh-codex: sandbox policy resolution failed; preserving escalation arguments",
          error
        );
      }
      return next();
    }

    const stripped = stripRedundantEscalation(args, currentMode);
    if (stripped !== undefined) {
      (
        exec as ToolExecution & {
          arguments: Readonly<Record<string, unknown>>;
        }
      ).arguments = stripped;
    }
    return next();
  });
}
