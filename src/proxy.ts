/** Explicit proxy modes for OpenAI Codex HTTP traffic. */

import {
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  ProxyAgent,
} from "undici";
import type { Dispatcher } from "undici";
import { installProxyFromEnvironment } from "@deepseek-ai/dsh-http-proxy";

export type OpenAICodexProxyMode = "off" | "scoped" | "global";

export interface ProxyPreferences {
  /** Whether this plugin leaves networking alone, proxies Codex only, or proxies the process. */
  proxyMode: OpenAICodexProxyMode;
  /** Explicit HTTP(S) proxy URL; empty uses standard proxy environment variables. */
  proxyUrl: string;
}

export const DEFAULT_PROXY_PREFERENCES: ProxyPreferences = {
  proxyMode: "off",
  proxyUrl: "",
};

function invalidProxyUrl(): Error {
  return new Error("Proxy URL must use http:// or https://");
}

/** Validate a persisted proxy value without echoing possible credentials. */
export function normalizeProxyUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw invalidProxyUrl();
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname.length === 0
  ) {
    throw invalidProxyUrl();
  }
  return trimmed;
}

function configuredProxyUrl(proxyUrl: string): string {
  const explicit = normalizeProxyUrl(proxyUrl);
  if (explicit.length > 0) return explicit;
  const pluginEnvironment = process.env.DSH_CODEX_PROXY?.trim() ?? "";
  return pluginEnvironment.length > 0
    ? normalizeProxyUrl(pluginEnvironment)
    : "";
}

function environmentProxyKey(): string {
  return [
    process.env.DSH_CODEX_PROXY,
    process.env.https_proxy,
    process.env.HTTPS_PROXY,
    process.env.http_proxy,
    process.env.HTTP_PROXY,
    process.env.all_proxy,
    process.env.ALL_PROXY,
    process.env.no_proxy,
    process.env.NO_PROXY,
  ]
    .map((value) => value?.trim() ?? "")
    .join("\u0000");
}

function proxyKey(proxyUrl: string): string {
  const explicit = configuredProxyUrl(proxyUrl);
  return explicit.length === 0
    ? `env:${environmentProxyKey()}`
    : `url:${explicit}`;
}

function createScopedDispatcher(proxyUrl: string): Dispatcher {
  const explicit = configuredProxyUrl(proxyUrl);
  return explicit.length > 0
    ? new ProxyAgent(explicit)
    : new EnvHttpProxyAgent();
}

/** Fixed public endpoint used only to check that a proxy can reach OpenAI. */
export const OPENAI_CODEX_PROBE_URL =
  "https://auth.openai.com/.well-known/openid-configuration";

/** Deadline for the proxy connectivity check. */
export const OPENAI_CODEX_PROBE_TIMEOUT_MS = 10_000;

/** Safe, body-free result of a proxy connectivity check. */
export interface ProxyConnectivity {
  outcome: "ok" | "http-error" | "timeout" | "network-error";
  /** HTTP status when the probe received a response; never response content. */
  status?: number;
  /** Wall-clock duration of the probe in milliseconds. */
  elapsedMs: number;
  /** True when the probe used an explicit URL instead of proxy environment. */
  explicitProxy: boolean;
}

/**
 * Check one proxy URL without touching saved settings, global dispatch, or
 * credentials. An empty URL follows the existing proxy environment resolution.
 */
export async function probeProxyConnectivity(
  proxyUrl: string,
  timeoutMs: number = OPENAI_CODEX_PROBE_TIMEOUT_MS
): Promise<ProxyConnectivity> {
  const started = Date.now();
  const controller = new AbortController();
  let dispatcher: Dispatcher | undefined;
  let explicitProxy = false;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    explicitProxy = configuredProxyUrl(proxyUrl).length > 0;
    dispatcher = createScopedDispatcher(proxyUrl);
    const response = await undiciFetch(OPENAI_CODEX_PROBE_URL, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      dispatcher,
    });
    const elapsedMs = Date.now() - started;
    await response.body?.cancel().catch(() => undefined);
    const status = response.status;
    return {
      outcome: status >= 200 && status < 300 ? "ok" : "http-error",
      status,
      elapsedMs,
      explicitProxy,
    };
  } catch {
    return {
      outcome: timedOut ? "timeout" : "network-error",
      elapsedMs: Date.now() - started,
      explicitProxy,
    };
  } finally {
    clearTimeout(timer);
    await dispatcher?.destroy().catch(() => undefined);
  }
}

function globalProxyEnvironment(proxyUrl: string): {
  get(name: string): { value: string } | undefined;
} {
  const explicit = configuredProxyUrl(proxyUrl);
  return {
    get(name) {
      const lower = name.toLowerCase();
      if (
        explicit.length > 0 &&
        (lower === "http_proxy" || lower === "https_proxy")
      ) {
        return { value: explicit };
      }
      const value = process.env[name];
      return value === undefined ? undefined : { value };
    },
  };
}

type ProxyEnvironment = ReturnType<typeof globalProxyEnvironment>;
type ProxyDisposer = () => Promise<void>;

/**
 * Integration points supplied by the bundled network proxy (mihomo) host.
 *
 * Both are read per request, so enabling/disabling the proxy, switching scope,
 * or a kernel restart (new mixed port) needs no re-wiring of the transport.
 */
