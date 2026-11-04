import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config } from '../src/index.ts'
import { redactSecrets } from '@deepseek-ai/dsh-settings'
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


describe('relay configuration', () => {
  it('defaults to direct traffic and keeps the key a declared secret', () => {
    const config = new Config()
    // Volatile config fields are live getters; resolve them like the plugin does.
    const live = (value: unknown): unknown =>
      typeof (value as { get?: unknown } | null)?.get === 'function'
        ? (value as { get(): unknown }).get()
        : value
    expect(live(config.relayBaseUrl)).toBe('')
    expect(live(config.relayApiKey)).toBe('')

    const redacted = redactSecrets(Config as never, {
      relayBaseUrl: 'https://relay.example.com',
      relayApiKey: 'relay-secret',
    })
    expect(JSON.stringify(redacted.value)).not.toContain('relay-secret')
    expect(redacted.secrets).toContainEqual({ path: ['relayApiKey'], set: true })
    expect(redacted.value).toMatchObject({
      relayBaseUrl: 'https://relay.example.com',
    })
  })

  it('projects relay mode without the key and refuses usage without network', async () => {
    isolatedHome()
    const service = new OpenAICodexService({
      ...preferences,
      relayBaseUrl: 'https://relay.example.com',
      relayApiKey: 'relay-secret',
    })
    try {
      expect(service.relaySnapshot()).toEqual({
        relayBaseUrl: 'https://relay.example.com',
        relayApiKeySet: true,
        enabled: true,
      })
      expect(JSON.stringify(service.relaySnapshot())).not.toContain('relay-secret')
      expect(service.relayConfig()).toEqual({
        baseUrl: 'https://relay.example.com',
        apiKey: 'relay-secret',
      })
      expect(service.usageSnapshot()).toBeUndefined()
      expect(service.modelCatalogOfficial()).toBeUndefined()
      await expect(service.usage()).rejects.toMatchObject({
        code: 'OPENAI_CODEX_RELAY_USAGE_UNSUPPORTED',
      })
      expect(await service.refreshModelCatalog(true)).toMatchObject({
        discovery: { source: 'bundled' },
      })
    } finally {
      await service.dispose()
    }
  })

  it('exposes relay mode with a URL but no key and rejects the request config', async () => {
    isolatedHome()
    const service = new OpenAICodexService({
      ...preferences,
      relayBaseUrl: 'https://relay.example.com',
      relayApiKey: '',
    })
    try {
      expect(service.relaySnapshot()).toMatchObject({ enabled: true, relayApiKeySet: false })
      expect(() => service.relayConfig()).toThrowError(
        expect.objectContaining({ code: 'missing-api-key' })
      )
    } finally {
      await service.dispose()
    }
  })

  it('keeps direct traffic unchanged when no relay is configured', async () => {
    isolatedHome()
    const service = new OpenAICodexService(preferences)
    try {
      expect(service.relaySnapshot()).toMatchObject({ enabled: false, relayApiKeySet: false })
      expect(service.relayConfig()).toBeUndefined()
      expect(typeof service.requestFetch).toBe('function')
    } finally {
      await service.dispose()
    }
  })
})
