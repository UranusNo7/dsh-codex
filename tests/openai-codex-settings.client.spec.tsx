// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICodexSettings } from "../src/client/OpenAICodexSettings.tsx";
import { en } from "../src/client/locales.ts";
import type { OpenAICodexSettingsKey } from "../src/client/locales.ts";

function t(
  key: OpenAICodexSettingsKey,
  params: Record<string, unknown> = {}
): string {
  return Object.entries(params).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    en[key]
  );
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("OpenAI Codex settings model catalog", () => {
  it("renders model toggles and persists the provider-ordered visible subset", async () => {
    const availableModels = [
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 272_000 },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 272_000 },
    ];
    let selected = availableModels.map((model) => model.id);
    let contextWindow: number | null = null;
    let imageTools = {
      modifyReadImage: true,
      shareImagegenWithOtherModels: true,
      imageGenerationModel: "gpt-image-2",
    };
    let fastModeDefault = false;
    let automaticModelFallback = false;
    let authStatus = "signed-out";
    const fetchMock = vi.fn(
      async (
        input: string | URL | Request,
        init?: RequestInit
      ): Promise<Response> => {
        const path = String(input);
        if (path.endsWith("/auth/status"))
          return json({ status: authStatus });
        if (path.endsWith("/auth/login")) {
          authStatus = "signing-in";
          const method = (JSON.parse(String(init?.body)) as { method: string }).method;
          return json(method === "device_code"
            ? { method, verificationUri: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH" }
            : { method, url: "https://auth.openai.com/oauth/authorize" });
        }
        if (path.endsWith("/auth/cancel")) {
          authStatus = "signed-out";
          return json({ ok: true });
        }
        if (path.endsWith("/image-tools")) {
          if (init?.method === "POST") {
            imageTools = {
              ...imageTools,
              ...(JSON.parse(String(init.body)) as Partial<typeof imageTools>),
            };
          }
          return json(imageTools);
        }
        if (path.endsWith("/response-api"))
          return json({
            useWebSocketContextReuse: false,
            useNativeCompaction: false,
          });
        if (path.endsWith("/fast-mode-default")) {
          if (init?.method === "POST") {
            const patch = JSON.parse(String(init.body)) as Partial<{
              fastModeDefault: boolean;
            }>;
            if (patch.fastModeDefault !== undefined)
              fastModeDefault = patch.fastModeDefault;
          }
          return json({ fastModeDefault });
        }
        if (path.endsWith("/model-fallback")) {
          if (init?.method === "POST") {
            const patch = JSON.parse(String(init.body)) as Partial<{
              automaticModelFallback: boolean;
            }>;
            if (patch.automaticModelFallback !== undefined)
              automaticModelFallback = patch.automaticModelFallback;
          }
          return json({ automaticModelFallback });
        }
        if (path.endsWith("/context-window")) {
          if (init?.method === "POST") {
            const patch = JSON.parse(String(init.body)) as Partial<{
              contextWindow: number | null;
            }>;
            if (patch.contextWindow !== undefined)
              contextWindow = patch.contextWindow;
          }
          return json({ contextWindow });
        }
        if (path.endsWith("/models")) {
          if (init?.method === "POST")
            selected = (JSON.parse(String(init.body)) as { models: string[] })
              .models;
          return json({ availableModels, models: selected });
        }
        throw new Error(`unexpected settings request: ${path}`);
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<OpenAICodexSettings t={t} />);
    const luna = await screen.findByRole<HTMLButtonElement>("switch", {
      name: /GPT-5\.6 Luna/u,
    });
    const sol = screen.getByRole<HTMLButtonElement>("switch", {
      name: /GPT-5\.6 Sol/u,
    });
    expect(
      screen.getByRole("group", { name: "GPT-5.6 Luna" }).textContent
    ).toContain("Default window:272K tokens");
    expect(luna.getAttribute("aria-checked")).toBe("true");
    expect(sol.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(luna);
    await waitFor(() => {
      expect(luna.getAttribute("aria-checked")).toBe("false");
    });
    const modelPost = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith("/models") && init?.method === "POST"
    );
    expect(modelPost).toBeDefined();
    expect(JSON.parse(String(modelPost?.[1]?.body))).toEqual({
      models: ["gpt-5.6-sol"],
    });

    const capacity = await screen.findByRole<HTMLInputElement>("spinbutton", {
      name: en.contextWindowInput,
    });
    expect(capacity.value).toBe("");
    fireEvent.change(capacity, { target: { value: "512" } });
    fireEvent.click(screen.getByRole("button", { name: en.contextWindowSave }));
    await waitFor(() => {
      expect(contextWindow).toBe(512_000);
    });
    const contextPosts = () =>
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          String(input).endsWith("/context-window") && init?.method === "POST"
      );
    expect(JSON.parse(String(contextPosts()[0]?.[1]?.body))).toEqual({
      contextWindow: 512_000,
    });

    fireEvent.change(capacity, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: en.contextWindowSave }));
    await waitFor(() => {
      expect(contextWindow).toBeNull();
    });
    expect(JSON.parse(String(contextPosts()[1]?.[1]?.body))).toEqual({
      contextWindow: null,
    });
    expect(screen.getByText(en.contextWindowHint)).toBeDefined();

    const imageModel = await screen.findByRole<HTMLSelectElement>("combobox", {
      name: en.imageGenerationModel,
    });
    expect(imageModel.value).toBe("gpt-image-2");
    fireEvent.change(imageModel, {
      target: { value: "gpt-image-2.5-sunburst" },
    });
    await waitFor(() => {
      expect(imageTools.imageGenerationModel).toBe("gpt-image-2.5-sunburst");
      expect(imageModel.value).toBe("gpt-image-2.5-sunburst");
    });
    const imageModelPost = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith("/image-tools") && init?.method === "POST"
    );
    expect(JSON.parse(String(imageModelPost?.[1]?.body))).toEqual({
      imageGenerationModel: "gpt-image-2.5-sunburst",
    });

    // The old manual proxy card was removed from this page: the dedicated
    // Network proxy settings section owns that surface now, and rendering this
    // page must not read or post the legacy /proxy endpoint.
    expect(screen.queryByRole("radiogroup", { name: en.proxyMode })).toBeNull();
    expect(screen.queryByText(en.proxyIntro)).toBeNull();
    expect(screen.queryByRole("button", { name: en.proxySave })).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/proxy")
      )
    ).toHaveLength(0);

    const fastModeToggle = await screen.findByRole<HTMLButtonElement>(
      "switch",
      { name: en.fastModeDefault }
    );
    expect(fastModeToggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(en.fastModeDefaultHint)).toBeDefined();
    fireEvent.click(fastModeToggle);
    await waitFor(() => {
      expect(fastModeDefault).toBe(true);
      expect(fastModeToggle.getAttribute("aria-checked")).toBe("true");
    });
    const fastModePost = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith("/fast-mode-default") &&
        init?.method === "POST"
    );
    expect(JSON.parse(String(fastModePost?.[1]?.body))).toEqual({
      fastModeDefault: true,
    });

    const fallbackToggle = await screen.findByRole<HTMLButtonElement>(
      "switch",
      { name: en.automaticModelFallback }
    );
    expect(fallbackToggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(en.automaticModelFallbackHint)).toBeDefined();
    fireEvent.click(fallbackToggle);
    await waitFor(() => {
      expect(automaticModelFallback).toBe(true);
      expect(fallbackToggle.getAttribute("aria-checked")).toBe("true");
    });
    const fallbackPost = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith("/model-fallback") && init?.method === "POST"
    );
    expect(JSON.parse(String(fallbackPost?.[1]?.body))).toEqual({
      automaticModelFallback: true,
    });

    fireEvent.change(capacity, { target: { value: "1.0001" } });
    fireEvent.click(screen.getByRole("button", { name: en.contextWindowSave }));
    expect(await screen.findByText(en.contextWindowInvalid)).toBeDefined();
    expect(contextPosts()).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: en.loginBrowser }));
    const authorization = await screen.findByRole<HTMLAnchorElement>("link", { name: en.openAuthorizationPage });
    expect(authorization.href).toBe("https://auth.openai.com/oauth/authorize");
    expect(fetchMock.mock.calls.find(([input, init]) =>
      String(input).endsWith("/auth/login") && init?.method === "POST" &&
      JSON.parse(String(init.body)).method === "browser")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: en.cancelLogin }));
    await waitFor(() => { expect(authStatus).toBe("signed-out"); });
    fireEvent.click(screen.getByRole("button", { name: en.loginDeviceCode }));
    expect(await screen.findByText("ABCD-EFGH")).toBeDefined();
    expect(screen.getByRole<HTMLAnchorElement>("link", { name: "https://auth.openai.com/codex/device" }).href)
      .toBe("https://auth.openai.com/codex/device");
  });
});

