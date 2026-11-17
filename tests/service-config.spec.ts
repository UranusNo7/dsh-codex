import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config } from '../src/index.ts'
import { OpenAICodexService } from '../src/service.ts'
import { openAICodexAuthPath } from '../src/store.ts'

const directories: string[] = []
function isolatedHome(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-codex-service-'))
  directories.push(directory)
  vi.stubEnv('DSH_HOME', directory)
  return directory
}

const preferences = {
  modifyReadImage: true,
  shareImagegenWithOtherModels: true,
  imageGenerationModel: 'gpt-image-2' as const,
  useWebSocketContextReuse: false,
  useNativeCompaction: false,
  contextWindow: null,
  fastModeDefault: false,
  automaticModelFallback: false,
  proxyMode: 'off' as const,
  proxyUrl: '',
  modelCatalog: [],
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('credentialFile configuration seam', () => {
  it('passes the explicit credential filename into the shared service store', async () => {
    isolatedHome()
    const filename = resolve('fixture-auth.json')
    const config = new Config({ credentialFile: filename })
    const service = new OpenAICodexService({ ...preferences, credentialFile: filename })
    expect(config.credentialFile).toBe(filename)
    expect(service.credentials.filename).toBe(filename)
    await service.dispose()
  })

  it('retains the DSH_HOME-derived filename when credentialFile is absent', async () => {
    const home = isolatedHome()
    const config = new Config()
    const service = new OpenAICodexService(preferences)
    expect(config.credentialFile).toBeUndefined()
    expect(service.credentials.filename).toBe(openAICodexAuthPath())
    expect(service.credentials.filename.startsWith(home)).toBe(true)
    await service.dispose()
  })
})

describe('image model catalog projection', () => {
  it('returns built-in image models when no public catalog has been fetched', async () => {
    isolatedHome()
    const service = new OpenAICodexService(preferences)
    try {
      const settings = service.modelCatalogSettings()
      expect(settings.availableImageModels?.map((entry) => entry.id)).toEqual([
        'gpt-image-2',
        'gpt-image-2.5',
        'gpt-image-2.5-sunburst',
        'gpt-image-2.5-flare',
      ])
      expect(settings.availableImageModels?.[0]?.name).toBe(
        'GPT Image 2 (Codex default)'
      )
    } finally {
      await service.dispose()
    }
  })
})
