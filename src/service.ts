/** Shared host service consumed by optional OpenAI Codex front-door adapters. */

import { createModels } from "@earendil-works/pi-ai";
import { Agent, fetch as undiciFetch } from "undici";
import type { AuthInteraction, Credential } from "@earendil-works/pi-ai";
import type { Context } from "@deepseek-ai/cordis";
import {
  loginOpenAICodex,
  logoutOpenAICodex,
  openAICodexAuthStatus,
} from "./auth.ts";
import type { OpenAICodexAuthStatus } from "./auth.ts";
import { openaiCodexProvider } from "./oauth-provider.ts";
import { OPENAI_CODEX_PROVIDER, OpenAICodexCredentialStore } from "./store.ts";
import {
  openAICodexCatalogCachePath,
  OpenAICodexOfficialCatalog,
} from "./model-catalog-remote.ts";
import type { OpenAICodexOfficialSnapshot } from "./model-catalog-remote.ts";
import { OpenAICodexProxyTransport } from "./proxy.ts";
import type { ProxyPreferences } from "./proxy.ts";
import {
  networkProxyCodexUrl,
  networkProxyOwnsGlobal,
} from "./net-proxy/index.js";
import { ImageToolPolicy } from "./tool-policy.ts";
import type {
  ContextWindowPreferences,
  FastModePreferences,
  ImageToolPreferences,
  ModelCatalogDiscovery,
  ModelCatalogEntry,
  ModelCatalogSettings,
  ModelFallbackPreferences,
  ResponseApiPreferences,
} from "./tool-policy.ts";
import { RelayUsageUnsupportedError, relayConfigOf } from "./relay.ts";
import type {
  RelayConfig,
  RelayPreferences,
  RelaySnapshot,
} from "./relay.ts";
import { readOpenAICodexRateLimits } from "./usage.ts";
import type { OpenAICodexUsage } from "./usage.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Provider-owned account and preference service for optional front doors. */
    openAICodex: OpenAICodexService;
  }
}

/** Initial settings contributed by the bundle configuration. */
export interface OpenAICodexServiceOptions
  extends
    ImageToolPreferences,
    ResponseApiPreferences,
    ContextWindowPreferences,
    FastModePreferences,
    ModelFallbackPreferences,
    ProxyPreferences {
  credentialFile?: string;
  settingsNamespace?: string;
  models?: string[];
  modelCatalog: readonly ModelCatalogEntry[] | (() => readonly ModelCatalogEntry[]);
  /** Third-party relay base URL; omitted or empty keeps direct traffic. */
  relayBaseUrl?: string;
  /** Static relay key; omitted or empty leaves the relay mode key unset. */
  relayApiKey?: string;
  /** Non-official metadata source reported when no official catalog is usable. */
  modelCatalogSource?: () => "codex-cache" | "bundled";
  /** Injected official catalog reader; omitted to build the plugin's own. */
  officialCatalog?: OpenAICodexOfficialCatalog;
  /** Warm the official catalog at construction; the plugin entry enables it. */
  warmModelCatalog?: boolean;
}

/**
 * One provider-owned host service shared by Web routes and terminal adapters.
 * Credentials and live policy stay singletons even when several front doors are mounted.
 */
