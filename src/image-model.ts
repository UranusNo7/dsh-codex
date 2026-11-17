/** Image-generation routes accepted by the current Codex subscription backend. */

/** Strict, header-safe image model id; also used for persisted preferences. */
export const IMAGE_MODEL_ID_PATTERN = /^gpt-image-[a-z0-9][a-z0-9.-]*$/

/** Any id matching the official `gpt-image-` family. */
export type OpenAICodexImageModel = `gpt-image-${string}`

/** One selectable image model with its display name. */
export interface OpenAICodexImageModelEntry {
  id: OpenAICodexImageModel
  name: string
}

/**
 * Built-in fallback list used before the public official catalog is fetched
 * and whenever that fetch fails. The default route stays `gpt-image-2`.
 */
export const OPENAI_CODEX_IMAGE_MODELS: readonly OpenAICodexImageModelEntry[] = [
  { id: "gpt-image-2", name: "GPT Image 2 (Codex default)" },
  { id: "gpt-image-2.5", name: "GPT Image 2.5" },
  { id: "gpt-image-2.5-sunburst", name: "GPT Image 2.5 Sunburst" },
  { id: "gpt-image-2.5-flare", name: "GPT Image 2.5 Flare" },
]

/** Follow the model hard-coded by the current official Codex image extension. */
export const DEFAULT_OPENAI_CODEX_IMAGE_MODEL: OpenAICodexImageModel =
  "gpt-image-2"

/** Format-only validation for persisted preferences and cache entries. */
export function isOpenAICodexImageModelId(
  value: unknown
): value is OpenAICodexImageModel {
  return typeof value === "string" && IMAGE_MODEL_ID_PATTERN.test(value)
}

/**
 * Validate a browser, TUI, or configuration value against the models that are
 * actually offered; the built-in list is the default source.
 */
export function isOpenAICodexImageModel(
  value: unknown,
  available: readonly OpenAICodexImageModelEntry[] = OPENAI_CODEX_IMAGE_MODELS
): value is OpenAICodexImageModel {
  return (
    typeof value === "string" && available.some((model) => model.id === value)
  )
}
