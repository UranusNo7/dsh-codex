import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
  OPENAI_CODEX_CATALOG_CLIENT_VERSION,
  OPENAI_CODEX_CATALOG_MAX_BODY_BYTES,
  OPENAI_CODEX_CATALOG_UNAUTHORIZED,
  OPENAI_CODEX_CATALOG_UNAVAILABLE,
  OPENAI_CODEX_CATALOG_URL,
  openAICodexAccountHash,
  openAICodexCatalogCachePath,
  OpenAICodexOfficialCatalog,
} from "../src/model-catalog-remote.ts";
import type { OpenAICodexOfficialCatalogOptions } from "../src/model-catalog-remote.ts";

const directories: string[] = [];
function tempFile(name = "auth.json"): string {
  const directory = mkdtempSync(join(tmpdir(), "dsh-codex-catalog-"));
  directories.push(directory);
  return join(directory, name);
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function credential(accountId: string, access = "access-token"): Credential {
  return {
    type: "oauth",
    access,
    refresh: "refresh-token",
    expires: Date.now() + 3_600_000,
    accountId,
  } as unknown as Credential;
}

const visible = {
  slug: "gpt-6-astra",
  display_name: "GPT-6-Astra",
  visibility: "list",
  context_window: 272_000,
  input_modalities: ["text", "image"],
  supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
};

interface Call {
  url: string;
  init: RequestInit;
}

function catalogResponse(models: unknown[] = [visible], status = 200): Response {
  return new Response(JSON.stringify({ models }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function instance(
  overrides: Partial<OpenAICodexOfficialCatalogOptions> = {}
): { catalog: OpenAICodexOfficialCatalog; calls: Call[]; cacheFile: string } {
  const calls: Call[] = [];
  const cacheFile = overrides.cacheFile ?? openAICodexCatalogCachePath(tempFile());
  const catalog = new OpenAICodexOfficialCatalog({
    cacheFile,
    fetch: overrides.fetch ?? (async (url, init) => {
      calls.push({ url, init });
      return catalogResponse();
    }),
    readCredential: overrides.readCredential ?? (async () => credential("account-a")),
    ...(overrides.readStoredCredential === undefined
      ? {}
      : { readStoredCredential: overrides.readStoredCredential }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...(overrides.ttlMs === undefined ? {} : { ttlMs: overrides.ttlMs }),
    ...(overrides.retryMs === undefined ? {} : { retryMs: overrides.retryMs }),
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
    ...(overrides.maxBodyBytes === undefined ? {} : { maxBodyBytes: overrides.maxBodyBytes }),
  });
  return { catalog, calls, cacheFile };
}

describe("official model catalog client", () => {
  it("requests the fixed Codex endpoint with this client's own identity", async () => {
    const { catalog, calls } = instance();
    await catalog.refresh(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `${OPENAI_CODEX_CATALOG_URL}?client_version=${OPENAI_CODEX_CATALOG_CLIENT_VERSION}`
    );
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer access-token");
    expect(headers["chatgpt-account-id"]).toBe("account-a");
    expect(headers["user-agent"]).toBe("dsh-openai-codex");
    expect(headers["cache-control"]).toBe("no-store");
    // The official CLI originator is never spoofed.
    expect(headers).not.toHaveProperty("originator");
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("keeps only picker-visible models and the fields conversion needs", async () => {
    const { catalog } = instance({
      fetch: async () => catalogResponse([
        visible,
        { ...visible, slug: "hidden-model", visibility: "hide" },
        { ...visible, slug: "bad slug" },
        { ...visible, slug: "no-window", context_window: -1 },
        { ...visible, slug: "gpt-6-astra", context_window: 1 },
        { ...visible, slug: "gpt-7-future", headers: { Authorization: "leak" } },
      ]),
    });
    await catalog.refresh(true);
    expect(catalog.snapshot()?.models.map((model) => model.slug))
      .toEqual(["gpt-6-astra", "gpt-7-future"]);
    expect(catalog.snapshot()?.models[1]).not.toHaveProperty("headers");
  });

  it("reports a fixed sanitized reason for a rejected session and keeps the last catalog", async () => {
    let status = 200;
    const { catalog } = instance({
      fetch: async () => status === 200 ? catalogResponse() : catalogResponse([], status),
    });
    await catalog.refresh(true);
    const first = catalog.snapshot();
    status = 401;
    await catalog.refresh(true);
    expect(catalog.snapshot()).toBe(first);
    expect(catalog.error()).toBe(OPENAI_CODEX_CATALOG_UNAUTHORIZED);

    status = 429;
    await catalog.refresh(true);
    expect(catalog.error()).toBe(OPENAI_CODEX_CATALOG_UNAVAILABLE);
    expect(catalog.snapshot()).toBe(first);
  });

  it("preserves an explicit empty reasoning list as a real statement", async () => {
    const { catalog } = instance({
      fetch: async () => catalogResponse([{ ...visible, supported_reasoning_levels: [] }]),
    });
    await catalog.refresh(true);
    expect(catalog.snapshot()?.models[0]?.supported_reasoning_levels).toEqual([]);
  });

  it("treats a body without usable models as a failure instead of an empty catalog", async () => {
    const { catalog } = instance({ fetch: async () => catalogResponse([{ ...visible, visibility: "hide" }]) });
    await catalog.refresh(true);
    expect(catalog.snapshot()).toBeUndefined();
    expect(catalog.error()).toBe(OPENAI_CODEX_CATALOG_UNAVAILABLE);
  });

  it("bounds the streamed response body", async () => {
    const { catalog } = instance({
      maxBodyBytes: 64,
      fetch: async () => new Response(JSON.stringify({ models: [visible] })),
    });
    await catalog.refresh(true);
    expect(catalog.snapshot()).toBeUndefined();
    expect(catalog.error()).toBe(OPENAI_CODEX_CATALOG_UNAVAILABLE);
    expect(OPENAI_CODEX_CATALOG_MAX_BODY_BYTES).toBeGreaterThan(1024 * 1024);
  });

  it("times out a stalled request without retrying", async () => {
    let attempts = 0;
    const { catalog } = instance({
      timeoutMs: 10,
      fetch: (_url, init) => {
        attempts += 1;
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => { reject(new Error("aborted")) });
        });
      },
    });
    await catalog.refresh(true);
    expect(attempts).toBe(1);
    expect(catalog.error()).toBe(OPENAI_CODEX_CATALOG_UNAVAILABLE);
  });

  it("shares one in-flight request across concurrent and forced callers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve });
    let attempts = 0;
    const { catalog } = instance({
      fetch: async () => {
        attempts += 1;
        await gate;
        return catalogResponse();
      },
    });
    const all = [
      catalog.refresh(),
      catalog.refresh(),
      catalog.refresh(true),
      catalog.refresh(true),
    ];
    release();
    await Promise.all(all);
    expect(attempts).toBe(1);
    expect(catalog.snapshot()?.models).toHaveLength(1);
  });

  it("reuses a fresh snapshot and only refreshes when forced or expired", async () => {
    let now = 1_000;
    let attempts = 0;
    const { catalog } = instance({
      ttlMs: 300_000,
      now: () => now,
      fetch: async () => {
        attempts += 1;
        return catalogResponse();
      },
    });
    await catalog.refresh();
    expect(attempts).toBe(1);
    now += 299_000;
    await catalog.refresh();
    expect(attempts).toBe(1);
    await catalog.refresh(true);
    expect(attempts).toBe(2);
    now += 300_000;
    await catalog.refresh();
    expect(attempts).toBe(3);
  });

  it("cools down after a failure so Settings reads do not retry every time", async () => {
    let now = 1_000;
    let attempts = 0;
    const { catalog } = instance({
      retryMs: 60_000,
      now: () => now,
      fetch: async () => {
        attempts += 1;
        return catalogResponse([], 500);
      },
    });
    await catalog.refresh();
    expect(attempts).toBe(1);
    now += 1_000;
    await catalog.refresh();
    expect(attempts).toBe(1);
    await catalog.refresh(true);
    expect(attempts).toBe(2);
    now += 61_000;
    await catalog.refresh();
    expect(attempts).toBe(3);
  });

  it("persists only normalized metadata, then restores it for the same account", async () => {
    const cacheFile = openAICodexCatalogCachePath(tempFile());
    const first = instance({ cacheFile });
    await first.catalog.refresh(true);
    const persisted = readFileSync(cacheFile, "utf8");
    expect(persisted).not.toContain("access-token");
    expect(persisted).not.toContain("account-a");
    expect(persisted).toContain(openAICodexAccountHash("account-a"));

    const calls: Call[] = [];
    const second = instance({
      cacheFile,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return catalogResponse();
      },
    });
    expect(second.catalog.snapshot()).toBeUndefined();
    await second.catalog.restore();
    expect(second.catalog.snapshot()?.source).toBe("cache");
    expect(second.catalog.provenance()?.updatedAt).toBeGreaterThan(0);
    await second.catalog.refresh();
    expect(calls).toHaveLength(0);
  });

  it("restores the persisted cache with an expired token while the lifecycle is offline", async () => {
    const cacheFile = openAICodexCatalogCachePath(tempFile());
    const first = instance({ cacheFile });
    await first.catalog.refresh(true);

    const expired = { ...credential("account-a"), expires: 1 } as unknown as Credential;
    let fetched = 0;
    const offline = instance({
      cacheFile,
      // The provider-native lifecycle would refresh over the network and fail.
      readCredential: async () => { throw new Error("offline refresh failed") },
      readStoredCredential: async () => expired,
      fetch: async () => {
        fetched += 1;
        throw new Error("offline");
      },
    });
    await offline.catalog.restore();
    expect(offline.catalog.snapshot()?.source).toBe("cache");
    expect(offline.catalog.snapshot()?.models.map((model) => model.slug))
      .toEqual(["gpt-6-astra"]);
    expect(fetched).toBe(0);
  });

  it("isolates the persisted snapshot by account", async () => {
    const cacheFile = openAICodexCatalogCachePath(tempFile());
    const first = instance({ cacheFile });
    await first.catalog.refresh(true);

    const other = instance({ cacheFile, readCredential: async () => credential("account-b") });
    await other.catalog.restore();
    expect(other.catalog.snapshot()).toBeUndefined();
  });

  it("drops the previous account's catalog before switching", async () => {
    let account = "account-a";
    const { catalog } = instance({ readCredential: async () => credential(account) });
    await catalog.refresh(true);
    expect(catalog.snapshot()?.accountHash).toBe(openAICodexAccountHash("account-a"));
    account = "account-b";
    await catalog.refresh(true);
    expect(catalog.snapshot()?.accountHash).toBe(openAICodexAccountHash("account-b"));
  });

  it("clears the catalog when the credential disappears", async () => {
    let signedIn = true;
    const { catalog } = instance({
      readCredential: async () => signedIn ? credential("account-a") : undefined,
    });
    await catalog.refresh(true);
    expect(catalog.snapshot()).toBeDefined();
    signedIn = false;
    await catalog.refresh(true);
    expect(catalog.snapshot()).toBeUndefined();
  });

  it("keeps its snapshot when the credential store itself fails", async () => {
    let fail = false;
    const { catalog } = instance({
      readCredential: async () => {
        if (fail) throw new Error("store unavailable");
        return credential("account-a");
      },
    });
    await catalog.refresh(true);
    const snapshot = catalog.snapshot();
    fail = true;
    await catalog.refresh(true);
    expect(catalog.snapshot()).toBe(snapshot);
  });

  it("aborts the in-flight request and discards its late result", async () => {
    let settle!: (response: Response) => void;
    let observed: AbortSignal | undefined;
    const cacheFile = openAICodexCatalogCachePath(tempFile());
    const { catalog } = instance({
      cacheFile,
      fetch: (_url, init) => {
        observed = init.signal ?? undefined;
        return new Promise((resolve) => { settle = resolve });
      },
    });
    const pending = catalog.refresh(true);
    await Promise.resolve();
    catalog.dispose();
    expect(observed?.aborted).toBe(true);
    settle(catalogResponse());
    await pending;
    expect(catalog.snapshot()).toBeUndefined();
    expect(() => readFileSync(cacheFile, "utf8")).toThrow();
  });

  it("invalidates without leaving a late result able to republish the old account", async () => {
    let settle!: (response: Response) => void;
    const { catalog } = instance({
      fetch: () => new Promise((resolve) => { settle = resolve }),
    });
    const pending = catalog.refresh(true);
    await new Promise((resolve) => { setTimeout(resolve, 0) });
    catalog.invalidate();
    settle(catalogResponse());
    await pending;
    expect(catalog.snapshot()).toBeUndefined();
  });

  it("starts a new account's refresh after invalidation and ignores the old late result", async () => {
    let account = "account-a";
    let settleA!: (response: Response) => void;
    let attempts = 0;
    const { catalog } = instance({
      readCredential: async () => credential(account),
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Promise<Response>((resolve) => { settleA = resolve });
        }
        return catalogResponse([{ ...visible, slug: "gpt-b-only" }]);
      },
    });
    const pendingA = catalog.refresh(true);
    await new Promise((resolve) => { setTimeout(resolve, 0) });
    catalog.invalidate();
    account = "account-b";
    const pendingB = catalog.refresh(true);
    settleA(catalogResponse([{ ...visible, slug: "gpt-a-only" }]));
    await Promise.all([pendingA, pendingB]);
    expect(attempts).toBe(2);
    expect(catalog.snapshot()?.accountHash).toBe(openAICodexAccountHash("account-b"));
    expect(catalog.snapshot()?.models.map((model) => model.slug)).toEqual(["gpt-b-only"]);
  });

  it("resets the failure cooldown when the account is invalidated", async () => {
    let now = 1_000;
    let attempts = 0;
    const { catalog } = instance({
      retryMs: 60_000,
      now: () => now,
      fetch: async () => {
        attempts += 1;
        return attempts === 1 ? catalogResponse([], 500) : catalogResponse();
      },
    });
    await catalog.refresh();
    expect(attempts).toBe(1);
    catalog.invalidate();
    await catalog.refresh();
    expect(attempts).toBe(2);
    expect(catalog.snapshot()).toBeDefined();
  });
});

describe("catalog cache document", () => {
  it("ignores a cache written for another client version", async () => {
    const cacheFile = openAICodexCatalogCachePath(tempFile());
    writeFileSync(cacheFile, JSON.stringify({
      version: 1,
      clientVersion: "0.0.1",
      accountHash: openAICodexAccountHash("account-a"),
      fetchedAt: 1,
      models: [visible],
    }));
    const { catalog } = instance({ cacheFile });
    await catalog.restore();
    expect(catalog.snapshot()).toBeUndefined();
  });

  it("ignores a malformed cache document", async () => {
    const cacheFile = openAICodexCatalogCachePath(tempFile());
    writeFileSync(cacheFile, "{");
    const { catalog } = instance({ cacheFile });
    await catalog.restore();
    expect(catalog.snapshot()).toBeUndefined();
  });

  it("derives its file from the credential filename", () => {
    const credentialFile = tempFile();
    expect(openAICodexCatalogCachePath(credentialFile)).toBe(`${credentialFile}.models-cache.json`);
  });
});
