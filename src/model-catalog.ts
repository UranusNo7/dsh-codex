import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { OpenAICodexOfficialSnapshot } from "./model-catalog-remote.ts";

/** Authoritative official catalog snapshot, when one is available. */
export type OpenAICodexOfficialCatalogSource =
  () => OpenAICodexOfficialSnapshot | undefined;

/** Keep retired GPT generations out while allowing later and non-versioned routes. */
export function isSupportedOpenAICodexModel(id: string): boolean {
  const version = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/u.exec(id);
  if (version === null) return true;
  const major = Number(version[1]);
  const minor = Number(version[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 5);
}

/** Only model metadata is shared with Codex; its credentials are never read. */
export function openAICodexModelsCachePath(): string {
  return process.env["DSH_CODEX_MODELS_CACHE"]?.trim() ||
    join(process.env["CODEX_HOME"]?.trim() || join(homedir(), ".codex"), "models_cache.json");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Merge picker-visible Codex metadata while preserving bundled transport and pricing. */
export function mergeOpenAICodexModels(
  bundled: readonly Model<Api>[],
  document: unknown
): readonly Model<Api>[] {
  const filtered = bundled.filter((model) => isSupportedOpenAICodexModel(model.id));
  const available = filtered.length === bundled.length ? bundled : filtered;
  const entries = record(document)?.["models"];
  const transport = available[0];
  if (!Array.isArray(entries) || transport === undefined) return available;
  const known = new Map(available.map(model => [model.id, model]));
  const discovered = new Map<string, Model<Api>>();
  for (const value of entries) {
    const entry = record(value);
    const id = entry?.["slug"];
    const contextWindow = entry?.["context_window"];
    if (!entry || entry["visibility"] !== "list" ||
      typeof id !== "string" || !isSupportedOpenAICodexModel(id) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) ||
      !positiveInteger(contextWindow) || discovered.has(id)) continue;
    const existing = known.get(id);
    const modalities = entry["input_modalities"];
    const input: ("text" | "image")[] = Array.isArray(modalities)
      ? modalities.filter((item): item is "text" | "image" => item === "text" || item === "image")
      : existing?.input ?? ["text", "image"];
    if (!input.includes("text")) continue;
    const levels = entry["supported_reasoning_levels"];
    const efforts = Array.isArray(levels)
      ? levels.flatMap(level => {
        const effort = record(level)?.["effort"];
        return typeof effort === "string" ? [effort] : [];
      }) : undefined;
    const thinkingLevelMap: ThinkingLevelMap = {};
    if (efforts !== undefined) {
      for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
        thinkingLevelMap[level] = efforts.includes(level) ? level : null;
      }
      if (!efforts.includes("minimal") && efforts.includes("low")) thinkingLevelMap.minimal = "low";
    }
    discovered.set(id, {
      ...(existing ?? {
        id,
        api: transport.api,
        provider: transport.provider,
        baseUrl: transport.baseUrl,
        // Subscription usage has no discoverable per-token price. Do not copy
        // an unrelated model's rates or its model-specific compatibility flags.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      name: typeof entry["display_name"] === "string" && entry["display_name"].trim()
        ? entry["display_name"] : existing?.name ?? id,
      contextWindow,
      maxTokens: Math.min(existing?.maxTokens ?? 128_000, contextWindow),
      input,
      reasoning: efforts === undefined ? existing?.reasoning ?? true : efforts.length > 0,
      ...(efforts === undefined ? {} : { thinkingLevelMap }),
    });
  }
  if (discovered.size === 0) return available;
  const bundledIds = new Set(available.map((model) => model.id));
  return [
    ...available.map((model) => discovered.get(model.id) ?? model),
    ...[...discovered.values()].filter((model) => !bundledIds.has(model.id)),
  ];
}

interface CodexCacheState {
  document?: unknown;
}

/** Reload changed metadata without invalidating in-flight request snapshots. */
export class OpenAICodexModelCatalog {
  private signature: string | undefined;
  private codex: CodexCacheState | undefined;
  private mergedCodex: CodexCacheState | undefined;
  private official: OpenAICodexOfficialSnapshot | undefined;
  private hadOfficial = false;
  private retained: readonly Model<Api>[] = [];
  private retainedAccount: string | undefined;
  private current: readonly Model<Api>[];
  private readonly bundled: readonly Model<Api>[];

  constructor(
    bundled: readonly Model<Api>[],
    private readonly filename = openAICodexModelsCachePath(),
    private readonly officialCatalog?: OpenAICodexOfficialCatalogSource
  ) {
    const available = bundled.filter((model) => isSupportedOpenAICodexModel(model.id));
    this.bundled = available.length === bundled.length ? bundled : available;
    this.current = this.bundled;
  }

  getModels(): readonly Model<Api>[] {
    const codex = this.readCodexCache();
    const official = this.officialCatalog?.();
    if (official?.accountHash !== this.retainedAccount) {
      // Switching (or losing) the account must not inherit another account's
      // discovered transport metadata.
      this.retainedAccount = official?.accountHash;
      this.retained = [];
      this.mergedCodex = undefined;
    }
    if (codex === this.mergedCodex && official === this.official) return this.current;
    this.mergedCodex = codex;
    this.official = official;
    let next = this.bundled;
    if (codex.document !== undefined) {
      const merged = mergeOpenAICodexModels(this.bundled, codex.document);
      if (merged !== this.bundled) next = merged;
    }
    const baseline = next;
    if (official !== undefined && official.models.length > 0) {
      // A successful official catalog is authoritative: a Codex cache file can
      // add transport templates but never overrides official metadata.
      const merged = mergeOpenAICodexModels(baseline, { models: official.models });
      if (merged !== baseline) next = merged;
    }
    if (this.retained.length > 0) {
      // A later catalog can omit a model this account already used. Keep its
      // transport metadata so resumed sessions still resolve; it stays out of
      // the picker because advertising filters on the current official list.
      const ids = new Set(next.map((model) => model.id));
      const kept = this.retained.filter((model) => !ids.has(model.id));
      if (kept.length > 0) next = [...next, ...kept];
    }
    if (official !== undefined) {
      const baselineIds = new Set(baseline.map((model) => model.id));
      this.retained = next.filter((model) => !baselineIds.has(model.id));
    }
    // An authoritative catalog that disappears (sign-out, account switch, or a
    // cleared snapshot) must drop its models; an empty or unsupported Codex
    // cache entry must not, which preserves the original fallback contract.
    const droppedOfficial = official === undefined && this.hadOfficial;
    this.hadOfficial = official !== undefined;
    if (droppedOfficial || next !== this.bundled) this.current = next;
    return this.current;
  }

  /** Picker-visible catalog: official list entries when one is authoritative. */
  advertised(): readonly Model<Api>[] {
    const models = this.getModels();
    const official = this.official;
    if (official === undefined) return models;
    const visible = new Set(official.models.map((model) => model.slug));
    return models.filter((model) => visible.has(model.id));
  }

  /** Which non-official source is currently supplying metadata. */
  fallbackSource(): "codex-cache" | "bundled" {
    return this.codex?.document === undefined ? "bundled" : "codex-cache";
  }

  private readCodexCache(): CodexCacheState {
    const signature = this.codexSignature();
    if (signature === this.signature && this.codex !== undefined) return this.codex;
    this.signature = signature;
    if (signature.startsWith("file:")) {
      try {
        const document: unknown = JSON.parse(readFileSync(this.filename, "utf8").replace(/^\uFEFF/, ""));
        this.codex = { document };
        return this.codex;
      } catch {
        // Interrupted writes keep the last successfully parsed document.
      }
    }
    // Codex is optional: a missing, oversized, or unreadable file must not
    // erase the last usable catalog. Try again when Codex replaces the file.
    this.codex ??= {};
    return this.codex;
  }

  private codexSignature(): string {
    try {
      const stat = statSync(this.filename);
      return !stat.isFile() || stat.size > 10 * 1024 * 1024
        ? "invalid"
        : `file:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      return code === "ENOENT" ? "missing" : "error";
    }
  }
}