export class OpenAICodexService {
  readonly settingsNamespace: string;
  readonly credentials: OpenAICodexCredentialStore;
  readonly policy: ImageToolPolicy;
  readonly proxy: OpenAICodexProxyTransport;
  /**
   * Dedicated direct dispatcher for relay traffic. An explicit undici Agent
   * does not inherit the process-wide dispatcher, so a user-enabled global
   * mihomo scope cannot route relay requests through its managed proxy.
   */
  private readonly relayDispatcher = new Agent();
  /** Per-request transport: relay uses the dedicated agent, direct keeps proxy.fetch. */
  readonly requestFetch: typeof globalThis.fetch = async (input, init) => {
    if (this.relayConfig() === undefined) {
      return await this.proxy.fetch(input, init);
    }
    return (await undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      {
        ...(init as Record<string, unknown> | undefined),
        dispatcher: this.relayDispatcher,
      } as Parameters<typeof undiciFetch>[1]
    )) as unknown as Response;
  };
  private readonly catalog: OpenAICodexOfficialCatalog;
  private readonly catalogFallbackSource: () => "codex-cache" | "bundled";
  private readonly stopProxyWatch: () => void;
  private usageCache:
    | { expiresAt: number; request: Promise<OpenAICodexUsage> }
    | undefined;
  private lastUsage: OpenAICodexUsage | undefined;

  constructor(options: OpenAICodexServiceOptions) {
    this.settingsNamespace = options.settingsNamespace ?? "llm-openai-codex";
    this.credentials = new OpenAICodexCredentialStore(options.credentialFile);
    // Only preferences belong in the settings composition base: `modelCatalog`
    // is a live thunk and `credentialFile` is not a preference, and either one
    // reaching the descriptor makes settings.describe() fail to materialize.
    const {
      modelCatalog,
      modelCatalogSource,
      officialCatalog,
      warmModelCatalog,
      credentialFile: _credentialFile,
      settingsNamespace: _settingsNamespace,
      ...preferences
    } = options;
    this.policy = new ImageToolPolicy(preferences, modelCatalog);
    this.catalogFallbackSource = modelCatalogSource ?? (() => "bundled");
    this.catalog = officialCatalog ?? new OpenAICodexOfficialCatalog({
      cacheFile: openAICodexCatalogCachePath(this.credentials.filename),
      fetch: (input, init) => this.proxy.fetch(input, init),
      readCredential: () => this.catalogCredential(),
      // Restoring the cache stays local: an expired token that cannot be
      // refreshed offline must still reach its previously fetched catalog.
      readStoredCredential: () => this.credentials.read(OPENAI_CODEX_PROVIDER),
    });
    this.proxy = new OpenAICodexProxyTransport(
      () => this.policy.proxySnapshot(),
      {
        managedProxyUrl: networkProxyCodexUrl,
        netProxyOwnsGlobal: networkProxyOwnsGlobal,
      }
    );
    void this.proxy.apply().catch((error: unknown) => {
      process.stderr.write(
        `[dsh-codex] failed to apply proxy settings: ${error instanceof Error ? error.message : String(error)}\n`
      );
    });
    this.stopProxyWatch = this.policy.watchProxyPreferences(() => {
      void this.proxy.apply().catch((error: unknown) => {
        process.stderr.write(
          `[dsh-codex] failed to apply proxy settings: ${error instanceof Error ? error.message : String(error)}\n`
        );
      });
    });
    // Warm the catalog without delaying plugin composition: the persisted
    // snapshot is adopted first, then the TTL decides whether to hit the wire.
    // Embedders that construct the service directly opt in explicitly so tests
    // can never reach a real account or endpoint.
    // Relay mode must not warm an official catalog for the previous account.
    if (warmModelCatalog === true && !this.policy.relaySnapshot().enabled) {
      void this.loadModelCatalog().catch(() => undefined);
    }
  }

  /** Bind browser writes to the owning plugin entry in the active profile. */
  attachSettings(ctx: Context, namespace: string, owner: Context["fiber"]): void {
    this.policy.attach(ctx, namespace, owner);
  }

  /** Accept values committed in place by Harness's volatile configuration path. */
  refreshSettings(options: Partial<OpenAICodexServiceOptions>): void {
    const relayBefore = this.policy.relaySnapshot().enabled;
    this.policy.refresh(options);
    // Entering relay mode drops every account-only cache; a catalog refresh
    // that was already in flight can no longer be adopted because all catalog
    // reads are gated by the current relay snapshot.
    if (!relayBefore && this.policy.relaySnapshot().enabled) {
      this.catalog.invalidate();
      this.usageCache = undefined;
      this.lastUsage = undefined;
    }
  }

  /** Start the provider-native OAuth lifecycle. */
  async login(interaction: AuthInteraction): Promise<void> {
    await this.proxy.apply();
    await loginOpenAICodex(interaction, this.credentials, this.proxy.fetch);
    this.usageCache = undefined;
    this.lastUsage = undefined;
    this.adoptModelCatalogAccount();
  }

  /** Clear the selected credential; explicit shared files affect their other consumers too. */
  async logout(): Promise<void> {
    await logoutOpenAICodex(this.credentials);
    this.usageCache = undefined;
    this.lastUsage = undefined;
    this.catalog.invalidate();
  }

  /** Read non-secret authentication metadata. */
  authStatus(): Promise<OpenAICodexAuthStatus> {
    return openAICodexAuthStatus(this.credentials);
  }

  /** Read current subscription limits without issuing a model request. */
  async usage(forceRefresh = false): Promise<OpenAICodexUsage> {
    // Relay mode has no account quota to read; refuse before any network call.
    if (this.policy.relaySnapshot().enabled) throw new RelayUsageUnsupportedError();
    const now = Date.now();
    if (
      !forceRefresh &&
      this.usageCache !== undefined &&
      this.usageCache.expiresAt > now
    ) {
      return await this.usageCache.request;
    }
    const request = readOpenAICodexRateLimits(
      this.credentials,
      this.proxy.fetch
    );
    this.usageCache = { expiresAt: now + 15_000, request };
    try {
      const usage = await request;
      if (this.usageCache?.request === request) this.lastUsage = usage;
      return usage;
    } catch (error: unknown) {
      if (this.usageCache?.request === request) this.usageCache = undefined;
      if (forceRefresh) this.lastUsage = undefined;
      throw error;
    }
  }

  /** Last successful account snapshot, used without delaying a healthy model request. */
  usageSnapshot(): OpenAICodexUsage | undefined {
    // Relay accounts are not the OAuth account: never feed stale quota to fallback.
    if (this.policy.relaySnapshot().enabled) return undefined;
    return this.lastUsage;
  }

  /** Browser-safe relay projection: URL and whether a key is configured. */
  relaySnapshot(): RelaySnapshot {
    return this.policy.relaySnapshot();
  }

  /** Resolve the active relay for host transports; direct traffic returns undefined. */
  relayConfig(): RelayConfig | undefined {
    return relayConfigOf(this.policy.relayPreferences());
  }

  /** Persist relay preferences and drop account-only caches while relay is active. */
  async updateRelayPreferences(
    patch: Partial<RelayPreferences>
  ): Promise<RelaySnapshot> {
    const snapshot = await this.policy.updateRelayPreferences(patch);
    if (snapshot.enabled) {
      this.catalog.invalidate();
      this.usageCache = undefined;
      this.lastUsage = undefined;
    }
    return snapshot;
  }

  imagePreferences(): ImageToolPreferences {
    return this.policy.snapshot();
  }

  updateImagePreferences(
    patch: Partial<ImageToolPreferences>
  ): Promise<ImageToolPreferences> {
    return this.policy.update(patch);
  }

  responsePreferences(): ResponseApiPreferences {
    return this.policy.responseApiSnapshot();
  }

  updateResponsePreferences(
    patch: Partial<ResponseApiPreferences>
  ): Promise<ResponseApiPreferences> {
    return this.policy.updateResponseApi(patch);
  }

  contextWindowPreferences(): ContextWindowPreferences {
    return this.policy.contextWindowSnapshot();
  }

  updateContextWindowPreferences(
    patch: Partial<ContextWindowPreferences>
  ): Promise<ContextWindowPreferences> {
    return this.policy.updateContextWindow(patch);
  }

  fastModePreferences(): FastModePreferences {
    return this.policy.fastModeSnapshot();
  }

  updateFastModePreferences(
    patch: Partial<FastModePreferences>
  ): Promise<FastModePreferences> {
    return this.policy.updateFastMode(patch);
  }

  modelFallbackPreferences(): ModelFallbackPreferences {
    return this.policy.modelFallbackSnapshot();
  }

  updateModelFallbackPreferences(
    patch: Partial<ModelFallbackPreferences>
  ): Promise<ModelFallbackPreferences> {
    return this.policy.updateModelFallback(patch);
  }

  modelCatalogSettings(): ModelCatalogSettings {
    // Relay mode never reports a previous direct account's official provenance;
    // local bundled/codex-cache metadata stays available as the fallback source.
    const relay = this.policy.relaySnapshot().enabled;
    const provenance = relay ? undefined : this.catalog.provenance();
    const error = relay ? undefined : this.catalog.error();
    const discovery: ModelCatalogDiscovery = {
      source: provenance?.source ?? this.catalogFallbackSource(),
      ...(provenance === undefined ? {} : { updatedAt: provenance.updatedAt }),
      ...(error === undefined ? {} : { error }),
    };
    return { ...this.policy.modelCatalogSnapshot(), discovery };
  }

  /** Official catalog snapshot that constrains the advertised candidates. */
  modelCatalogOfficial(): OpenAICodexOfficialSnapshot | undefined {
    // Relay traffic keeps only the bundled catalog: never advertise or cache
    // candidates discovered for a previous OAuth account.
    if (this.policy.relaySnapshot().enabled) return undefined;
    return this.catalog.snapshot();
  }

  /**
   * Load the catalog for a settings read. The persisted snapshot is adopted
   * first, then the TTL-gated refresh is awaited so the answer already carries
   * the newest candidates; the request itself is bounded by the catalog
   * timeout and never touches chat traffic. A forced call skips the TTL.
   */
  async refreshModelCatalog(force = false): Promise<ModelCatalogSettings> {
    if (this.policy.relaySnapshot().enabled) {
      this.catalog.invalidate();
      return this.modelCatalogSettings();
    }
    await this.catalog.restore();
    await this.catalog.refresh(force);
    return this.modelCatalogSettings();
  }

  /** Adopt a newly authenticated account without advertising the previous one. */
  adoptModelCatalogAccount(): void {
    if (this.policy.relaySnapshot().enabled) {
      this.catalog.invalidate();
      return;
    }
    this.catalog.invalidate();
    this.catalog.backgroundRefresh();
  }

  /** Drop a signed-out account's catalog without issuing a request. */
  clearModelCatalogAccount(): void {
    this.catalog.invalidate();
  }

  proxyPreferences(): ProxyPreferences {
    return this.policy.proxySnapshot();
  }

  async updateProxyPreferences(
    patch: Partial<ProxyPreferences>
  ): Promise<ProxyPreferences> {
    const preferences = await this.policy.updateProxy(patch);
    await this.proxy.apply();
    return preferences;
  }

  async dispose(): Promise<void> {
    this.stopProxyWatch();
    this.catalog.dispose();
    await this.proxy.dispose();
    await this.relayDispatcher.destroy().catch(() => undefined);
  }

  /** Adopt the persisted snapshot, then apply the TTL to the network refresh. */
  private async loadModelCatalog(): Promise<void> {
    await this.catalog.restore();
    await this.catalog.refresh(false);
  }

  /**
   * Resolve the catalog credential through the same provider-native OAuth
   * lifecycle a Codex turn uses, so an expired access token is refreshed by
   * pi-ai instead of being treated as signed out.
   */
  private async catalogCredential(): Promise<Credential | undefined> {
    const models = createModels({ credentials: this.credentials });
    models.setProvider(
      openaiCodexProvider((input, init) => this.proxy.fetch(input, init))
    );
    const auth = await models.getAuth(OPENAI_CODEX_PROVIDER);
    const access = auth?.auth.apiKey;
    const credential = await this.credentials.read(OPENAI_CODEX_PROVIDER);
    if (credential?.type !== "oauth") return undefined;
    if (typeof access !== "string" || access.length === 0) return undefined;
    return { ...credential, access };
  }
}
