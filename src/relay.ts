/** Third-party relay configuration shared by every OpenAI Codex transport. */

/** Raw preference strings as stored in bundle configuration. */
export interface RelayPreferences {
  relayBaseUrl: string;
  relayApiKey: string;
}

/** Browser-safe projection: never contains the configured key itself. */
export interface RelaySnapshot {
  relayBaseUrl: string;
  relayApiKeySet: boolean;
  enabled: boolean;
}

/** Normalized relay endpoint plus the credential sent only to that endpoint. */
export interface RelayConfig {
  baseUrl: string;
  apiKey: string;
}

/** Resolve the active relay, or `undefined` while direct traffic is configured. */
export type RelayResolver = () => RelayConfig | undefined

/** Why a relay preference can not be used; messages never echo inputs. */
export type RelayConfigErrorCode =
  | 'invalid-base-url'
  | 'missing-api-key'
  | 'invalid-api-key'

const RELAY_ERROR_MESSAGES: Record<RelayConfigErrorCode, string> = {
  'invalid-base-url': 'relay base URL is invalid',
  'invalid-api-key': 'relay API key contains characters that are not safe in an HTTP header',
  'missing-api-key': 'relay base URL is configured but no API key is set',
}

export class RelayConfigError extends Error {
  readonly code: RelayConfigErrorCode

  constructor(code: RelayConfigErrorCode) {
    super(RELAY_ERROR_MESSAGES[code])
    this.code = code
    this.name = 'RelayConfigError'
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Normalize a relay base URL. Empty input means direct traffic. Otherwise the
 * URL must be an https endpoint (`http` only for loopback hostnames), must not
 * carry credentials, query, or fragment, and any trailing slash is removed.
 */
export function normalizeRelayBaseUrl(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new RelayConfigError('invalid-base-url')
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new RelayConfigError('invalid-base-url')
  }
  if (url.username !== '' || url.password !== '') {
    throw new RelayConfigError('invalid-base-url')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new RelayConfigError('invalid-base-url')
  }
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${path}`
}

/**
 * Resolve the relay for one request. Direct traffic returns `undefined`.
 * When a base URL is configured without an API key this rejects explicitly
 * instead of silently falling back to OAuth or direct traffic.
 */
export function relayConfigOf(preferences: RelayPreferences): RelayConfig | undefined {
  const baseUrl = normalizeRelayBaseUrl(preferences.relayBaseUrl)
  if (baseUrl === undefined) return undefined
  const apiKey = preferences.relayApiKey.trim()
  if (apiKey.length === 0) {
    throw new RelayConfigError('missing-api-key')
  }
  // Header-safe static key: printable ASCII without spaces or control chars, so
  // a pasted CRLF/NUL/Unicode cannot make Headers/WebSocket throw the raw value.
  if (!/^[\x21-\x7E]+$/u.test(apiKey)) {
    throw new RelayConfigError('invalid-api-key')
  }
  return { baseUrl, apiKey }
}

/** Build the browser-safe snapshot; the key itself is never part of it. */
export function relaySnapshotOf(preferences: RelayPreferences): RelaySnapshot {
  const relayBaseUrl = preferences.relayBaseUrl.trim()
  return {
    relayBaseUrl,
    relayApiKeySet: preferences.relayApiKey.trim().length > 0,
    // Mode selection only: a configured URL keeps relay mode even before the
    // key is set, so the UI/auth status never falls back to direct or OAuth.
    enabled: relayBaseUrl.length > 0,
  }
}

/** Stable discriminant for usage requests that relay mode cannot serve. */
export const RELAY_USAGE_UNSUPPORTED_CODE = 'OPENAI_CODEX_RELAY_USAGE_UNSUPPORTED' as const

/** Fixed, secret-free message for the unsupported relay usage request. */
export const RELAY_USAGE_UNSUPPORTED_MESSAGE =
  'OpenAI Codex relay mode does not provide account usage; disable the relay base URL to read direct usage'

/** Raised before any network call while relay mode owns the request path. */
export class RelayUsageUnsupportedError extends Error {
  readonly code = RELAY_USAGE_UNSUPPORTED_CODE

  constructor() {
    super(RELAY_USAGE_UNSUPPORTED_MESSAGE)
    this.name = 'RelayUsageUnsupportedError'
  }
}

/** Identify the relay usage refusal without comparing messages. */
export function isRelayUsageUnsupportedError(
  error: unknown,
): error is RelayUsageUnsupportedError {
  return error instanceof RelayUsageUnsupportedError
}
