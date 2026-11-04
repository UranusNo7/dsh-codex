/**
 * Relay-only OpenAI Codex transport.
 *
 * A third-party relay accepts the Codex Responses wire protocol with a static
 * bearer key. pi-ai's bundled Codex transport cannot serve that: it derives
 * `chatgpt-account-id` by decoding a ChatGPT JWT and always sends the official
 * endpoint, so this module implements the same wire protocol directly for the
 * relay only. The direct (first-party OAuth) branch keeps using pi-ai
 * untouched.
 *
 * One generate step binds its mode, endpoint, and key once
 * ({@link runRelayDecision}); the request path never re-resolves the relay, so
 * a configuration change cannot move a call's credential to the other
 * endpoint.
 */

import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Agent, WebSocket as UndiciWebSocket, fetch as undiciFetch } from 'undici'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Api,
  Context as PiContext,
  FetchFunction,
  Model,
  Provider,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
} from '@earendil-works/pi-ai/api/openai-responses-shared'
import type { RelayConfig } from './relay.ts'

/** pi-ai Codex-only stream knobs absent from the shared SimpleStreamOptions type. */
type RelayStreamOptions = SimpleStreamOptions & {
  readonly textVerbosity?: string
  readonly serviceTier?: 'flex' | 'priority' | string
  readonly reasoningEffort?: string
  readonly reasoningSummary?: string
}

const CODEX_TOOL_CALL_PROVIDERS = new Set(['openai', 'openai-codex', 'opencode'])

/** Placeholder key so pi-ai's auth step never asks the OAuth store in relay mode. */
export const RELAY_API_KEY_SENTINEL = 'dsh-codex-relay'

/** Fixed, credential-free failure vocabulary of the relay transport. */
export type RelayTransportErrorCode =
  | 'relay-http'
  | 'relay-redirect'
  | 'relay-protocol'
  | 'relay-continuation'
  | 'relay-unavailable'

export class RelayTransportError extends Error {
  readonly code: RelayTransportErrorCode

  constructor(code: RelayTransportErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'RelayTransportError'
  }
}

/** Fixed sanitized note printed once when a relay WebSocket falls back to SSE. */
export const RELAY_WEBSOCKET_FALLBACK_NOTE = '[dsh-codex] relay WebSocket unavailable; using SSE'

