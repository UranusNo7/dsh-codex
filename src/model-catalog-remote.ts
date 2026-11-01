/**
 * Official Codex model catalog fetched from the ChatGPT backend.
 *
 * The catalog is an internal ChatGPT endpoint, not the public OpenAI
 * `/v1/models` API. Only the fields this plugin converts are persisted: the
 * response also carries tool policy, transport-shaped headers, and future
 * credential-adjacent metadata that must never reach the disk.
 * @module dsh-codex/model-catalog-remote
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Credential } from "@earendil-works/pi-ai";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";

/** Fixed official catalog origin. A response can never redirect or retarget it. */
export const OPENAI_CODEX_CATALOG_URL =
  "https://chatgpt.com/backend-api/codex/models";

/**
 * Whole official client version this parser was verified against.
 *
 * The catalog endpoint trims and reshapes its response by `client_version`.
 * This constant states the directory shape this adapter was verified with; it
 * does not mean this plugin implements every capability of that CLI release.
 */
export const OPENAI_CODEX_CATALOG_CLIENT_VERSION = "0.165.0";

/** Refresh threshold; matches the official client's own catalog TTL. */
export const OPENAI_CODEX_CATALOG_TTL_MS = 300_000;

/** Cooldown after a failed refresh so opening Settings cannot hammer the endpoint. */
export const OPENAI_CODEX_CATALOG_RETRY_MS = 60_000;

/** One catalog request, start to finish. */
export const OPENAI_CODEX_CATALOG_TIMEOUT_MS = 20_000;

/** Hard response cap, applied while streaming so a hostile body cannot be buffered. */
export const OPENAI_CODEX_CATALOG_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Upper bound on accepted entries; the official catalog is far smaller. */
export const OPENAI_CODEX_CATALOG_MAX_MODELS = 200;

/** This bundle's own client identifier; the official originator is never spoofed. */
export const OPENAI_CODEX_CATALOG_USER_AGENT = "dsh-openai-codex";

/** Fixed, sanitized failure reason. Provider text never crosses this boundary. */
export const OPENAI_CODEX_CATALOG_UNAVAILABLE =
  "official-model-catalog-unavailable";

/** Fixed, sanitized reason for a rejected OAuth session. */
export const OPENAI_CODEX_CATALOG_UNAUTHORIZED =
  "official-model-catalog-unauthorized";

/** One picker-visible model, normalized to the fields the provider merge reads. */
export interface OpenAICodexOfficialModel {
  slug: string;
  display_name?: string;
  visibility: "list";
  context_window: number;
  input_modalities?: readonly ("text" | "image")[];
  supported_reasoning_levels?: readonly { effort: string }[];
}

/** Last successfully parsed official catalog for one account. */
export interface OpenAICodexOfficialSnapshot {
  readonly models: readonly OpenAICodexOfficialModel[];
  /** Epoch milliseconds of the successful fetch. */
  readonly fetchedAt: number;
  /** SHA-256 of the ChatGPT account id; the id itself is never stored. */
  readonly accountHash: string;
  /** Whether this snapshot came from the network or from the persisted cache. */
  readonly source: "official" | "cache";
}

/** Where a snapshot came from, for the browser-facing discovery projection. */
export interface OpenAICodexCatalogProvenance {
  source: "official" | "cache";
  updatedAt: number;
}

/** Options for one account-scoped official catalog reader. */
export interface OpenAICodexOfficialCatalogOptions {
  /** Cache path derived from the credential document this catalog belongs to. */
  cacheFile: string;
  /** Transport bound to the plugin's proxy preferences. */
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** Read the plugin's own OAuth credential; never returns it to callers. */
  readCredential: () => Promise<Credential | undefined>;
  /**
   * Local-only credential read used to key the persisted cache. It must not
   * refresh the session, so an expired token still restores its cached catalog
   * while offline. Defaults to {@link readCredential}.
   */
  readStoredCredential?: () => Promise<Credential | undefined>;
  now?: () => number;
  ttlMs?: number;
  retryMs?: number;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

const CACHE_VERSION = 1;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > max ? undefined : trimmed;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function modalities(value: unknown): ("text" | "image")[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (item): item is "text" | "image" => item === "text" || item === "image"
  );
}