interface CatalogPayload {
  availableModels: Array<{ id: string; name: string; contextWindow: number }>;
  models: string[];
  discovery?: {
    source: "official" | "cache" | "bundled" | "codex-cache";
    updatedAt?: number;
    error?: string;
  };
}

/** Mock every settings endpoint; only the catalog and its refresh vary. */
function stubSettingsFetch(
  catalog: CatalogPayload,
  refresh: () => Promise<Response> = async () => json(catalog)
) {
  const fetchMock = vi.fn(
    async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      const path = String(input);
      if (path.endsWith("/models/refresh")) return refresh();
      if (path.endsWith("/models")) return json(catalog);
      if (path.endsWith("/auth/status")) return json({ status: "signed-out" });
      if (path.endsWith("/image-tools"))
        return json({
          modifyReadImage: true,
          shareImagegenWithOtherModels: true,
          imageGenerationModel: "gpt-image-2",
        });
      if (path.endsWith("/response-api"))
        return json({
          useWebSocketContextReuse: false,
          useNativeCompaction: false,
        });
      if (path.endsWith("/fast-mode-default"))
        return json({ fastModeDefault: false });
      if (path.endsWith("/model-fallback"))
        return json({ automaticModelFallback: false });
      if (path.endsWith("/context-window")) return json({ contextWindow: null });
      throw new Error(`unexpected settings request: ${path}`);
    }
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const catalogModels = [
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 272_000 },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 272_000 },
];

