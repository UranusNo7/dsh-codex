/**
 * Optional OpenAI Codex subscription bundle with ChatGPT OAuth, Codex models,
 * standalone search, browser settings, and vision-aware image input.
 * @module dsh-codex
 */

import type { Context, Volatile } from "@deepseek-ai/cordis";
import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import type {} from "@deepseek-ai/dsh-attachment";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-web";
import type {} from "@deepseek-ai/dsh-host-webserver";
import type {} from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-fs";
import type {} from "@deepseek-ai/dsh-settings";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import {
  createOpenAICodexAdapter,
  createOpenAICodexModelProvider,
  openAICodexModelCatalog,
  openAICodexModelCatalogSource,
} from "./adapter.ts";
import type { TokenEstimator } from "./responses.ts";
import { registerOpenAICodexAuthRoutes } from "./auth-routes.ts";
import { installReadImageEnhancement } from "./read-image-enhancement.ts";
import { imagegenTool } from "./imagegen.ts";
import { ImageToolPolicy } from "./tool-policy.ts";
import { FastModeRegistry } from "./fast-mode.ts";
import { installOpenAICodexModelFallback } from "./model-fallback.ts";
import { installOpenAICodexToolCompat } from "./tool-compat.ts";
import { assertNoOpenAICodexProviderConflict } from "./doctor.ts";
import {
  installOpenAICodexSearchEvent,
} from "./search-event.ts";

export { READ_IMAGE_TOOL_NAME } from "./read-image-enhancement.ts";
export {
  IMAGEGEN_TOOL_NAME,
  OPENAI_CODEX_IMAGE_EDITS_URL,
  OPENAI_CODEX_IMAGE_GENERATIONS_URL,
  OPENAI_CODEX_IMAGE_MODEL,
  OpenAICodexImageClient,
} from "./imagegen.ts";
export {
  DEFAULT_CONTEXT_WINDOW_PREFERENCES,
  DEFAULT_FAST_MODE_PREFERENCES,
  DEFAULT_IMAGE_TOOL_PREFERENCES,
  DEFAULT_MODEL_FALLBACK_PREFERENCES,
  DEFAULT_RESPONSE_API_PREFERENCES,
  ImageToolPolicy,
} from "./tool-policy.ts";
export type {
  ContextWindowPreferences,
  FastModePreferences,
  ModelFallbackPreferences,
  ImageToolPreferences,
  ResponseApiPreferences,
} from "./tool-policy.ts";
export {
  isOpenAICodexReauthRequiredError,
  OPENAI_CODEX_REAUTH_REQUIRED_CODE,
  OPENAI_CODEX_REAUTH_REQUIRED_MESSAGE,
  OPENAI_CODEX_USAGE_URL,
  OpenAICodexReauthRequiredError,
  parseOpenAICodexUsage,
  readOpenAICodexRateLimits,
} from "./usage.ts";
export type {
  OpenAICodexCredits,
  OpenAICodexIndividualLimit,
  OpenAICodexRateLimit,
  OpenAICodexRateLimitWindow,
  OpenAICodexRateLimitUpsell,
  OpenAICodexUsage,
} from "./usage.ts";
export {
  installOpenAICodexSearchEvent,
  OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT,
} from "./search-event.ts";
import {
  DEFAULT_OPENAI_CODEX_SEARCH_CONTEXT_SIZE,
  DEFAULT_OPENAI_CODEX_SEARCH_MAX_OUTPUT_TOKENS,
  DEFAULT_OPENAI_CODEX_SEARCH_MODE,
  DEFAULT_OPENAI_CODEX_SEARCH_MODEL,
  OpenAICodexSearchProvider,
} from "./search.ts";
import type {
  OpenAICodexSearchContextSize,
  OpenAICodexSearchMode,
} from "./search.ts";
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } from "./store.ts";
import { OpenAICodexService } from "./service.ts";
import { DEFAULT_PROXY_PREFERENCES } from "./proxy.ts";
import type { OpenAICodexProxyMode } from "./proxy.ts";
import {
  DEFAULT_OPENAI_CODEX_IMAGE_MODEL,
  OPENAI_CODEX_IMAGE_MODELS,
} from "./image-model.ts";
import type { OpenAICodexImageModel } from "./image-model.ts";
import { apply as applyNetworkProxy } from "./net-proxy/index.js";
import { localNetworkProxyTool } from "./local-network-proxy-tool.ts";
import {
  CodexContextController,
  takeoverDeclared,
} from "./codex-context.ts";
import type {
  CodexCompactionService,
  TurnBoundaryLike,
} from "./codex-context.ts";
import { installCodexContextTools } from "./codex-context-tool.ts";
import {
  installCompactionDiagnostics,
  openCompactionIdOfState,
} from "./compaction-diagnostics.ts";
import { COMPACTION_PROJECTION_KEY } from "./compaction-types.ts";

