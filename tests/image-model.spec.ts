import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OPENAI_CODEX_IMAGE_MODEL,
  IMAGE_MODEL_ID_PATTERN,
  OPENAI_CODEX_IMAGE_MODELS,
  isOpenAICodexImageModel,
  isOpenAICodexImageModelId,
} from '../src/image-model.ts'

describe('image model ids', () => {
  it('accepts only strict gpt-image ids', () => {
    expect(IMAGE_MODEL_ID_PATTERN.test('gpt-image-2')).toBe(true)
    expect(IMAGE_MODEL_ID_PATTERN.test('gpt-image-2.6-sunburst')).toBe(true)
    expect(IMAGE_MODEL_ID_PATTERN.test('gpt-image-')).toBe(false)
    expect(IMAGE_MODEL_ID_PATTERN.test('gpt-image-2/../x')).toBe(false)
    expect(IMAGE_MODEL_ID_PATTERN.test('GPT-IMAGE-2')).toBe(false)
    expect(IMAGE_MODEL_ID_PATTERN.test('gpt-5.6-sol')).toBe(false)
    expect(isOpenAICodexImageModelId('gpt-image-2.6-flare')).toBe(true)
    expect(isOpenAICodexImageModelId('not-an-image-model')).toBe(false)
  })

  it('keeps the built-in fallback and the Codex default unchanged', () => {
    expect(DEFAULT_OPENAI_CODEX_IMAGE_MODEL).toBe('gpt-image-2')
    expect(OPENAI_CODEX_IMAGE_MODELS.map((entry) => entry.id)).toEqual([
      'gpt-image-2',
      'gpt-image-2.5',
      'gpt-image-2.5-sunburst',
      'gpt-image-2.5-flare',
    ])
    for (const entry of OPENAI_CODEX_IMAGE_MODELS) {
      expect(isOpenAICodexImageModelId(entry.id)).toBe(true)
      expect(isOpenAICodexImageModel(entry.id, OPENAI_CODEX_IMAGE_MODELS)).toBe(true)
    }
  })

  it('validates a value against the actually available list', () => {
    const available = [
      { id: 'gpt-image-2.6-flare' as const, name: 'GPT Image 2.6 Flare' },
    ]
    expect(isOpenAICodexImageModel('gpt-image-2.6-flare', available)).toBe(true)
    expect(isOpenAICodexImageModel('gpt-image-2', available)).toBe(false)
    expect(isOpenAICodexImageModel('gpt-image-2.6-flare')).toBe(false)
    expect(isOpenAICodexImageModel('gpt-image-2')).toBe(true)
  })
})