function catalogModelPosts(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    ([input, init]) =>
      String(input).endsWith("/models") && init?.method === "POST"
  );
}

describe("OpenAI Codex settings dynamic catalog refresh", () => {
  it("refreshes the catalog, shows new models, and keeps the saved selection", async () => {
    const terra = {
      id: "gpt-6-terra",
      name: "GPT-6 Terra",
      contextWindow: 500_000,
    };
    const refreshed: CatalogPayload = {
      availableModels: [...catalogModels, terra],
      models: ["gpt-5.6-luna"],
      discovery: { source: "official", updatedAt: Date.UTC(2026, 0, 2, 3, 4) },
    };
    const fetchMock = stubSettingsFetch(
      { availableModels: [...catalogModels], models: ["gpt-5.6-luna"] },
      async () => json(refreshed)
    );

    render(<OpenAICodexSettings t={t} />);
    const luna = await screen.findByRole<HTMLButtonElement>("switch", {
      name: /GPT-5\.6 Luna/u,
    });
    const sol = screen.getByRole<HTMLButtonElement>("switch", {
      name: /GPT-5\.6 Sol/u,
    });
    expect(luna.getAttribute("aria-checked")).toBe("true");
    expect(sol.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(
      screen.getByRole("button", { name: en.modelCatalogRefresh })
    );
    const terraSwitch = await screen.findByRole<HTMLButtonElement>("switch", {
      name: /GPT-6 Terra/u,
    });
    expect(terraSwitch.getAttribute("aria-checked")).toBe("false");
    expect(
      screen.getByRole("switch", { name: /GPT-5\.6 Luna/u })
        .getAttribute("aria-checked")
    ).toBe("true");
    expect(
      screen.getByRole("switch", { name: /GPT-5\.6 Sol/u })
        .getAttribute("aria-checked")
    ).toBe("false");
    expect(catalogModelPosts(fetchMock)).toHaveLength(0);

    expect(
      await screen.findByText(
        t("modelCatalogSource", { source: en.modelCatalogSourceOfficial })
      )
    ).toBeDefined();
    expect(screen.getByText(/^Last updated: /u)).toBeDefined();

    const refreshCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/models/refresh")
    );
    expect(JSON.parse(String(refreshCall?.[1]?.body))).toEqual({});
    expect(refreshCall?.[1]?.method).toBe("POST");
  });

  it("disables the refresh button and model toggles while refreshing", async () => {
    let resolveRefresh: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    stubSettingsFetch(
      { availableModels: [...catalogModels], models: ["gpt-5.6-luna"] },
      () => pending
    );

    render(<OpenAICodexSettings t={t} />);
    const luna = await screen.findByRole<HTMLButtonElement>("switch", {
      name: /GPT-5\.6 Luna/u,
    });
    fireEvent.click(
      screen.getByRole("button", { name: en.modelCatalogRefresh })
    );
    const refreshing = await screen.findByRole<HTMLButtonElement>("button", {
      name: en.modelCatalogRefreshing,
    });
    expect(refreshing.disabled).toBe(true);
    expect(luna.disabled).toBe(true);

    resolveRefresh(
      json({
        availableModels: [...catalogModels],
        models: ["gpt-5.6-luna"],
        discovery: { source: "official" },
      })
    );
    await waitFor(() => {
      expect(
        screen.getByRole<HTMLButtonElement>("button", {
          name: en.modelCatalogRefresh,
        }).disabled
      ).toBe(false);
    });
    expect(
      screen.getByRole<HTMLButtonElement>("switch", {
        name: /GPT-5\.6 Luna/u,
      }).disabled
    ).toBe(false);
  });

  it("keeps the loaded models and localizes a network refresh failure", async () => {
    stubSettingsFetch(
      { availableModels: [...catalogModels], models: ["gpt-5.6-luna"] },
      async () => {
        throw new Error("network down");
      }
    );

    render(<OpenAICodexSettings t={t} />);
    await screen.findByRole("switch", { name: /GPT-5\.6 Luna/u });
    fireEvent.click(
      screen.getByRole("button", { name: en.modelCatalogRefresh })
    );
    expect(await screen.findByText(en.modelCatalogRefreshFailed)).toBeDefined();
    expect(screen.queryByText(/network down/u)).toBeNull();
    expect(
      screen.getByRole("switch", { name: /GPT-5\.6 Luna/u })
    ).toBeDefined();
    expect(
      screen.getByRole("switch", { name: /GPT-5\.6 Sol/u })
    ).toBeDefined();
  });

  it("shows the source and a localized discovery error without raw details", async () => {
    stubSettingsFetch({
      availableModels: [...catalogModels],
      models: ["gpt-5.6-luna"],
      discovery: {
        source: "cache",
        updatedAt: Date.UTC(2026, 0, 2, 3, 4),
        error: "upstream timeout",
      },
    });

    render(<OpenAICodexSettings t={t} />);
    expect(
      await screen.findByText(
        t("modelCatalogSource", { source: en.modelCatalogSourceCache })
      )
    ).toBeDefined();
    expect(screen.getByText(/^Last updated: /u)).toBeDefined();
    expect(await screen.findByText(en.modelCatalogDiscoveryError)).toBeDefined();
    expect(screen.queryByText(/upstream timeout/u)).toBeNull();
    expect(
      screen.getByRole("switch", { name: /GPT-5\.6 Luna/u })
    ).toBeDefined();
  });

  it("accepts catalog responses without discovery details", async () => {
    stubSettingsFetch(
      { availableModels: [...catalogModels], models: ["gpt-5.6-luna"] },
      async () =>
        json({
          availableModels: [...catalogModels],
          models: ["gpt-5.6-luna"],
          discovery: { source: "official", updatedAt: Date.UTC(2026, 0, 2, 3, 4) },
        })
    );

    render(<OpenAICodexSettings t={t} />);
    await screen.findByRole("switch", { name: /GPT-5\.6 Luna/u });
    expect(screen.queryByText(/^Catalog source: /u)).toBeNull();
    expect(screen.queryByText(/^Last updated: /u)).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: en.modelCatalogRefresh })
    );
    expect(
      await screen.findByText(
        t("modelCatalogSource", { source: en.modelCatalogSourceOfficial })
      )
    ).toBeDefined();
    expect(screen.getByText(/^Last updated: /u)).toBeDefined();
  });
});
