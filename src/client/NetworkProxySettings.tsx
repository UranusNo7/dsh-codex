/** Browser half: outbound-proxy node management inside dsh Settings. */

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { OpenAICodexSettingsKey } from "./locales.ts";

const BASE_PATH = "/plugins/dsh-openai-codex/network-proxy";
const POLL_INTERVAL_MS = 2_500;

type NetworkProxyScope = "codex" | "global";
type NetworkProxyKernelStatus =
  | "stopped"
  | "starting"
  | "running"
  | "missing"
  | "failed"
  | (string & {});
type NetworkProxyNodeStatus = "ok" | "dead" | "cooldown" | (string & {});

export interface NetworkProxyNode {
  name: string;
  type?: string;
  delay?: number;
  status?: NetworkProxyNodeStatus;
  error?: string;
  cooldownMs?: number;
  failCount?: number;
}

/** Snapshot from GET /status. It deliberately never carries the subscription URL. */
export interface NetworkProxyStatus {
  enabled: boolean;
  scope: NetworkProxyScope;
  kernel: {
    status?: NetworkProxyKernelStatus;
    pid?: number;
    error?: string;
    path?: string;
    log?: string;
  };
  routing: { installed: boolean; via?: string; error?: string };
  group?: string;
  current?: string;
  testing?: boolean;
  busy?: string;
  lastError?: string;
  lastTestAt?: number;
  proxyUrl?: string;
  mixedPort?: number;
  testTargets?: string[];
  pinnedNode?: string;
  nodes: NetworkProxyNode[];
}

/** Dependencies injected by the browser plugin entry. */
export interface NetworkProxySettingsInjected {
  /** Localized page copy. */
  t: (key: OpenAICodexSettingsKey, params?: Record<string, unknown>) => string;
}

/** Props delivered by the settings slot renderer. */
export type NetworkProxySettingsProps = Partial<NetworkProxySettingsInjected>;

const pageStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 18,
  maxWidth: 720,
};
const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 20,
  lineHeight: "28px",
  fontWeight: 600,
  color: "var(--dsw-alias-label-primary)",
};
const bodyStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: "22px",
  color: "var(--dsw-alias-label-secondary)",
};
const mutedStyle: CSSProperties = {
  ...bodyStyle,
  fontSize: 12,
  lineHeight: "18px",
};
const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: "16px 18px",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 12,
  background: "var(--dsw-alias-bg-module-platform)",
};
const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 12,
};
const buttonStyle: CSSProperties = {
  boxSizing: "border-box",
  minHeight: 34,
  padding: "6px 14px",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "var(--dsw-alias-border-l2)",
  borderRadius: 18,
  background: "var(--dsw-alias-bg-layer-1)",
  color: "var(--dsw-alias-label-primary)",
  font: "inherit",
  fontSize: 14,
  cursor: "pointer",
};
const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: "var(--dsw-alias-button-primary-fill)",
  background: "var(--dsw-alias-button-primary-fill)",
  color: "var(--dsw-alias-label-primary-foreground)",
};
const inputStyle: CSSProperties = {
  boxSizing: "border-box",
  flex: "1 1 280px",
  minHeight: 34,
  padding: "6px 10px",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 8,
  background: "var(--dsw-alias-bg-layer-1)",
  color: "var(--dsw-alias-label-primary)",
  font: "inherit",
  fontSize: 13,
};
const errorStyle: CSSProperties = {
  ...bodyStyle,
  color: "var(--dsw-alias-state-error-primary)",
};
const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};
const cellStyle: CSSProperties = {
  padding: "6px 8px",
  borderBottom: "1px solid var(--dsw-alias-border-l2)",
  textAlign: "left",
};
const numericCellStyle: CSSProperties = {
  ...cellStyle,
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
};
const ACTIVE_ROW_STYLE: CSSProperties = {
  fontWeight: 600,
  background: "var(--dsw-alias-bg-layer-1)",
};
const CLICKABLE_ROW_STYLE: CSSProperties = { cursor: "pointer" };

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text };
  }
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const message = (value as { error?: unknown }).error;
  return typeof message === "string" && message !== "" ? message : undefined;
}