function reasoningLevels(
  value: unknown
): readonly { effort: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels: { effort: string }[] = [];
  for (const item of value.slice(0, 16)) {
    const effort = text(record(item)?.["effort"], 32);
    if (effort !== undefined) levels.push({ effort });
  }
  // An explicit empty list means "no reasoning levels" and must survive the
  // conversion; only a missing, non-array, or entirely malformed value is
  // treated as absent so the previous default stays in effect.
  if (levels.length === 0 && value.length > 0) return undefined;
  return levels;
}

function catalogModel(value: unknown): OpenAICodexOfficialModel | undefined {
  const entry = record(value);
  if (entry === undefined || entry["visibility"] !== "list") return undefined;
  const slug = text(entry["slug"], 128);
  if (slug === undefined || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(slug)) {
    return undefined;
  }
  const contextWindow = entry["context_window"];
  if (!positiveInteger(contextWindow)) return undefined;
  const displayName = text(entry["display_name"], 200);
  const input = modalities(entry["input_modalities"]);
  const levels = reasoningLevels(entry["supported_reasoning_levels"]);
  return {
    slug,
    visibility: "list",
    context_window: contextWindow,
    ...(displayName === undefined ? {} : { display_name: displayName }),
    ...(input === undefined ? {} : { input_modalities: input }),
    ...(levels === undefined
      ? {}
      : { supported_reasoning_levels: levels }),
  };
}

/** Keep only valid, picker-visible entries from either source document. */
function catalogModels(value: unknown): OpenAICodexOfficialModel[] | undefined {
  const entries = record(value)?.["models"];
  if (!Array.isArray(entries)) return undefined;
  const models: OpenAICodexOfficialModel[] = [];
  const seen = new Set<string>();
  for (const entry of entries.slice(0, OPENAI_CODEX_CATALOG_MAX_MODELS)) {
    const model = catalogModel(entry);
    if (model === undefined || seen.has(model.slug)) continue;
    seen.add(model.slug);
    models.push(model);
  }
  return models.length === 0 ? undefined : models;
}

/** Stable account partition key that cannot be reversed into the account id. */
export function openAICodexAccountHash(accountId: string): string {
  return createHash("sha256").update(accountId).digest("hex");
}

/** Per-credential cache path so several credential files never share one catalog. */
export function openAICodexCatalogCachePath(credentialFilename: string): string {
  return `${credentialFilename}.models-cache.json`;
}

interface OAuthView {
  access: string;
  accountId: string;
}

function oauthView(credential: Credential | undefined): OAuthView | undefined {
  if (credential === undefined || credential.type !== "oauth") return undefined;
  const access = (credential as { access?: unknown }).access;
  const accountId = (credential as { accountId?: unknown }).accountId;
  if (typeof access !== "string" || access.length === 0) return undefined;
  if (typeof accountId !== "string" || accountId.length === 0) return undefined;
  return { access, accountId };
}

/** Read the persisted catalog, ignoring any entry written by another account. */
function readCache(
  filename: string,
  requestedAccountHash: string
): OpenAICodexOfficialSnapshot | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filename, "utf8").replace(/^\uFEFF/u, ""));
  } catch {
    return undefined;
  }
  const document = record(parsed);
  if (
    document === undefined ||
    document["version"] !== CACHE_VERSION ||
    document["clientVersion"] !== OPENAI_CODEX_CATALOG_CLIENT_VERSION ||
    document["accountHash"] !== requestedAccountHash
  ) {
    return undefined;
  }
  const fetchedAt = document["fetchedAt"];
  const models = catalogModels(document);
  if (!positiveInteger(fetchedAt) || models === undefined) return undefined;
  return {
    models,
    fetchedAt,
    accountHash: requestedAccountHash,
    source: "cache",
  };
}