export { OpenAICodexService } from "./service.ts";
export type { OpenAICodexServiceOptions } from "./service.ts";
export {
  getNetworkProxyScope,
  NETWORK_PROXY_BASE_PATH,
  NETWORK_PROXY_SCOPE_DEFAULT,
  networkProxyCodexUrl,
  networkProxyOwnsGlobal,
  setNetworkProxyScope,
} from "./net-proxy/index.js";
export type {
  NetworkProxyScope,
  NetworkProxySnapshot,
} from "./net-proxy/index.js";
export {
  LOCAL_NETWORK_PROXY_TOOL_NAME,
  localNetworkProxyTool,
} from "./local-network-proxy-tool.ts";
export {
  DEFAULT_PROXY_PREFERENCES,
  normalizeProxyUrl,
  OpenAICodexProxyTransport,
} from "./proxy.ts";
export type { OpenAICodexProxyMode, ProxyPreferences } from "./proxy.ts";
export {
  DEFAULT_OPENAI_CODEX_IMAGE_MODEL,
  OPENAI_CODEX_IMAGE_MODELS,
  isOpenAICodexImageModel,
} from "./image-model.ts";
export type { OpenAICodexImageModel } from "./image-model.ts";

export {
  assertNoOpenAICodexProviderConflict,
  diagnoseOpenAICodex,
  openAICodexConflictMessage,
} from "./doctor.ts";
export type {
  OpenAICodexDiagnosticOptions,
  OpenAICodexDiagnosticReport,
} from "./doctor.ts";
export {
  FastModeRegistry,
  isFastModeSessionId,
  OPENAI_CODEX_FAST_MODE_MAX_SESSIONS,
  OPENAI_CODEX_FAST_MODE_MAX_SESSION_ID_LENGTH,
} from "./fast-mode.ts";
export { OPENAI_CODEX_FAST_MODE_PATH } from "./fast-mode-paths.ts";
export {
  installOpenAICodexModelFallback,
  openAICodexFallbackCandidates,
  resolveOpenAICodexFallback,
} from "./model-fallback.ts";
export { OPENAI_CODEX_LUNA_RESERVE_MODEL } from "./adapter.ts";
export { OPENAI_CODEX_CHECKPOINT_FRAME_ALLOWANCE } from "./responses.ts";
export type { TokenEstimator } from "./responses.ts";
export {
  COMPACTION_DIAGNOSTICS_VERSION,
  COMPACTION_PROJECTION_KEY,
  COMPACTION_PROJECTION_STATE_VERSION,
  COMPACTION_REMOTE_NAMESPACE,
} from "./compaction-types.ts";
export type {
  CompactionDecision,
  CompactionDiagnostic,
  CompactionDiagnosticsSnapshot,
  CompactionLocalEstimate,
  CompactionOutcomeStatus,
  CompactionOwnerStatus,
  CompactionProjectionFact,
  CompactionProjectionView,
  CompactionProviderUsage,
  CompactionReadRequest,
  CompactionReason,
  CompactionSessionStatus,
  CompactionSummaryFacts,
} from "./compaction-types.ts";
export {
  COMPACTION_DOMAIN_NAME,
  COMPACTION_DOMAIN_TABLE,
  CompactionDiagnostics,
  CompactionRemote,
  foldCompactionEvents,
  installCompactionDiagnostics,
  openCompactionId,
  openCompactionIdOfState,
} from "./compaction-diagnostics.ts";

