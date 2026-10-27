/**
 * Types for the vendored mihomo host module (`src/net-proxy/index.js`).
 *
 * The implementation is the MIT-licensed dsh-net-proxy host half with minimal
 * dsh-codex integration edits (route prefix, scope, loopback controller
 * transport, asset location). Only the surface the rest of the package and the
 * tests actually use is described here.
 */

import type { Context } from "@deepseek-ai/cordis";

export type NetworkProxyScope = "codex" | "global";

export declare const name: string;
export declare const inject: readonly string[];
export declare const NETWORK_PROXY_BASE_PATH: "/plugins/dsh-openai-codex/network-proxy";
export declare const NETWORK_PROXY_SCOPE_DEFAULT: NetworkProxyScope;

export interface NetworkProxyNode {
  name: string;
  type: string;
  delay?: number | undefined;
  status: string;
  error?: string | undefined;
  cooldownMs: number;
  failCount: number;
}

export interface NetworkProxyRouting {
  installed: boolean;
  via: string;
  error?: string | undefined;
}

export interface NetworkProxyKernel {
  status: string;
  pid?: number | undefined;
  error?: string | undefined;
  path?: string | undefined;
  log?: string | undefined;
}

export interface NetworkProxySnapshot {
  enabled: boolean;
  scope: NetworkProxyScope;
  kernel: NetworkProxyKernel;
  routing: NetworkProxyRouting;
  group?: string | undefined;
  current?: string | undefined;
  testing: boolean;
  busy?: string | undefined;
  lastError?: string | undefined;
  lastTestAt?: number | undefined;
  proxyUrl?: string | undefined;
  mixedPort: number;
  testTargets: readonly string[];
  pinnedNode: string;
  nodes: NetworkProxyNode[];
}

export declare function apply(
  ctx: Context | unknown,
  config?: Record<string, unknown>
): void;

export declare function getNetworkProxyScope(): NetworkProxyScope;

export declare function setNetworkProxyScope(
  scope: NetworkProxyScope | string
): Promise<NetworkProxySnapshot>;

export declare function networkProxyCodexUrl(): string | undefined;

export declare function networkProxyOwnsGlobal(): boolean;

// ── test seams (underscore-prefixed on purpose) ─────────────────────────────

export interface NetworkProxyInternalState {
  config: {
    enabled: boolean;
    scope: NetworkProxyScope;
    subscriptionUrl: string;
    mixedPort: number;
    apiPort: number;
    apiSecret: string;
    testTargets: string[];
    testTimeoutMs: number;
    testConcurrency: number;
    proxyModelCalls: boolean;
    bypass: string[];
    pinnedNode: string;
    writeMemory: boolean;
    autoEnabled: boolean;
    subscriptionSeeded: boolean;
    [key: string]: unknown;
  };
  kernel: NetworkProxyKernel;
  nodes: NetworkProxyNode[];
  group?: string | undefined;
  current?: string | undefined;
  testing: boolean;
  lastTestAt?: number | undefined;
  lastError?: string | undefined;
  busy?: string | undefined;
  testAbort: boolean;
  routing: NetworkProxyRouting;
}

export declare const _state: NetworkProxyInternalState;

export declare const _runtime: Record<string, (...args: any[]) => unknown>;

export declare const _paths: {
  stateDir(): string;
  configPath(): string;
  runtimeConfigPath(): string;
  subscriptionPath(): string;
  kernelLogPath(): string;
  binDir(): string;
  pluginRoot(): string;
};

export declare function _snapshot(): NetworkProxySnapshot;

export declare function _api(
  path: string,
  options?: { method?: string; body?: unknown; timeoutMs?: number }
): Promise<unknown>;

export declare function _coreRequest(options: {
  port: number;
  path: string;
  method?: string;
  body?: unknown;
  secret?: string;
  timeoutMs?: number;
}): Promise<unknown>;

export declare function _shouldProxyHost(host: string): boolean;

export declare function _resolvePackageRoot(dir: string): string;

export declare function _findKernel(): string | undefined;

export declare function _enableProxy(isDisposed?: () => boolean): Promise<boolean>;

export declare function _disableProxy(): Promise<boolean>;

export declare function _installScopeRouting(): Promise<boolean>;

export declare function _uninstallScopeRouting(): void;

export declare function _reconcileScopeRouting(): Promise<boolean>;

export declare function _installRouting(): Promise<boolean>;

export declare function _uninstallRouting(): void;

export declare function _normalizeScope(value: string): NetworkProxyScope;

export declare function _writeAgentMemory(): string[];
