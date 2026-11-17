import { describe, expect, it } from "vitest";
import { openAICodexTuiSettingsSection } from "../src/tui-settings.ts";
import type { OpenAICodexImageModelEntry } from "../src/image-model.ts";

describe("OpenAI Codex TUI image model options", () => {
  it("uses the dynamic catalog getter each time options are read", () => {
    let models: readonly OpenAICodexImageModelEntry[] = [
      { id: "gpt-image-2", name: "GPT Image 2" },
      { id: "gpt-image-2.6-flare", name: "GPT Image 2.6 Flare" },
    ];
    const section = openAICodexTuiSettingsSection("llm-openai-codex", () => models);
    const field = section.fields.find(field => field.path[0] === "imageGenerationModel");
    expect(field?.options).toEqual([
      { value: "gpt-image-2", label: "GPT Image 2" },
      { value: "gpt-image-2.6-flare", label: "GPT Image 2.6 Flare" },
    ]);

    models = [{ id: "gpt-image-2.6-sunburst", name: "GPT Image 2.6 Sunburst" }];
    expect(field?.options).toEqual([
      { value: "gpt-image-2.6-sunburst", label: "GPT Image 2.6 Sunburst" },
    ]);
  });

  it("falls back to the built-in list when the getter is empty", () => {
    const section = openAICodexTuiSettingsSection("llm-openai-codex", () => []);
    const field = section.fields.find(field => field.path[0] === "imageGenerationModel");
    expect(field?.options).toEqual(expect.arrayContaining([
      { value: "gpt-image-2", label: "GPT Image 2 (Codex default)" },
    ]));
  });
});
