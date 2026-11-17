import { describe, expect, it } from "vitest";
import { Config } from "../src/index.ts";

describe("persisted image model identifiers", () => {
  it("keeps the existing default", () => {
    const model = new Config().imageGenerationModel as unknown as { get(): string };
    expect(model.get()).toBe("gpt-image-2");
  });

  it.each([
    "gpt-image-2.6-sunburst",
    "gpt-image-2.6-flare",
    "gpt-image-9-future",
  ])("loads a discovered model without a fixed build-time enum: %s", (model) => {
    const configured = new Config({ imageGenerationModel: model }).imageGenerationModel as unknown as { get(): string };
    expect(configured.get()).toBe(model);
  });

  it.each([
    "",
    "gpt-6-sol",
    "https://example.com/model",
    "gpt-image-2\nsecret",
    `gpt-image-${"a".repeat(128)}`,
  ])("rejects an unsafe or unrelated identifier", (model) => {
    expect(() => new Config({ imageGenerationModel: model })).toThrow();
  });
});