export {
  loginOpenAICodex,
  logoutOpenAICodex,
  openAICodexAuthStatus,
} from "./auth.ts";
export type { OpenAICodexAuthStatus } from "./auth.ts";
export {
  OpenAICodexCredentialStore,
  OPENAI_CODEX_AUTH_FILENAME,
  OPENAI_CODEX_PROVIDER,
  openAICodexAuthPath,
} from "./store.ts";
export {
  DEFAULT_OPENAI_CODEX_SEARCH_CONTEXT_SIZE,
  DEFAULT_OPENAI_CODEX_SEARCH_MAX_OUTPUT_TOKENS,
  DEFAULT_OPENAI_CODEX_SEARCH_MODE,
  DEFAULT_OPENAI_CODEX_SEARCH_MODEL,
  mapOpenAICodexSearchResponse,
  OpenAICodexSearchProvider,
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_SEARCH_PROVIDER,
  OPENAI_CODEX_SEARCH_URL,
} from "./search.ts";
export type {
  OpenAICodexSearchContextSize,
  OpenAICodexSearchMode,
  OpenAICodexSearchProviderOptions,
  OpenAICodexSearchRequestRecord,
} from "./search.ts";

/** Stable Cordis plugin name. */
export const name = "llm-openai-codex";

/** LLM and web registries required before the composite provider can register. */
export const inject = ["llm", "web"];

/** Composite model and standalone-search configuration. */
export interface Config {
  /** Absolute shared OAuth JSON path; omitted to retain independent dsh storage. */
  credentialFile?: string;
  /** Model ids advertised by the provider; omitted to advertise the full catalog. */
  models?: string[];
  /** Client-side model context capacity in tokens; omitted to keep provider defaults. */
  contextWindow?: number | null;
  /** Model used for auxiliary standalone searches. */
  searchModel?: string;
  /** Cached, indexed, or live web access. */
  searchMode?: OpenAICodexSearchMode;
  /** Amount of search context returned by the provider. */
  searchContextSize?: OpenAICodexSearchContextSize;
  /** Maximum generated tokens returned by the standalone search endpoint. */
  searchMaxOutputTokens?: number;
  /** Extend Harness read_image with HTTP(S) URL input. */
  modifyReadImage?: boolean;
  /** Allow non-Codex vision models to call imagegen. */
  shareImagegenWithOtherModels?: boolean;
  /** GPT Image backend used by imagegen. */
  imageGenerationModel?: OpenAICodexImageModel;
  /** Reuse matching Codex context through the session's WebSocket connection. */
  useWebSocketContextReuse?: boolean;
  /** Use Codex V2 Responses compaction for Harness compaction calls. */
  useNativeCompaction?: boolean;
  /** Force the priority service tier on every Codex session. */
  fastModeDefault?: boolean;
  /** Follow only model recovery explicitly authorized by the account backend. */
  automaticModelFallback?: boolean;
  /** How this plugin applies its proxy URL. */
  proxyMode?: OpenAICodexProxyMode;
  /** HTTP(S) proxy URL; empty uses the launch environment. */
  proxyUrl?: string;
}

export const Config = z.object({
  credentialFile: z.union([z.const(undefined), z.string()]),
  models: z.union([z.const(undefined), z.array(z.string())]).volatile(),
  contextWindow: z.union([
    z.const(null),
    z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  ]).default(null).volatile(),
  searchModel: z.string().default(DEFAULT_OPENAI_CODEX_SEARCH_MODEL),
  searchMode: z
    .union(["cached", "indexed", "live"] as const)
    .default(DEFAULT_OPENAI_CODEX_SEARCH_MODE),
  searchContextSize: z
    .union(["low", "medium", "high"] as const)
    .default(DEFAULT_OPENAI_CODEX_SEARCH_CONTEXT_SIZE),
  searchMaxOutputTokens: z
    .number()
    .step(1)
    .min(1)
    .default(DEFAULT_OPENAI_CODEX_SEARCH_MAX_OUTPUT_TOKENS),
  modifyReadImage: z.boolean().default(true).volatile(),
  shareImagegenWithOtherModels: z.boolean().default(true).volatile(),
  imageGenerationModel: z
    .union(OPENAI_CODEX_IMAGE_MODELS.map((model) => model.id) as [
      OpenAICodexImageModel,
      ...OpenAICodexImageModel[],
    ])
    .default(DEFAULT_OPENAI_CODEX_IMAGE_MODEL)
    .volatile(),
  useWebSocketContextReuse: z.boolean().default(false).volatile(),
  useNativeCompaction: z.boolean().default(false).volatile(),
  fastModeDefault: z.boolean().default(false).volatile(),
  automaticModelFallback: z.boolean().default(false).volatile(),
  proxyMode: z
    .union(["off", "scoped", "global"] as const)
    .default(DEFAULT_PROXY_PREFERENCES.proxyMode)
    .volatile(),
  proxyUrl: z.string().default(DEFAULT_PROXY_PREFERENCES.proxyUrl).volatile(),
});