/** Exact relay Responses endpoint: the configured base already ends at codex. */
export function relayResponsesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/responses`
}

/** WebSocket endpoint derived from the exact relay Responses endpoint. */
export function relayResponsesWebSocketUrl(baseUrl: string): string {
  const url = new URL(relayResponsesUrl(baseUrl))
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

// ---------------------------------------------------------------------------
// Per-generate relay decision
// ---------------------------------------------------------------------------

/** One step's frozen transport decision: relay snapshot, direct, or refusal. */
export interface RelayDecision {
  readonly relay?: RelayConfig
  readonly error?: Error
}

const relayContext = new AsyncLocalStorage<RelayDecision>()

/**
 * Run one prepared generate step under a frozen relay decision.
 * @param decision - the decision resolved exactly once for this step.
 * @param run - the prepared stream producer.
 * @returns whatever `run` returns, with the decision visible downstream.
 */
export function runRelayDecision<T>(decision: RelayDecision, run: () => T): T {
  return relayContext.run(decision, run)
}

/** The frozen decision of the currently executing generate step, if any. */
export function currentRelayDecision(): RelayDecision | undefined {
  return relayContext.getStore()
}

// Fallback binding for runtime-only callers that never entered the adapter step.
const relaySnapshots = new WeakMap<object, RelayConfig | undefined>()

/**
 * Bind a relay snapshot to one options object for direct runtime invocation.
 * Product traffic uses {@link runRelayDecision} instead.
 * @returns the same options object for chaining.
 */
export function bindRelaySnapshot<T extends object>(options: T, relay: RelayConfig | undefined): T {
  relaySnapshots.set(options, relay)
  return options
}

/** Read the snapshot bound by the runtime entry of this call. */
export function relaySnapshotOf(options: unknown): RelayConfig | undefined {
  return typeof options === 'object' && options !== null ? relaySnapshots.get(options) : undefined
}

// ---------------------------------------------------------------------------
// Direct (proxy-bypassing) fetch and WebSocket
// ---------------------------------------------------------------------------

/** Minimal socket surface shared by undici's WebSocket and test fakes. */
export interface RelaySocketLike {
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: { code?: number; reason?: string }) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

/** Injectable transport dependencies of the relay path. */
export interface RelayTransportDeps {
  /** Direct fetch that does not use the managed proxy. */
  readonly fetch?: FetchFunction
  /** WebSocket opener; product traffic uses undici's WebSocket. */
  readonly openSocket?: (url: string, headers: Record<string, string>) => RelaySocketLike
}

/** One dedicated dispatcher so managed proxy settings never reach relay traffic. */
let relayDispatcher: Agent | undefined

/** Lazily create the relay dispatcher; a disposed one is never reused. */
function dispatcher(): Agent {
  relayDispatcher ??= new Agent()
  return relayDispatcher
}

/** Direct fetch used by every relay HTTP request. */
export function relayDirectFetch(deps: RelayTransportDeps = {}): FetchFunction {
  if (deps.fetch !== undefined) return deps.fetch
  return (input, init) =>
    undiciFetch(input as never, { ...init, dispatcher: dispatcher() } as never) as Promise<Response>
}

/** Open a relay WebSocket with a static bearer key and no JWT decoding. */
function relaySocket(
  url: string,
  headers: Record<string, string>,
  deps: RelayTransportDeps,
): RelaySocketLike {
  if (deps.openSocket !== undefined) return deps.openSocket(url, headers)
  const Socket = UndiciWebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string>; dispatcher?: unknown },
  ) => RelaySocketLike
  return new Socket(url, { headers, dispatcher: dispatcher() })
}

// ---------------------------------------------------------------------------
// Provider wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a Codex provider so a relay-decided step uses the relay transport;
 * direct steps pass through unchanged (OAuth + proxy fetch).
 */
export function withRelayTransport(provider: Provider, deps: RelayTransportDeps = {}): Provider {
  return {
    ...provider,
    streamSimple(model, context, options) {
      const decision = currentRelayDecision()
      // An explicit step decision wins: a direct step must not reuse a stale
      // options snapshot, and a refused configuration must never send traffic.
      if (decision?.error !== undefined) throw decision.error
      const relay = decision !== undefined ? decision.relay : relaySnapshotOf(options)
      if (relay === undefined) return provider.streamSimple(model, context, options)
      return streamRelayResponses(relay, deps, model, context, options)
    },
  }
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

function relayRequestBody(
  model: Model<Api>,
  context: PiContext,
  options: RelayStreamOptions | undefined,
): Record<string, unknown> {
  const compat = model.compat as
    | { supportsStrictMode?: boolean; supportsOpenAIGrammarTools?: boolean }
    | undefined
  const supportsStrictMode = compat?.supportsStrictMode ?? true
  const supportsOpenAIGrammarTools = compat?.supportsOpenAIGrammarTools ?? false
  const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
    includeSystemPrompt: false,
    toolOptions: { strict: null, supportsStrictMode, supportsOpenAIGrammarTools },
  })
  const body: Record<string, unknown> = {
    model: model.id,
    store: false,
    stream: true,
    instructions: context.systemPrompt ?? 'You are a helpful assistant.',
    input: messages,
    text: { verbosity: options?.textVerbosity ?? 'low' },
    include: ['reasoning.encrypted_content'],
    tool_choice: options?.toolChoice ?? 'auto',
    parallel_tool_calls: true,
  }
  if (options?.sessionId !== undefined) body['prompt_cache_key'] = options.sessionId
  if (options?.temperature !== undefined) body['temperature'] = options.temperature
  if (options?.serviceTier !== undefined) body['service_tier'] = options.serviceTier
  if (context.tools !== undefined && context.tools.length > 0) {
    body['tools'] = convertResponsesTools(context.tools, {
      strict: null,
      supportsStrictMode,
      supportsOpenAIGrammarTools,
    })
  }
  // Harness sends `reasoning`; pi-ai's codex option is `reasoningEffort`.
  const reasoningLevel = options?.reasoningEffort ?? options?.reasoning
  if (reasoningLevel !== undefined) {
    const effort =
      reasoningLevel === 'none'
        ? ((model.thinkingLevelMap as Partial<Record<string, string | null>> | undefined)?.['off'] ?? 'none')
        : ((model.thinkingLevelMap as Partial<Record<string, string | null>> | undefined)?.[reasoningLevel] ?? reasoningLevel)
    if (effort !== null) body['reasoning'] = { effort, summary: options?.reasoningSummary ?? 'auto' }
  }
  return body
}

/** Relay request headers: static bearer only, never a ChatGPT account id. */
export function relayRequestHeaders(
  relay: RelayConfig,
  model: Model<Api>,
  options: RelayStreamOptions | undefined,
  transport: 'sse' | 'websocket' = 'sse',
): Headers {
  const headers = new Headers(model.headers)
  for (const [key, value] of Object.entries(options?.headers ?? {})) {
    if (value === null) headers.delete(key)
    else headers.set(key, value)
  }
  // A relay must never inherit first-party account or session binding.
  headers.delete('chatgpt-account-id')
  headers.delete('cookie')
  headers.delete('authorization')
  headers.set('authorization', `Bearer ${relay.apiKey}`)
  headers.set('originator', 'dsh-codex')
  if (transport === 'sse') {
    headers.set('accept', 'text/event-stream')
    headers.set('content-type', 'application/json')
    headers.set('openai-beta', 'responses=experimental')
    if (options?.sessionId !== undefined) {
      headers.set('session-id', options.sessionId)
      headers.set('thread-id', options.sessionId)
      headers.set('x-client-request-id', options.sessionId)
    }
  } else {
    headers.delete('accept')
    headers.delete('content-type')
    headers.delete('openai-beta')
    headers.set('openai-beta', 'responses_websockets=2026-02-06')
    if (options?.sessionId !== undefined) {
      headers.set('session-id', options.sessionId)
      headers.set('x-client-request-id', options.sessionId)
    }
  }
  return headers
}

// ---------------------------------------------------------------------------
// Event adaptation
// ---------------------------------------------------------------------------

const CODEX_RESPONSE_STATUSES = new Set([
  'completed',
  'failed',
  'in_progress',
  'cancelled',
  'queued',
  'incomplete',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function codexStatus(status: unknown): string | undefined {
  return typeof status === 'string' && CODEX_RESPONSE_STATUSES.has(status) ? status : undefined
}

/** Codex event normalization shared by the SSE and WebSocket readers. */
function normalizeCodexEvent(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const type = event['type']
  if (type === 'error') {
    // Upstream text is untrusted and may echo the credential: never surface it.
    throw new RelayTransportError('relay-protocol', 'relay stream reported an error')
  }
  if (type === 'response.failed') {
    throw new RelayTransportError('relay-protocol', 'relay stream reported a failure')
  }
  if (type === 'response.done' || type === 'response.completed' || type === 'response.incomplete') {
    const response = event['response']
    const normalized = isRecord(response)
      ? { ...response, status: codexStatus(response['status']) }
      : response
    return { ...event, type: 'response.completed', response: normalized }
  }
  return event
}

async function* mapCodexEvents(events: AsyncIterable<unknown>): AsyncIterable<Record<string, unknown>> {
  for await (const item of events) {
    if (!isRecord(item)) continue
    const normalized = normalizeCodexEvent(item)
    if (normalized === undefined) continue
    yield normalized
    if (normalized['type'] === 'response.completed') return
  }
}

function resolveServiceTier(responseTier: unknown, requestTier: unknown): unknown {
  if (responseTier === 'default' && (requestTier === 'flex' || requestTier === 'priority')) {
    return requestTier
  }
  return responseTier ?? requestTier
}

function buildOutput(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-codex-responses',
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'pending',
    timestamp: Date.now(),
  } as AssistantMessage
}

function fixedErrorMessage(error: unknown): string {
  if (error instanceof RelayTransportError) return error.message
  return 'OpenAI Codex relay request failed'
}

function finish(
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  options: RelayStreamOptions | undefined,
): void {
  if (options?.signal?.aborted === true) {
    output.stopReason = 'aborted'
    stream.push({ type: 'error', reason: 'aborted', error: output } as never)
    stream.end()
    return
  }
  if (output.stopReason === 'pending') {
    throw new RelayTransportError('relay-protocol', 'relay stream ended before response.completed')
  }
  stream.push({ type: 'done', reason: output.stopReason, message: output } as never)
  stream.end()
}

/**
 * One relay generate call: request, stream, and adapt for pi-ai.
 * @returns the pi-ai event stream for the caller.
 */
export function streamRelayResponses(
  relay: RelayConfig,
  deps: RelayTransportDeps,
  model: Model<Api>,
  context: PiContext,
  options?: RelayStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  const output = buildOutput(model)
  void (async () => {
    try {
      let body = relayRequestBody(model, context, options)
      const replaced = await options?.onPayload?.(body, model)
      if (replaced !== undefined) body = replaced as Record<string, unknown>
      if (!isRecord(body)) throw new RelayTransportError('relay-protocol', 'relay request body is invalid')
      const websocketPreferred =
        options?.transport === 'websocket-cached' || options?.transport === 'websocket'
      if (websocketPreferred) {
        // A rejected continuation retries once with the full input; only a
        // connection failure may fall back to SSE, and never after content was
        // published (a retry would repeat output).
        let allowContinuation = true
        while (true) {
          const state: WebSocketAttempt = { emitted: false, continuation: false }
          try {
            await processRelayWebSocket(relay, deps, body, output, stream, model, options, state, allowContinuation)
            finish(output, stream, options)
            return
          } catch (error) {
            if (options?.signal?.aborted === true || state.emitted) throw error
            if (!isRetryableWebSocketFailure(error)) throw error
            if (state.continuation) {
              allowContinuation = false
              continue
            }
            console.warn(RELAY_WEBSOCKET_FALLBACK_NOTE)
            break
          }
        }
      }
      await processRelaySse(relay, deps, body, output, stream, model, options)
      finish(output, stream, options)
    } catch (error) {
      const aborted = options?.signal?.aborted === true
      output.stopReason = aborted ? 'aborted' : 'error'
      output.errorMessage = aborted ? 'Request was aborted' : fixedErrorMessage(error)
      stream.push({ type: 'error', reason: output.stopReason, error: output } as never)
      stream.end()
    }
  })()
  return stream
}

/** Connection loss or a rejected continuation may be retried safely. */
function isRetryableWebSocketFailure(error: unknown): boolean {
  return error instanceof RelayTransportError &&
    (error.code === 'relay-unavailable' || error.code === 'relay-continuation')
}

/** State of one WebSocket attempt, shared with the retry decision. */
interface WebSocketAttempt {
  /** Whether any start/content event was already published downstream. */
  emitted: boolean
  /** Whether this attempt sent a previous_response_id continuation. */
  continuation: boolean
}

function combinedSignal(options: SimpleStreamOptions | undefined): AbortSignal | undefined {
  if (options?.timeoutMs === undefined || options.timeoutMs <= 0) return options?.signal
  const timeout = AbortSignal.timeout(options.timeoutMs)
  return options?.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
}

async function processRelaySse(
  relay: RelayConfig,
  deps: RelayTransportDeps,
  body: Record<string, unknown>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  options: RelayStreamOptions | undefined,
): Promise<void> {
  const fetch = relayDirectFetch(deps)
  const headers = relayRequestHeaders(relay, model, options)
  const signal = combinedSignal(options)
  const response = await fetch(relayResponsesUrl(relay.baseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'manual',
    ...(signal === undefined ? {} : { signal }),
  })
  await options?.onResponse?.(
    { status: response.status, headers: headersToRecord(response.headers) },
    model,
  )
  if (response.status === 0 || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => undefined)
    throw new RelayTransportError('relay-redirect', 'relay redirect refused')
  }
  if (!response.ok) {
    // The upstream body is not read: it may echo the relay key. Cancelling it
    // releases the connection instead of leaking it with retries.
    await response.body?.cancel().catch(() => undefined)
    throw new RelayTransportError('relay-http', `relay request failed with HTTP ${response.status}`)
  }
  if (response.body === null) {
    throw new RelayTransportError('relay-protocol', 'relay response has no body')
  }
  stream.push({ type: 'start', partial: output })
  await processResponsesStream(
    mapCodexEvents(parseSse(response, options?.signal)) as never,
    output,
    stream,
    model,
    { serviceTier: options?.serviceTier, resolveServiceTier } as never,
  )
}

async function processRelayWebSocket(
  relay: RelayConfig,
  deps: RelayTransportDeps,
  body: Record<string, unknown>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  options: RelayStreamOptions | undefined,
  state: WebSocketAttempt,
  allowContinuation: boolean,
): Promise<void> {
  const headers = relayRequestHeaders(relay, model, options, 'websocket')
  const identity = socketIdentity(relay, options?.sessionId)
  let entry: SocketEntry
  try {
    entry = acquireSocket(identity, relay, headers, deps)
  } catch (error) {
    throw new RelayTransportError('relay-unavailable', fixedErrorMessage(error))
  }
  // Listeners are installed before the first frame so a fast reply is queued,
  // and a fresh undici socket is allowed to finish CONNECTING before send.
  const reader = attachSocket(entry.socket, options?.signal, options?.timeoutMs)
  try {
    if (!entry.ready) {
      await reader.opened
      entry.ready = true
    }
    const fullInput = Array.isArray(body['input']) ? body['input'] as unknown[] : undefined
    const previous = entry.context
    let requestBody = body
    if (
      allowContinuation &&
      previous !== undefined &&
      fullInput !== undefined &&
      exactInputPrefix(previous.input, fullInput)
    ) {
      requestBody = {
        ...body,
        input: fullInput.slice(previous.input.length),
        previous_response_id: previous.responseId,
      }
      state.continuation = true
    }
    const captured: { responseId?: string } = {}
    let started = false
    const events = startOnFirstEvent(
      captureResponseId(reader.events, captured),
      () => {
        started = true
        state.emitted = true
        stream.push({ type: 'start', partial: output })
      },
    )
    try {
      // Codex WebSocket frames carry the event envelope, unlike the SSE body.
      entry.socket.send(JSON.stringify({ type: 'response.create', ...requestBody }))
      await processResponsesStream(
        mapCodexEvents(events) as never,
        output,
        stream,
        model,
        { serviceTier: options?.serviceTier, resolveServiceTier } as never,
      )
    } catch (error) {
      if (state.continuation && !started && options?.signal?.aborted !== true) {
        throw new RelayTransportError('relay-continuation', 'relay continuation rejected')
      }
      throw error
    }
    if (captured.responseId !== undefined && fullInput !== undefined) {
      entry.context = { responseId: captured.responseId, input: fullInput }
    }
  } finally {
    reader.close()
    releaseSocket(identity, entry.socket)
  }
}

/** Exact-prefix test: continuation is only safe over the identical history. */
function exactInputPrefix(previous: readonly unknown[], next: readonly unknown[]): boolean {
  if (previous.length === 0 || previous.length > next.length) return false
  for (let index = 0; index < previous.length; index += 1) {
    if (JSON.stringify(previous[index]) !== JSON.stringify(next[index])) return false
  }
  return true
}

/** Publish `start` together with the first real event, like pi-ai's WS path. */
async function* startOnFirstEvent(
  events: AsyncIterable<Record<string, unknown>>,
  onStart: () => void,
): AsyncIterable<Record<string, unknown>> {
  let started = false
  for await (const event of events) {
    if (!started) {
      started = true
      onStart()
    }
    yield event
  }
}

/** Capture the response id that the next continuation will reference. */
async function* captureResponseId(
  events: AsyncIterable<Record<string, unknown>>,
  captured: { responseId?: string },
): AsyncIterable<Record<string, unknown>> {
  for await (const event of events) {
    const response = event['response']
    if (isRecord(response) && typeof response['id'] === 'string') captured.responseId = response['id']
    yield event
  }
}

// ---------------------------------------------------------------------------
// SSE reader
// ---------------------------------------------------------------------------

async function* parseSse(response: Response, signal: AbortSignal | undefined): AsyncIterable<unknown> {
  if (response.body === null) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal?.aborted === true) {
        throw new RelayTransportError('relay-unavailable', 'Request was aborted')
      }
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      if (done && buffer.trim().length > 0) buffer += '\n\n'
      let index = buffer.indexOf('\n\n')
      while (index !== -1) {
        const chunk = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const data = chunk
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trim())
          .join('\n')
          .trim()
        if (data.length > 0 && data !== '[DONE]') {
          let parsed: unknown
          try {
            parsed = JSON.parse(data)
          } catch {
            throw new RelayTransportError('relay-protocol', 'relay stream sent invalid JSON')
          }
          yield parsed
        }
        index = buffer.indexOf('\n\n')
      }
      if (done) break
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // The stream may already be closed.
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket reader and identity-scoped reuse
// ---------------------------------------------------------------------------

/** Continuation state of one reusable connection. */
interface SocketContext {
  readonly responseId: string
  readonly input: readonly unknown[]
}

interface SocketEntry {
  readonly identity: string
  readonly socket: RelaySocketLike
  busy: boolean
  openedAt: number
  /** Whether this socket reported open; a reused socket is already open. */
  ready: boolean
  context?: SocketContext | undefined
}

const socketCache = new Map<string, SocketEntry>()
const SOCKET_IDLE_LIMIT_MS = 10 * 60 * 1000

/** Identity of one reusable relay connection: endpoint + key + session. */
function socketIdentity(relay: RelayConfig, sessionId: string | undefined): string {
  const keyId = createHash('sha256').update(relay.apiKey).digest('hex').slice(0, 16)
  return `${relayResponsesWebSocketUrl(relay.baseUrl)}|${keyId}|${sessionId ?? ''}`
}

function acquireSocket(
  identity: string,
  relay: RelayConfig,
  headers: Headers,
  deps: RelayTransportDeps,
): SocketEntry {
  const cached = socketCache.get(identity)
  if (cached !== undefined && !cached.busy && !isExpired(cached)) {
    cached.busy = true
    return cached
  }
  if (cached !== undefined && isExpired(cached)) {
    closeSocket(cached.socket)
    socketCache.delete(identity)
  }
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    record[key] = value
  })
  const socket = relaySocket(relayResponsesWebSocketUrl(relay.baseUrl), record, deps)
  const entry: SocketEntry = { identity, socket, busy: true, openedAt: Date.now(), ready: false }
  socketCache.set(identity, entry)
  // Bounded teardown: an idle connection never outlives the reuse window.
  const expiry = setTimeout(() => {
    if (entry.busy) return
    if (socketCache.get(identity) !== entry) return
    socketCache.delete(identity)
    closeSocket(entry.socket)
  }, SOCKET_IDLE_LIMIT_MS)
  expiry.unref?.()
  return entry
}

function releaseSocket(identity: string, socket: RelaySocketLike): void {
  const entry = socketCache.get(identity)
  if (entry === undefined || entry.socket !== socket) return
  entry.busy = false
}

function isExpired(entry: SocketEntry): boolean {
  return Date.now() - entry.openedAt > SOCKET_IDLE_LIMIT_MS
}

function closeSocket(socket: RelaySocketLike): void {
  try {
    socket.close(1000, 'done')
  } catch {
    // A closed socket needs no further action.
  }
}

interface SocketReader {
  /** Resolves once the socket reported open. */
  readonly opened: Promise<void>
  /** Events, including frames received while the socket is still opening. */
  readonly events: AsyncIterable<Record<string, unknown>>
  /** Remove every listener and the connect timer. */
  close(): void
}

/**
 * Attach message/error/close listeners before the first send, so a reply that
 * arrives immediately is queued instead of lost, and wait-ready is explicit.
 */
function attachSocket(
  socket: RelaySocketLike,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): SocketReader {
  const queue: Record<string, unknown>[] = []
  let wake: (() => void) | undefined
  let failure: RelayTransportError | undefined
  let closed = false
  let opened = false
  const settled = Promise.withResolvers<void>()
  const notify = (): void => {
    const resolve = wake
    wake = undefined
    resolve?.()
  }
  const fail = (error: RelayTransportError): void => {
    failure ??= error
    settled.reject(failure)
    notify()
  }
  const timer = timeoutMs !== undefined && timeoutMs > 0
    ? setTimeout(() => fail(new RelayTransportError('relay-unavailable', 'relay WebSocket connect timeout')), timeoutMs)
    : undefined
  timer?.unref?.()
  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer)
  }
  socket.onopen = () => {
    opened = true
    clear()
    settled.resolve()
    notify()
  }
  socket.onmessage = event => {
    try {
      const text = typeof event.data === 'string' ? event.data : null
      if (text === null) throw new RelayTransportError('relay-protocol', 'relay stream sent an unsupported frame')
      const parsed: unknown = JSON.parse(text)
      if (!isRecord(parsed)) throw new RelayTransportError('relay-protocol', 'relay stream sent invalid JSON')
      queue.push(parsed)
    } catch (error) {
      failure =
        error instanceof RelayTransportError
          ? error
          : new RelayTransportError('relay-protocol', 'relay stream sent invalid JSON')
    }
    notify()
  }
  socket.onerror = () => {
    fail(new RelayTransportError('relay-unavailable', 'relay WebSocket failed'))
  }
  socket.onclose = () => {
    closed = true
    if (!opened) fail(new RelayTransportError('relay-unavailable', 'relay WebSocket closed before open'))
    notify()
  }
  const onAbort = (): void => {
    fail(new RelayTransportError('relay-unavailable', 'Request was aborted'))
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  // The connnect promise may be awaited only for a fresh socket; avoid an
  // unhandled rejection when a reused socket never reads it.
  settled.promise.catch(() => undefined)

  async function* events(): AsyncIterable<Record<string, unknown>> {
    try {
      while (true) {
        if (signal?.aborted === true) {
          throw new RelayTransportError('relay-unavailable', 'Request was aborted')
        }
        if (failure !== undefined) throw failure
        if (queue.length === 0) {
          if (closed) {
            throw new RelayTransportError('relay-protocol', 'relay stream closed before response.completed')
          }
          await new Promise<void>(resolve => {
            wake = resolve
          })
          continue
        }
        const next = queue.shift()
        if (next === undefined) continue
        yield next
        if (next['type'] === 'response.completed') return
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  return {
    opened: settled.promise,
    events: events(),
    close(): void {
      clear()
      signal?.removeEventListener('abort', onAbort)
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      socket.onopen = null
    },
  }
}

/** Close every cached relay socket; used by product teardown and tests. */
export function closeRelaySockets(): void {
  for (const entry of socketCache.values()) closeSocket(entry.socket)
  socketCache.clear()
}

/**
 * Release every relay transport resource on product unload: cached sockets
 * and the dedicated dispatcher. Safe to call more than once.
 */
export function disposeRelayTransport(): void {
  closeRelaySockets()
  activeRelayMode = undefined
  // Detach the current dispatcher first: a later apply builds a fresh one,
  // so a closed Agent is never reused after plugin unload.
  const current = relayDispatcher
  relayDispatcher = undefined
  if (current === undefined) return
  try {
    void current.close().catch(() => undefined)
  } catch {
    // An already closed dispatcher needs no further action.
  }
}

let activeRelayMode: string | undefined

/**
 * Record the frozen mode of one generate step. A mode or key/endpoint change
 * drops every reusable continuation context, so a later request starts from a
 * full input instead of continuing another identity's conversation.
 */
export function recordRelayMode(relay: RelayConfig | undefined): void {
  const mode = relay === undefined
    ? 'direct'
    : `${relay.baseUrl}|${createHash('sha256').update(relay.apiKey).digest('hex').slice(0, 16)}`
  if (mode === activeRelayMode) return
  activeRelayMode = mode
  for (const entry of socketCache.values()) entry.context = undefined
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    record[key] = value
  })
  return record
}
