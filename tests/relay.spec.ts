import { describe, expect, it } from 'vitest'
import {
  RELAY_USAGE_UNSUPPORTED_CODE,
  RELAY_USAGE_UNSUPPORTED_MESSAGE,
  RelayConfigError,
  RelayUsageUnsupportedError,
  normalizeRelayBaseUrl,
  relayConfigOf,
  relaySnapshotOf,
} from '../src/relay.ts'

describe('normalizeRelayBaseUrl', () => {
  it('treats empty input as direct traffic', () => {
    expect(normalizeRelayBaseUrl('')).toBeUndefined()
    expect(normalizeRelayBaseUrl('   ')).toBeUndefined()
  })

  it('accepts https and trims trailing slashes while keeping the path', () => {
    expect(normalizeRelayBaseUrl('https://relay.example.com/v1/')).toBe(
      'https://relay.example.com/v1'
    )
    expect(normalizeRelayBaseUrl('https://relay.example.com')).toBe(
      'https://relay.example.com'
    )
  })

  it('allows loopback http for tests but rejects remote http', () => {
    expect(normalizeRelayBaseUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
    expect(normalizeRelayBaseUrl('http://localhost:8787/')).toBe('http://localhost:8787')
    expect(() => normalizeRelayBaseUrl('http://relay.example.com')).toThrow(RelayConfigError)
  })

  it('rejects credentials, query, fragment, and malformed URLs with fixed messages', () => {
    for (const raw of [
      'https://user:secret@relay.example.com',
      'https://relay.example.com?x=1',
      'https://relay.example.com#frag',
      'not a url',
    ]) {
      try {
        normalizeRelayBaseUrl(raw)
        throw new Error('expected rejection')
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(RelayConfigError)
        expect((error as RelayConfigError).code).toBe('invalid-base-url')
        expect((error as Error).message).not.toContain('secret')
        expect((error as Error).message).not.toContain(raw)
      }
    }
  })
})

describe('relayConfigOf', () => {
  it('returns undefined for direct traffic', () => {
    expect(relayConfigOf({ relayBaseUrl: '', relayApiKey: '' })).toBeUndefined()
  })

  it('returns the normalized endpoint and key when both are configured', () => {
    expect(
      relayConfigOf({ relayBaseUrl: 'https://relay.example.com/', relayApiKey: ' k ' })
    ).toEqual({ baseUrl: 'https://relay.example.com', apiKey: 'k' })
  })

  it('rejects a URL without a key instead of falling back to direct or OAuth', () => {
    expect(() =>
      relayConfigOf({ relayBaseUrl: 'https://relay.example.com', relayApiKey: '' })
    ).toThrow(RelayConfigError)
    try {
      relayConfigOf({ relayBaseUrl: 'https://relay.example.com', relayApiKey: '  ' })
      throw new Error('expected rejection')
    } catch (error: unknown) {
      expect((error as RelayConfigError).code).toBe('missing-api-key')
      expect((error as Error).message).not.toContain('relay.example.com')
    }
  })
})

describe('relaySnapshotOf', () => {
  it('selects relay mode from the base URL alone and never includes the key', () => {
    const snapshot = relaySnapshotOf({
      relayBaseUrl: ' https://relay.example.com ',
      relayApiKey: 'secret',
    })
    expect(snapshot).toEqual({
      relayBaseUrl: 'https://relay.example.com',
      relayApiKeySet: true,
      enabled: true,
    })
    expect(JSON.stringify(snapshot)).not.toContain('secret')
  })

  it('keeps enabled=true with a URL but no key, so readers never fall back', () => {
    expect(
      relaySnapshotOf({ relayBaseUrl: 'https://relay.example.com', relayApiKey: '' })
    ).toEqual({
      relayBaseUrl: 'https://relay.example.com',
      relayApiKeySet: false,
      enabled: true,
    })
  })

  it('reports direct traffic for empty preferences', () => {
    expect(relaySnapshotOf({ relayBaseUrl: '', relayApiKey: 'orphan-key' })).toEqual({
      relayBaseUrl: '',
      relayApiKeySet: true,
      enabled: false,
    })
  })
})


  it('rejects header-unsafe API keys with a fixed message that never echoes them', () => {
    for (const key of [
      'key with space',
      'line\r\nbreak',
      'nul\u0000key',
      'ключ',
      'tab\tkey',
    ]) {
      try {
        relayConfigOf({ relayBaseUrl: 'https://relay.example.com', relayApiKey: key })
        throw new Error('expected rejection')
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(RelayConfigError)
        expect((error as RelayConfigError).code).toBe('invalid-api-key')
        expect((error as Error).message).not.toContain(key)
        expect((error as Error).message).not.toContain('relay.example.com')
      }
    }
  })

  it('accepts printable ASCII keys such as provider-style tokens', () => {
    expect(
      relayConfigOf({
        relayBaseUrl: 'https://relay.example.com',
        relayApiKey: 'sk-relay_123.abc-ABC',
      })
    ).toEqual({ baseUrl: 'https://relay.example.com', apiKey: 'sk-relay_123.abc-ABC' })
  })

describe('relay usage refusal', () => {
  it('carries a fixed, secret-free code and message', () => {
    const error = new RelayUsageUnsupportedError()
    expect(error.code).toBe(RELAY_USAGE_UNSUPPORTED_CODE)
    expect(error.message).toBe(RELAY_USAGE_UNSUPPORTED_MESSAGE)
  })
})