/**
 * Register the `openai-codex` LLM route and standalone web-search provider
 * with one provider-native OAuth credential store.
 * @param ctx - plugin context carrying the LLM and web registries plus optional agent and attachment services.
 * @param config - standalone-search model, access mode, context size, and output budget.
 */
function liveValue<T>(value: T | undefined, fallback: T): T {
  const candidate = value as T | Volatile<T> | undefined;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "get" in candidate &&
    typeof candidate.get === "function"
  ) {
    return (candidate.get() ?? fallback) as T;
  }
  return (candidate ?? fallback) as T;
}

export function apply(ctx: Context, config: Config): void {
  installOpenAICodexSearchEvent();
  const settingsNamespace = (ctx.fiber as unknown as {
    entry?: { options?: { id?: string } };
  }).entry?.options?.id ?? name;
  // The catalog and service reference each other lazily: the transport is only
  // used for real requests, and the official snapshot only after composition.
  let created: OpenAICodexService | undefined;
  const modelProvider = createOpenAICodexModelProvider(
    (input, init) =>
      created === undefined
        ? globalThis.fetch(input, init)
        : created.proxy.fetch(input, init),
    () => created?.modelCatalogOfficial()
  );
  const livePreferences = () => ({
    models: [...liveValue(config.models, openAICodexModelCatalog(modelProvider).map((model) => model.id))],
    contextWindow: liveValue(config.contextWindow, null),
    modifyReadImage: liveValue(config.modifyReadImage, true),
    shareImagegenWithOtherModels: liveValue(config.shareImagegenWithOtherModels, true),
    imageGenerationModel: liveValue(config.imageGenerationModel, DEFAULT_OPENAI_CODEX_IMAGE_MODEL),
    useWebSocketContextReuse: liveValue(config.useWebSocketContextReuse, false),
    useNativeCompaction: liveValue(config.useNativeCompaction, false),
    fastModeDefault: liveValue(config.fastModeDefault, false),
    automaticModelFallback: liveValue(config.automaticModelFallback, false),
    proxyMode: liveValue(config.proxyMode, DEFAULT_PROXY_PREFERENCES.proxyMode),
    proxyUrl: liveValue(config.proxyUrl, DEFAULT_PROXY_PREFERENCES.proxyUrl),
  });
  const service = new OpenAICodexService({
    ...(config.credentialFile === undefined ? {} : { credentialFile: config.credentialFile }),
    settingsNamespace,
    modelCatalog: () => openAICodexModelCatalog(modelProvider),
    modelCatalogSource: () => openAICodexModelCatalogSource(modelProvider),
    warmModelCatalog: true,
    ...livePreferences(),
  });
  created = service;
  const credentials = service.credentials;
  const imageTools = service.policy;
  const fastMode = new FastModeRegistry();
  // Resolved lazily on every estimate: a composition without a token meter
  // degrades the native checkpoint to the ordinary summary instead of guessing.
  const estimateCompactionText: TokenEstimator = (text) => {
    const meter = (ctx as unknown as { get(name: string): unknown }).get(
      "tokenMeter"
    ) as { estimateMessage(message: unknown): number } | undefined;
    if (meter === undefined) return undefined;
    return meter.estimateMessage(
      createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "user" },
      })
    );
  };
  // Diagnostics metadata plus the pure projection and readonly Remote. The
  // decision hook resolves the real compaction id from the live session's
  // projection state, never from timing or a hash guess.
  let contextController: CodexContextController | undefined;
  const { diagnostics, dispose: disposeDiagnostics } =
    installCompactionDiagnostics(ctx, {
      resolveCompactionId: (sessionId) => {
        const sessions = (ctx as unknown as { get(name: string): unknown }).get(
          "sessions"
        ) as { get(id: string): unknown } | undefined;
        const projections = (ctx as unknown as {
          get(name: string): unknown;
        }).get("sessionProjections") as
          | { stateOf(session: unknown, key: string): unknown }
          | undefined;
        const session = sessions?.get(sessionId);
        if (session === undefined || projections === undefined) return undefined;
        return openCompactionIdOfState(
          projections.stateOf(session, COMPACTION_PROJECTION_KEY)
        );
      },
      sessionStatus: (sessionId) =>
        contextController?.statusForSession(sessionId),
      // Exact per-request status is read from the controller's bounded facts;
      // the settle port only waits inside the observed idle→settle window.
      requests: (sessionId) => contextController?.requestsForSession(sessionId),
      settleRequests: (sessionId, signal) =>
        contextController?.settleForRead(sessionId, signal),
    });
  // Agent-scoped compaction requests/recovery: the controller owns the queue and
  // the factual owner verdict; this plugin only reports and never takes over an
  // external compaction gate. A composed gate is not a takeover: only an active
  // external declaration blocks the request path.
  const agentPresets = () =>
    (ctx as unknown as {
      get(name: string): unknown;
    }).get("agentPresets") as
      | {
          serviceFor(
            agent: unknown,
            key: string
          ): CodexCompactionService | undefined;
        }
      | undefined;
  contextController = new CodexContextController({
    resolveCompaction: (agent) => {
      const presets = agentPresets()?.serviceFor(agent, "compaction");
      if (presets !== undefined) return presets;
      // A composition may inherit `compaction` through the Agent's own scope
      // without mounting agentPresets; read that scope, never the root context.
      const scoped = (agent as unknown as {
        ctx?: { get(name: string): unknown };
      }).ctx;
      return scoped?.get("compaction") as CodexCompactionService | undefined;
    },
    takeoverDeclared: () => takeoverDeclared(),
    // The public `turnBoundary` projection is the preferred source of the
    // accepted turn; the controller itself converts the projection's
    // `openTurnStartSeq` into a turn number from the durable event. The
    // callback must hand back the boundary object, never a bare seq.
    resolveSourceTurn: (agent) => {
      const session = agent.session;
      const projections = (ctx as unknown as {
        get(name: string): unknown;
      }).get("sessionProjections") as
        | { stateOf(session: unknown, key: string): unknown }
        | undefined;
      if (session === undefined || projections === undefined) return undefined;
      const boundary = projections.stateOf(session, "turnBoundary");
      return typeof boundary === "object" && boundary !== null
        ? (boundary as TurnBoundaryLike)
        : undefined;
    },
    diagnostics: (agent) => {
      const sessionId = agent.session?.id;
      if (sessionId === undefined) return undefined;
      const latest = diagnostics.latest(sessionId);
      if (latest === undefined) return undefined;
      return {
        ...(latest.sourceEstimate === undefined
          ? {}
          : { localEstimate: latest.sourceEstimate }),
        ...(latest.nativeUsage === undefined
          ? {}
          : { providerUsage: latest.nativeUsage }),
      };
    },
    onRequestChange: (sessionId, change) => {
      // Persist the real request linkage only when the controller knows the
      // compaction id; a queued phase contributes the real acceptance time.
      if (change.compactionId !== undefined || change.phase === "queued") {
        diagnostics.linkRequest(sessionId, {
          requestId: change.requestId,
          ...(change.compactionId === undefined
            ? {}
            : { compactionId: change.compactionId }),
          ...(change.phase === "queued" ? { queuedAt: change.at } : {}),
        });
      }
      if (change.phase !== "cancelled") return;
      diagnostics.recordDecision({
        sessionId,
        ...(change.compactionId === undefined
          ? {}
          : { compactionId: change.compactionId }),
        reason: "aborted",
        at: change.at,
      });
    },
    // The Agent identity is the only history address: the controller passes the
    // calling Agent, and this Host port authorizes and observes exactly that
    // current session through the public async query, disposing the lease.
    readHistory: async (agent, range, signal) => {
      const sessionId = agent.session?.id;
      const sessionQuery = (ctx as unknown as {
        get(name: string): unknown;
      }).get("sessionQuery") as
        | {
            observeSession(
              id: string,
              options: { projectionMode: "none"; signal?: AbortSignal }
            ): Promise<{
              events?: readonly { seq: number; type: string; data?: unknown }[];
              cursor?: number;
              [Symbol.dispose]?: () => void;
            }>;
          }
        | undefined;
      if (sessionId === undefined || sessionQuery === undefined) return undefined;
      const observation = await sessionQuery.observeSession(sessionId, {
        projectionMode: "none",
        ...(signal === undefined ? {} : { signal }),
      });
      try {
        const all = observation.events ?? [];
        return {
          events: all.filter(
            (event) =>
              event.seq >= range.fromSeq && event.seq < range.toSeqExclusive
          ),
          // Derived from the complete observation, never from the filtered
          // window: `endSeq` is one past the last durable seq of this session.
          endSeq: all.reduce((max, event) => Math.max(max, event.seq + 1), 0),
        };
      } finally {
        observation[Symbol.dispose]?.();
      }
    },
  });
  const disposeContextEvents = contextController.attach(
    ctx as unknown as Parameters<CodexContextController["attach"]>[0]
  );
  let disposeContextTools: (() => void) | undefined;
  // Optional capability: only the Agent roster is a prerequisite here. The tool
  // itself is registered in the Agent's own `ctx.tools` (preset-local), so a
  // composition with only a root `agents` service still installs correctly.
  ctx.inject(["agents"], (contextCtx) => {
    disposeContextTools = installCodexContextTools(
      contextCtx as unknown as Parameters<typeof installCodexContextTools>[0],
      contextController!
    );
  });
  // One ordered async teardown: stop tool/listener registrations, abort and
  // await in-flight maintenance, then flush and close diagnostics storage.
  ctx.effect(
    () => async () => {
      disposeContextTools?.();
      disposeContextTools = undefined;
      disposeContextEvents();
      await contextController?.dispose();
      await disposeDiagnostics();
    },
    "dsh-openai-codex: compaction context lifecycle"
  );
  assertNoOpenAICodexProviderConflict(
    ctx.llm.listProviders().map((provider) => provider.id)
  );
  ctx.provide("openAICodex", service);
  ctx.effect(
    () => async () => {
      await service.dispose();
    },
    "dsh-openai-codex: proxy transport"
  );
  ctx.inject(["settings"], (settingsCtx) => {
    service.attachSettings(settingsCtx, settingsNamespace, ctx.fiber);
  });
  ctx.on("loader/volatile-update", () => {
    service.refreshSettings(livePreferences());
  });
  ctx.llm.registerAdapter(
    [OPENAI_CODEX_PROVIDER],
    createOpenAICodexAdapter(
      credentials,
      () => ctx.get("attachments"),
      () => imageTools.responseApiSnapshot(),
      fastMode,
      () => imageTools.modelCatalogSnapshot().models,
      () => imageTools.contextWindowSnapshot().contextWindow,
      service.proxy.fetch,
      () => imageTools.fastModeSnapshot().fastModeDefault,
      modelProvider,
      estimateCompactionText,
      (decision) => diagnostics.recordDecision(decision)
    )
  );
  ctx.effect(
    () => installOpenAICodexModelFallback(ctx, service),
    "dsh-openai-codex: backend model fallback"
  );
  ctx.web.registerSearchProvider(
    new OpenAICodexSearchProvider({
      credentials,
      fetch: service.proxy.fetch,
      model: config.searchModel ?? DEFAULT_OPENAI_CODEX_SEARCH_MODEL,
      mode: config.searchMode ?? DEFAULT_OPENAI_CODEX_SEARCH_MODE,
      contextSize:
        config.searchContextSize ?? DEFAULT_OPENAI_CODEX_SEARCH_CONTEXT_SIZE,
      maxOutputTokens:
        config.searchMaxOutputTokens ??
        DEFAULT_OPENAI_CODEX_SEARCH_MAX_OUTPUT_TOKENS,
      resolveRequestId: () =>
        String(
          ctx.get("agents")?.currentInitiator()?.session.id ?? randomUUID()
        ),
    })
  );
  ctx.inject(["webServer"], (webCtx) =>
    registerOpenAICodexAuthRoutes(
      webCtx,
      credentials,
      undefined,
      fastMode,
      imageTools,
      service,
      service.proxy.fetch,
      () => service.proxy.apply()
    )
  );
  // Bundled mihomo host: routes under /plugins/dsh-openai-codex/network-proxy.
  // "codex" scope (default) only hands its mixed-port URL to the transport
  // above; "global" scope additionally takes over the process dispatcher.
  ctx.inject(["webServer"], (webCtx) => {
    applyNetworkProxy(webCtx);
  });
  ctx.inject(["tools"], (toolCtx) => {
    toolCtx.tools.register(localNetworkProxyTool());
  });
  ctx.inject(["tools", "fs", "attachments"], (toolCtx) => {
    toolCtx.tools.register(
      imagegenTool(toolCtx, credentials, imageTools, service.proxy.fetch)
    );
  });
  ctx.inject(["tools", "fs", "attachments", "agents"], (toolCtx) => {
    installReadImageEnhancement(toolCtx, imageTools);
  });
  ctx.inject(["tools", "sandboxPolicy"], (toolCtx) => {
    installOpenAICodexToolCompat(toolCtx);
  });
}
