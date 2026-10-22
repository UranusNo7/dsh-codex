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
    let proxy = { proxyMode: "off", proxyUrl: "" };
    let nextProbe = async (): Promise<Record<string, unknown>> => ({
      outcome: "ok",
      status: 200,
      elapsedMs: 12,
      explicitProxy: true,
    });
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
        if (path.endsWith("/proxy")) {
          if (init?.method === "POST") {
            const patch = JSON.parse(String(init.body)) as Partial<typeof proxy>;
            proxy = { ...proxy, ...patch };
            if (patch.proxyUrl === undefined) return json(proxy);
            const connectivity = await nextProbe();
            return json({ ...proxy, connectivity });
          }
          return json(proxy);
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

    const scopedProxy = await screen.findByRole<HTMLButtonElement>("radio", {
      name: en.proxyModeScoped,
    });
    expect(scopedProxy.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(scopedProxy);
    await waitFor(() => {
      expect(proxy.proxyMode).toBe("scoped");
      expect(scopedProxy.getAttribute("aria-checked")).toBe("true");
    });
    const proxyUrl = screen.getByRole<HTMLInputElement>("textbox", {
      name: en.proxyUrl,
    });
    fireEvent.change(proxyUrl, {
      target: { value: "http://127.0.0.1:7890" },
    });
    fireEvent.click(screen.getByRole("button", { name: en.proxySave }));
    await waitFor(() => {
      expect(proxy.proxyUrl).toBe("http://127.0.0.1:7890");
    });
    const proxyPosts = fetchMock.mock.calls.filter(
      ([input, init]) =>
        String(input).endsWith("/proxy") && init?.method === "POST"
    );
    expect(JSON.parse(String(proxyPosts[0]?.[1]?.body))).toEqual({
      proxyMode: "scoped",
    });
    expect(JSON.parse(String(proxyPosts[1]?.[1]?.body))).toEqual({
      proxyUrl: "http://127.0.0.1:7890",
    });

    const proxySaveButton = screen.getByRole<HTMLButtonElement>("button", {
      name: en.proxySave,
    });
    let releaseProbe!: (value: Record<string, unknown>) => void;
    nextProbe = () =>
      new Promise((resolve) => {
        releaseProbe = resolve;
      });
    fireEvent.change(proxyUrl, {
      target: { value: "http://127.0.0.1:7891" },
    });
    fireEvent.click(proxySaveButton);
    await waitFor(() => {
      expect(proxySaveButton.textContent).toBe(en.proxyTesting);
    });
    expect(proxySaveButton.disabled).toBe(true);
    expect(proxyUrl.disabled).toBe(true);
    releaseProbe({ outcome: "ok", status: 200, elapsedMs: 9, explicitProxy: true });
    await waitFor(() => {
      expect(proxySaveButton.disabled).toBe(false);
      expect(proxySaveButton.textContent).toBe(en.proxySave);
    });
    const successMessage = await screen.findByText(/\(HTTP 200, 9 ms\)/u);
    expect(successMessage.getAttribute("role")).toBe("status");

    fireEvent.change(proxyUrl, {
      target: { value: "http://127.0.0.1:7892" },
    });
    expect(screen.queryByText(/\(HTTP 200, 9 ms\)/u)).toBeNull();

    nextProbe = async () => ({
      outcome: "http-error",
      status: 403,
      elapsedMs: 20,
      explicitProxy: true,
    });
    fireEvent.click(proxySaveButton);
    const httpAlert = await screen.findByRole("alert");
    expect(httpAlert.textContent).toContain("HTTP 403");

    nextProbe = async () => ({
      outcome: "timeout",
      elapsedMs: 10_000,
      explicitProxy: true,
    });
    fireEvent.click(proxySaveButton);
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("timed out");
    });

    nextProbe = async () => ({
      outcome: "network-error",
      elapsedMs: 5,
      explicitProxy: true,
    });
    fireEvent.click(proxySaveButton);
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "could not connect"
      );
    });

    fireEvent.click(screen.getByRole("radio", { name: en.proxyModeOff }));
    await waitFor(() => {
      expect(proxy.proxyMode).toBe("off");
    });
    expect(await screen.findByText(en.proxySaved)).toBeDefined();

    nextProbe = async () => ({
      outcome: "ok",
      status: 200,
      elapsedMs: 5,
      explicitProxy: false,
    });
    fireEvent.change(proxyUrl, { target: { value: "" } });
    fireEvent.click(proxySaveButton);
    const environmentMessage = await screen.findByText(
      /environment proxy or a direct connection/u
    );
    expect(environmentMessage.getAttribute("role")).toBe("status");
    expect(screen.getByText(en.proxyProbeEnvironment)).toBeDefined();
    expect(screen.getByText(en.proxyProbeModeOff)).toBeDefined();

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