export interface ProxyTransportHooks {
  /** Mixed-port URL the built-in proxy serves for Codex traffic, when it owns it. */
  managedProxyUrl?: () => string | undefined;
  /** True while the built-in proxy owns the process-wide dispatcher. */
  netProxyOwnsGlobal?: () => boolean;
}

async function installHarnessGlobalProxy(
  proxyUrl: string
): Promise<ProxyDisposer> {
  return await installProxyFromEnvironment(
    globalProxyEnvironment(proxyUrl),
    (message) => {
      process.stderr.write(`[dsh-codex] ${message}\n`);
    }
  );
}

/**
 * Owns request-scoped dispatch and an optional nested Harness-wide policy.
 * Disposing the nested policy restores the launcher's original proxy policy.
 *
 * The bundled network proxy (mihomo) integrates through the two hooks below:
 * when it runs in "codex" scope it never touches process-global state, and this
 * transport is the only place its mixed-port URL is used. When it runs in
 * "global" scope it already owns the process dispatcher, so this transport must
 * not stack a second global takeover on top.
 */
export class OpenAICodexProxyTransport {
  private readonly dispatchers = new Map<string, Dispatcher>();
  private globalDispose: (() => Promise<void>) | undefined;
  private appliedGlobalKey: string | undefined;
  private managedUrl: string | undefined;
  private transition: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly preferences: () => ProxyPreferences,
    private readonly hooks: ProxyTransportHooks = {}
  ) {}

  /** Reconcile process-global state after a live setting change. */
  apply(): Promise<void> {
    const preferences = this.preferences();
    normalizeProxyUrl(preferences.proxyUrl);
    const netProxyOwnsGlobal = this.hooks.netProxyOwnsGlobal?.() === true;
    const desiredKey =
      preferences.proxyMode === "global" && !netProxyOwnsGlobal
        ? proxyKey(preferences.proxyUrl)
        : undefined;
    this.transition = this.transition.catch(() => undefined).then(async () => {
      if (this.disposed || desiredKey === this.appliedGlobalKey) return;
      // While the built-in network proxy owns the process dispatcher, disposing
      // our nested dsh-http-proxy policy would restore an older dispatcher on
      // top of that owner. Keep the disposer and the applied key; the next
      // apply() after the built-in proxy releases the slot reconciles normally
      // (re-installing the manual policy, or restoring the original one).
      if (this.hooks.netProxyOwnsGlobal?.() === true) return;
      await this.restoreGlobal();
      if (desiredKey === undefined) return;
      this.globalDispose = await installHarnessGlobalProxy(
        preferences.proxyUrl
      );
      this.appliedGlobalKey = desiredKey;
    });
    return this.transition;
  }

  /** Fetch implementation injected into Codex-owned HTTP call sites. */
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    await this.apply();
    const preferences = this.preferences();
    if (preferences.proxyMode === "scoped") {
      const options = {
        ...(init ?? {}),
        dispatcher: this.dispatcher(preferences.proxyUrl),
      } as Parameters<typeof undiciFetch>[1];
      return (await undiciFetch(
        input as Parameters<typeof undiciFetch>[0],
        options
      )) as unknown as Response;
    }
    // An explicitly configured proxy always wins. With the default "off" mode,
    // a running built-in network proxy covers Codex traffic through its mixed
    // port; "global" scope leaves both host and Codex traffic to its own
    // process-wide dispatcher, which plain fetch already inherits.
    const managed =
      preferences.proxyMode === "off"
        ? this.hooks.managedProxyUrl?.()
        : undefined;
    if (managed !== undefined && managed !== "") {
      const options = {
        ...(init ?? {}),
        dispatcher: this.managedDispatcher(managed),
      } as Parameters<typeof undiciFetch>[1];
      return (await undiciFetch(
        input as Parameters<typeof undiciFetch>[0],
        options
      )) as unknown as Response;
    }
    return await globalThis.fetch(input, init);
  };

  /** Restore host networking and close all provider-owned pools. */
  async dispose(): Promise<void> {
    await this.transition.catch(() => undefined);
    this.disposed = true;
    await this.restoreGlobal();
    const dispatchers = [...this.dispatchers.values()];
    this.dispatchers.clear();
    await Promise.allSettled(
      dispatchers.map(async (dispatcher) => await dispatcher.close())
    );
  }

  private dispatcher(proxyUrl: string): Dispatcher {
    const key = proxyKey(proxyUrl);
    let dispatcher = this.dispatchers.get(key);
    if (dispatcher === undefined) {
      dispatcher = createScopedDispatcher(proxyUrl);
      this.dispatchers.set(key, dispatcher);
    }
    return dispatcher;
  }

  private managedDispatcher(proxyUrl: string): Dispatcher {
    if (this.managedUrl !== undefined && this.managedUrl !== proxyUrl) {
      const previousKey = `managed:${this.managedUrl}`;
      const previous = this.dispatchers.get(previousKey);
      this.dispatchers.delete(previousKey);
      void previous?.close().catch(() => undefined);
    }
    this.managedUrl = proxyUrl;
    const key = `managed:${proxyUrl}`;
    let dispatcher = this.dispatchers.get(key);
    if (dispatcher === undefined) {
      dispatcher = new ProxyAgent(proxyUrl);
      this.dispatchers.set(key, dispatcher);
    }
    return dispatcher;
  }

  private async restoreGlobal(): Promise<void> {
    const dispose = this.globalDispose;
    this.globalDispose = undefined;
    this.appliedGlobalKey = undefined;
    await dispose?.();
  }
}