export function NetworkProxySettings({ t }: NetworkProxySettingsProps) {
  if (t === undefined)
    throw new Error("Network proxy settings requires its translation function");
  const [status, setStatus] = useState<NetworkProxyStatus | undefined>();
  const [subscriptionDraft, setSubscriptionDraft] = useState("");
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${BASE_PATH}/status`, { cache: "no-store" });
      const value = await readJson(response);
      if (!response.ok) throw new Error(errorMessage(value) ?? `HTTP ${response.status}`);
      setStatus(value as NetworkProxyStatus);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message !== ""
          ? cause.message
          : t("networkProxyLoadFailed")
      );
    }
  }, [t]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const post = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      const response = await fetch(`${BASE_PATH}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = await readJson(response);
      if (!response.ok) throw new Error(errorMessage(value) ?? `HTTP ${response.status}`);
      return value;
    },
    []
  );

  const run = useCallback(
    async (label: string, action: () => Promise<void>) => {
      setBusy(label);
      setError(undefined);
      try {
        await action();
      } catch (cause) {
        setError(
          cause instanceof Error && cause.message !== ""
            ? cause.message
            : t("networkProxyActionFailed")
        );
      } finally {
        setBusy(undefined);
        void load();
      }
    },
    [load, t]
  );

  const nodes = status?.nodes ?? [];
  const kernelStatus = status?.kernel.status;
  const kernelRunning = kernelStatus === "running";
  const kernelStarting = kernelStatus === "starting" || status?.busy === "enable";
  const kernelLabel =
    kernelStatus === "running"
      ? t("networkProxyKernelRunning")
      : kernelStatus === "starting"
        ? t("networkProxyKernelStarting")
        : kernelStatus === "missing"
          ? t("networkProxyKernelMissing")
          : kernelStatus === "failed"
            ? t("networkProxyKernelFailed")
            : t("networkProxyKernelStopped");
  const scope: NetworkProxyScope = status?.scope === "global" ? "global" : "codex";
  const switchLabel = status?.enabled
    ? busy === "disable"
      ? t("networkProxyDisabling")
      : t("networkProxyDisable")
    : busy === "enable" || kernelStarting
      ? t("networkProxyEnabling")
      : t("networkProxyEnable");
  const alive = nodes.filter((node) => node.status === "ok").length;
  const pinned = status?.pinnedNode !== undefined && status.pinnedNode !== "auto";
  const displayedError = error ?? status?.lastError;

  const nodeStatusLabel = (node: NetworkProxyNode): string => {
    if (node.name === status?.current) return t("networkProxyInUse");
    if (node.status === "ok") return t("networkProxyNodeOk");
    if (node.status === "dead") return t("networkProxyNodeDead");
    if (node.status === "cooldown") return t("networkProxyNodeCooldown");
    return t("networkProxyNodeIdle");
  };

  return (
    <section style={pageStyle} aria-labelledby="network-proxy-settings-title">
      <div>
        <h2 id="network-proxy-settings-title" style={titleStyle}>
          {t("networkProxyTitle")}
        </h2>
        <p style={bodyStyle}>{t("networkProxySubtitle")}</p>
      </div>

      <div style={cardStyle}>
        <div style={rowStyle}>
          <span style={bodyStyle}>
            <span
              aria-hidden="true"
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                marginRight: 8,
                borderRadius: "50%",
                background: kernelRunning
                  ? "var(--dsw-alias-state-success-primary)"
                  : kernelStarting
                    ? "var(--dsw-alias-state-warning-primary)"
                    : "var(--dsw-alias-state-error-primary)",
              }}
            />
            {kernelLabel}
          </span>
          <button
            type="button"
            style={status?.enabled ? buttonStyle : primaryButtonStyle}
            disabled={busy !== undefined}
            onClick={() =>
              void run("enabled", async () => {
                await post("/enabled", { enabled: status?.enabled !== true });
              })
            }
          >
            {switchLabel}
          </button>
        </div>

        <div style={rowStyle}>
          <span style={bodyStyle}>{t("networkProxyScope")}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              style={scope === "codex" ? primaryButtonStyle : buttonStyle}
              aria-pressed={scope === "codex"}
              disabled={busy !== undefined}
              onClick={() =>
                void run("scope", async () => {
                  await post("/scope", { scope: "codex" });
                })
              }
            >
              {t("networkProxyScopeCodex")}
            </button>
            <button
              type="button"
              style={scope === "global" ? primaryButtonStyle : buttonStyle}
              aria-pressed={scope === "global"}
              disabled={busy !== undefined}
              onClick={() =>
                void run("scope", async () => {
                  await post("/scope", { scope: "global" });
                })
              }
            >
              {t("networkProxyScopeGlobal")}
            </button>
          </div>
        </div>
        <p style={mutedStyle}>
          {scope === "global"
            ? t("networkProxyScopeGlobalHint")
            : t("networkProxyScopeCodexHint")}
        </p>

        <div style={rowStyle}>
          <span style={bodyStyle}>{t("networkProxyRouting")}</span>
          <span style={bodyStyle}>
            {status?.routing.installed
              ? t("networkProxyRoutingOn")
              : t("networkProxyRoutingOff")}
          </span>
        </div>
        {status?.proxyUrl !== undefined && (
          <div>
            <p style={mutedStyle}>{t("networkProxyProxyUrl")}</p>
            <code style={bodyStyle}>{status.proxyUrl}</code>
            <p style={mutedStyle}>{t("networkProxyProxyUrlHint")}</p>
          </div>
        )}
      </div>

      <div style={cardStyle}>
        <div>
          <p style={bodyStyle}>{t("networkProxySubscription")}</p>
          <p style={mutedStyle}>{t("networkProxySubscriptionHint")}</p>
        </div>
        <div style={rowStyle}>
          <input
            type="text"
            style={inputStyle}
            value={subscriptionDraft}
            placeholder={t("networkProxySubscriptionPlaceholder")}
            aria-label={t("networkProxySubscription")}
            onChange={(event) => setSubscriptionDraft(event.target.value)}
          />
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={busy !== undefined || subscriptionDraft.trim() === ""}
            onClick={() =>
              void run("subscription", async () => {
                await post("/subscription", { url: subscriptionDraft.trim() });
                await post("/refresh", {});
              })
            }
          >
            {busy === "subscription"
              ? t("networkProxySavingSubscription")
              : t("networkProxySaveSubscription")}
          </button>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={rowStyle}>
          <span style={bodyStyle}>
            {t("networkProxyNodes")} ({nodes.length})
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              style={buttonStyle}
              disabled={busy !== undefined || nodes.length === 0}
              onClick={() =>
                void run("test", async () => {
                  await post("/test", {});
                })
              }
            >
              {status?.testing || busy === "test"
                ? t("networkProxyTesting")
                : t("networkProxyTest")}
            </button>
            {pinned && (
              <button
                type="button"
                style={buttonStyle}
                disabled={busy !== undefined}
                onClick={() =>
                  void run("select", async () => {
                    await post("/select", { node: "auto" });
                  })
                }
              >
                {t("networkProxyAuto")}
              </button>
            )}
          </div>
        </div>
        <div style={rowStyle}>
          <span style={mutedStyle}>{t("networkProxyCurrent")}</span>
          <span style={bodyStyle}>{status?.current ?? "—"}</span>
        </div>
        <p style={mutedStyle}>
          {pinned ? t("networkProxyPinned") : t("networkProxyAuto")}
          {" · "}
          {alive}/{nodes.length} {t("networkProxyNodeOk")}
        </p>
        {nodes.length === 0 ? (
          <p style={mutedStyle}>{t("networkProxyNoNodes")}</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={cellStyle}>{t("networkProxyColNode")}</th>
                <th style={numericCellStyle}>{t("networkProxyColDelay")}</th>
                <th style={cellStyle}>{t("networkProxyColStatus")}</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node) => {
                const active = node.name === status?.current;
                return (
                  <tr
                    key={node.name}
                    style={active ? { ...CLICKABLE_ROW_STYLE, ...ACTIVE_ROW_STYLE } : CLICKABLE_ROW_STYLE}
                    onClick={() =>
                      void run("select", async () => {
                        await post("/select", { node: node.name });
                      })
                    }
                  >
                    <td style={cellStyle} title={node.error ?? node.name}>
                      {node.name}
                    </td>
                    <td style={numericCellStyle}>
                      {node.delay === undefined ? "—" : `${node.delay} ms`}
                    </td>
                    <td style={cellStyle}>{nodeStatusLabel(node)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p style={mutedStyle}>{t("networkProxyManualHint")}</p>
      </div>

      {displayedError !== undefined && (
        <p style={errorStyle} role="alert">
          {displayedError}
        </p>
      )}
    </section>
  );
}