async function writeCache(
  filename: string,
  snapshot: OpenAICodexOfficialSnapshot
): Promise<void> {
  const document = JSON.stringify({
    version: CACHE_VERSION,
    clientVersion: OPENAI_CODEX_CATALOG_CLIENT_VERSION,
    accountHash: snapshot.accountHash,
    fetchedAt: snapshot.fetchedAt,
    models: snapshot.models,
  });
  await writeFileAtomic(filename, `${document}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  });
}

/** Decode a bounded response body without ever buffering beyond the cap. */
async function readBoundedBody(
  response: Response,
  limit: number
): Promise<string | undefined> {
  const body = response.body;
  if (body === null) {
    const value = await response.text();
    return Buffer.byteLength(value) > limit ? undefined : value;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Release a response this client will not read, without surfacing its body. */
async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body may already be locked or closed; nothing left to release.
  }
}

/**
 * One account-partitioned official catalog reader.
 *
 * Network work is TTL-gated and coalesced, failures keep the last successful
 * same-account snapshot, and results that settle after {@link dispose} or an
 * account switch are discarded instead of mutating released state.
 */
export class OpenAICodexOfficialCatalog {
  private readonly cacheFile: string;
  private readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  private readonly readCredential: () => Promise<Credential | undefined>;
  private readonly readStoredCredential: () => Promise<Credential | undefined>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly retryMs: number;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  private current: OpenAICodexOfficialSnapshot | undefined;
  private failure: string | undefined;
  private generation = 0;
  private disposed = false;
  private pending: Promise<void> | undefined;
  private wave: { networked: boolean } | undefined;
  private retryAt: number | undefined;
  private abort = new AbortController();

  constructor(options: OpenAICodexOfficialCatalogOptions) {
    this.cacheFile = options.cacheFile;
    this.fetch = options.fetch;
    this.readCredential = options.readCredential;
    this.readStoredCredential =
      options.readStoredCredential ?? options.readCredential;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? OPENAI_CODEX_CATALOG_TTL_MS;
    this.retryMs = options.retryMs ?? OPENAI_CODEX_CATALOG_RETRY_MS;
    this.timeoutMs = options.timeoutMs ?? OPENAI_CODEX_CATALOG_TIMEOUT_MS;
    this.maxBodyBytes =
      options.maxBodyBytes ?? OPENAI_CODEX_CATALOG_MAX_BODY_BYTES;
  }

  /** Current snapshot; the persisted cache is loaded by {@link restore}. */
  snapshot(): OpenAICodexOfficialSnapshot | undefined {
    return this.current;
  }

  /** Read the persisted snapshot for the signed-in account. */
  async restore(): Promise<void> {
    if (this.disposed) return;
    const generation = this.generation;
    // Keying the cache must never need the network: a stale access token that
    // cannot be refreshed offline still owns its previously fetched catalog.
    const credential = oauthView(
      await this.readStoredCredential().catch(() => undefined)
    );
    if (this.disposed || generation !== this.generation) return;
    if (credential === undefined) {
      // Signed out: the previous account's catalog is not ours to advertise.
      this.current = undefined;
      this.failure = undefined;
      return;
    }
    const accountHash = openAICodexAccountHash(credential.accountId);
    if (this.current !== undefined && this.current.accountHash === accountHash) {
      return;
    }
    this.current = readCache(this.cacheFile, accountHash);
  }

  /** Browser-facing provenance for the currently advertised snapshot. */
  provenance(): OpenAICodexCatalogProvenance | undefined {
    const snapshot = this.current;
    return snapshot === undefined
      ? undefined
      : { source: snapshot.source, updatedAt: snapshot.fetchedAt };
  }

  /** Fixed, sanitized reason for the last failed refresh, if any. */
  error(): string | undefined {
    return this.failure;
  }

  /**
   * Abort the in-flight request and drop the visible snapshot, so neither a
   * late response nor a canceled request can republish the previous account.
   * The failure cooldown and the joinable wave belong to the old account too,
   * so a refresh issued right after this starts its own request.
   */
  invalidate(): void {
    this.generation += 1;
    this.abort.abort();
    this.abort = new AbortController();
    this.current = undefined;
    this.failure = undefined;
    this.retryAt = undefined;
    this.pending = undefined;
    this.wave = undefined;
  }

  /** Abort the in-flight request and stop accepting refreshes. */
  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.abort.abort();
    this.current = undefined;
    this.retryAt = undefined;
    this.pending = undefined;
    this.wave = undefined;
  }

  /**
   * Refresh once, honoring the TTL unless forced. Every concurrent caller —
   * forced or not — joins the single in-flight wave; force only bypasses the
   * TTL, never the gate.
   */
  async refresh(force = false): Promise<void> {
    if (this.disposed) return;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pending = this.pending;
      if (pending !== undefined) {
        const joined = this.wave;
        await pending;
        if (this.disposed) return;
        if (!force || joined?.networked === true) return;
        // The joined wave satisfied the TTL without touching the network, so
        // a forced caller still needs one real attempt of its own.
        continue;
      }
      const wave = { networked: false };
      this.wave = wave;
      const run = this.run(force, wave);
      this.pending = run;
      try {
        await run;
      } finally {
        if (this.pending === run) {
          this.pending = undefined;
          this.wave = undefined;
        }
      }
      return;
    }
  }

  /** Refresh without making the caller wait for the network. */
  backgroundRefresh(): void {
    void this.refresh(false).catch(() => undefined);
  }

  private async run(force: boolean, wave: { networked: boolean }): Promise<void> {
    const generation = this.generation;
    if (this.disposed) return;
    let credential: Credential | undefined;
    try {
      credential = await this.readCredential();
    } catch {
      // A credential-store failure is not proof of sign-out: keep the catalog.
      return;
    }
    if (this.disposed || generation !== this.generation) return;
    const view = oauthView(credential);
    if (view === undefined) {
      // Signed out: drop the previous account's official catalog.
      this.current = undefined;
      this.failure = undefined;
      return;
    }
    const accountHash = openAICodexAccountHash(view.accountId);
    if (
      this.current !== undefined &&
      this.current.accountHash !== accountHash
    ) {
      // Another account owns the visible catalog: stop advertising it before
      // the replacement arrives instead of leaving a stale cross-account list.
      this.current = undefined;
      this.failure = undefined;
      this.retryAt = undefined;
    }
    const now = this.now();
    const current = this.current;
    if (
      !force &&
      current !== undefined &&
      now >= current.fetchedAt &&
      now - current.fetchedAt < this.ttlMs
    ) {
      this.failure = undefined;
      return;
    }
    if (!force && this.retryAt !== undefined && now < this.retryAt) return;
    wave.networked = true;
    const result = await this.request(view, this.abort.signal);
    if (this.disposed || generation !== this.generation) return;
    if (result.models === undefined) {
      this.failure = result.failure;
      // A short cooldown keeps Settings reads from retrying a failing endpoint
      // on every open; a forced refresh still tries again immediately.
      this.retryAt = this.now() + this.retryMs;
      return;
    }
    const snapshot: OpenAICodexOfficialSnapshot = {
      models: result.models,
      fetchedAt: this.now(),
      accountHash,
      source: "official",
    };
    this.failure = undefined;
    this.retryAt = undefined;
    this.current = snapshot;
    try {
      await writeCache(this.cacheFile, snapshot);
    } catch {
      // A cache write failure must not discard a live catalog.
    }
  }

  private async request(
    credential: OAuthView,
    abort: AbortSignal
  ): Promise<
    | { models: readonly OpenAICodexOfficialModel[]; failure?: undefined }
    | { models?: undefined; failure: string }
  > {
    const url = `${OPENAI_CODEX_CATALOG_URL}?client_version=${OPENAI_CODEX_CATALOG_CLIENT_VERSION}`;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal =
      typeof AbortSignal.any === "function"
        ? AbortSignal.any([abort, timeout])
        : timeout;
    try {
      const response = await this.fetch(url, {
        method: "GET",
        redirect: "error",
        headers: {
          authorization: `Bearer ${credential.access}`,
          "chatgpt-account-id": credential.accountId,
          accept: "application/json",
          "cache-control": "no-store",
          "user-agent": OPENAI_CODEX_CATALOG_USER_AGENT,
        },
        signal,
      });
      if (response.status === 401 || response.status === 403) {
        await cancelBody(response);
        return { failure: OPENAI_CODEX_CATALOG_UNAUTHORIZED };
      }
      if (response.status !== 200) {
        await cancelBody(response);
        return { failure: OPENAI_CODEX_CATALOG_UNAVAILABLE };
      }
      const body = await readBoundedBody(response, this.maxBodyBytes);
      if (body === undefined) {
        return { failure: OPENAI_CODEX_CATALOG_UNAVAILABLE };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return { failure: OPENAI_CODEX_CATALOG_UNAVAILABLE };
      }
      const models = catalogModels(parsed);
      return models === undefined
        ? { failure: OPENAI_CODEX_CATALOG_UNAVAILABLE }
        : { models };
    } catch {
      return { failure: OPENAI_CODEX_CATALOG_UNAVAILABLE };
    }
  }
}
