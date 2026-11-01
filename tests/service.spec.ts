import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthInteraction, Credential } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPENAI_CODEX_CATALOG_UNAVAILABLE,
  openAICodexCatalogCachePath,
  OpenAICodexOfficialCatalog,
} from "../src/model-catalog-remote.ts";
import { OpenAICodexService } from "../src/service.ts";

const mocked = vi.hoisted(() => ({
  login: vi.fn(async () => undefined),
  logout: vi.fn(async () => undefined),
  status: vi.fn(async () => ({ authenticated: true })),
}));

vi.mock("../src/auth.ts", () => ({
  loginOpenAICodex: mocked.login,
  logoutOpenAICodex: mocked.logout,
  openAICodexAuthStatus: mocked.status,
}));

const catalogModel = {
  slug: "gpt-6-astra",
  display_name: "GPT-6-Astra",
  visibility: "list",
  context_window: 272_000,
  input_modalities: ["text", "image"],
  supported_reasoning_levels: [{ effort: "low" }],
};

const directories: string[] = [];
function isolatedCredential(): string {
  const directory = mkdtempSync(join(tmpdir(), "dsh-codex-service-"));
  directories.push(directory);
  return join(directory, ".openai-codex-auth.json");
}

const preferences = {
  modifyReadImage: true,
  shareImagegenWithOtherModels: true,
  imageGenerationModel: "gpt-image-2" as const,
  useWebSocketContextReuse: false,
  useNativeCompaction: false,
  contextWindow: null,
  fastModeDefault: false,
  automaticModelFallback: false,
  proxyMode: "off" as const,
  proxyUrl: "",
  modelCatalog: [{ id: "gpt-6-astra", name: "GPT-6-Astra", contextWindow: 272_000 }],
};

interface Harness {
  service: OpenAICodexService;
  catalog: OpenAICodexOfficialCatalog;
  calls: () => number;
  reads: () => number;
  setAccount: (accountId: string | undefined) => void;
}

function harness(options: { warm?: boolean; fail?: boolean } = {}): Harness {
  const credentialFile = isolatedCredential();
  let account: string | undefined = "account-a";
  let calls = 0;
  let reads = 0;
  const catalog = new OpenAICodexOfficialCatalog({
    cacheFile: openAICodexCatalogCachePath(credentialFile),
    readCredential: async () => {
      reads += 1;
      return account === undefined
        ? undefined
        : ({
            type: "oauth",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 3_600_000,
            accountId: account,
          } as unknown as Credential);
    },
    fetch: async () => {
      calls += 1;
      return options.fail === true
        ? new Response("", { status: 503 })
        : new Response(JSON.stringify({ models: [catalogModel] }), { status: 200 });
    },
  });
  const service = new OpenAICodexService({
    ...preferences,
    credentialFile,
    officialCatalog: catalog,
    ...(options.warm === true ? { warmModelCatalog: true } : {}),
  });
  return {
    service,
    catalog,
    calls: () => calls,
    reads: () => reads,
    setAccount: (next) => { account = next; },
  };
}

async function settle(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 0) });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("service model catalog wiring", () => {
  it("does not touch credentials or the network unless warming was requested", async () => {
    const { service, calls, reads, catalog } = harness();
    await settle();
    expect(reads()).toBe(0);
    expect(calls()).toBe(0);
    expect(catalog.snapshot()).toBeUndefined();
    expect(service.modelCatalogSettings().discovery).toEqual({ source: "bundled" });
    await service.dispose();
  });

  it("adopts the persisted snapshot and applies the TTL when warming", async () => {
    const { service, calls, catalog } = harness({ warm: true });
    await settle();
    expect(calls()).toBe(1);
    expect(catalog.snapshot()?.models.map((model) => model.slug)).toEqual(["gpt-6-astra"]);
    const settings = service.modelCatalogSettings();
    expect(settings.discovery).toMatchObject({ source: "official" });
    expect(settings.discovery?.updatedAt).toBeGreaterThan(0);
    expect(settings.availableModels).toEqual([
      { id: "gpt-6-astra", name: "GPT-6-Astra", contextWindow: 272_000 },
    ]);
    await service.dispose();
  });

  it("answers a TTL refresh without a second request and forces on demand", async () => {
    const { service, calls } = harness({ warm: true });
    await settle();
    expect(calls()).toBe(1);
    await service.refreshModelCatalog(false);
    expect(calls()).toBe(1);
    await service.refreshModelCatalog(true);
    expect(calls()).toBe(2);
    await service.dispose();
  });

  it("reports a fixed sanitized reason when the official catalog fails", async () => {
    const { service } = harness({ warm: true, fail: true });
    await settle();
    await service.refreshModelCatalog(false);
    expect(service.modelCatalogSettings().discovery).toEqual({
      source: "bundled",
      error: OPENAI_CODEX_CATALOG_UNAVAILABLE,
    });
    await service.dispose();
  });

  it("adopts the catalog after login and clears it on logout", async () => {
    const { service, catalog, calls } = harness({ warm: true });
    await settle();
    expect(catalog.snapshot()).toBeDefined();
    mocked.login.mockImplementationOnce(async () => undefined);
    await service.login({} as AuthInteraction);
    await settle();
    expect(calls()).toBe(2);
    expect(catalog.snapshot()).toBeDefined();
    await service.logout();
    expect(catalog.snapshot()).toBeUndefined();
    expect(service.modelCatalogSettings().discovery).toEqual({ source: "bundled" });
    await service.dispose();
  });

  it("drops in-flight catalog work when the service is disposed", async () => {
    let settleFetch!: (response: Response) => void;
    const credentialFile = isolatedCredential();
    const catalog = new OpenAICodexOfficialCatalog({
      cacheFile: openAICodexCatalogCachePath(credentialFile),
      readCredential: async () => ({
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 3_600_000,
        accountId: "account-a",
      } as unknown as Credential),
      fetch: () => new Promise<Response>((resolve) => { settleFetch = resolve }),
    });
    const service = new OpenAICodexService({
      ...preferences,
      credentialFile,
      officialCatalog: catalog,
      warmModelCatalog: true,
    });
    await settle();
    await service.dispose();
    settleFetch(new Response(JSON.stringify({ models: [catalogModel] }), { status: 200 }));
    await settle();
    expect(catalog.snapshot()).toBeUndefined();
    expect(service.modelCatalogSettings().discovery).toEqual({ source: "bundled" });
  });
});
