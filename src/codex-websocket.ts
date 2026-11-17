/**
 * Plugin-owned Codex Responses WebSocket transport.
 *
 * pi-ai 1.3.0 reads its WebSocket implementation from `globalThis.WebSocket`
 * and exposes no request-level constructor/dispatcher seam: its `fetch` option
 * explicitly does not affect WebSocket transports. This module keeps pi-ai's
 * public HTTP path authoritative — request-body construction, `onPayload`,
 * response parsing, usage, and pricing — and replaces only the HTTP `fetch`
 * with a fetch-shaped adapter that speaks the Codex Responses WebSocket through
 * the plugin-owned proxy route (`CodexWebSocketRoute`). The SDK therefore still
 * runs its own SSE parsing and response mapping over the frames emitted here.
 *
 * Each dispatcher identity owns its sockets and continuation state. A proxy
 * preference change yields a new route, and the previous route's sockets are
 * closed instead of being reused across lines.
 */
import { zstdDecompressSync } from 'node:zlib'
import { normalizeContext } from '@earendil-works/pi-ai'
import { convertResponsesMessages } from '@earendil-works/pi-ai/api/openai-responses-shared'
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context as PiContext,
  Model,
  Provider,
  SimpleStreamOptions,
  TranscriptContext,
} from '@earendil-works/pi-ai'
import type { WebSocket as UndiciWebSocket } from 'undici'
import type { CodexWebSocketRoute } from './proxy.ts'

/** Same provider set pi-ai uses for Codex output conversion. */
const CODEX_TOOL_CALL_PROVIDERS = new Set(['openai', 'openai-codex', 'opencode'])
const OPENAI_BETA_WEBSOCKETS = 'responses_websockets=2026-02-06'
const PREVIOUS_RESPONSE_NOT_FOUND = 'previous_response_not_found'
const SOCKET_CACHE_TTL_MS = 5 * 60 * 1000
const SOCKET_MAX_AGE_MS = 55 * 60 * 1000
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000

/** Fixed, non-sensitive failure category; never carries provider text. */
export type CodexWebSocketFailure =
  | 'WS_CONNECT_FAILED'
  | 'WS_STREAM_FAILED'
  | 'WS_PROTOCOL_ERROR'
  | 'WS_IDLE_TIMEOUT'
  | 'WS_ABORTED'

/** Safe transport counters; never contains tokens, headers, or payloads. */
export interface CodexWebSocketDebugStats {
  requests: number
  connectionsCreated: number
  connectionsReused: number
  deltaRequests: number
  fullContextRequests: number
  fallbacks: number
  errors: number
  activeSockets: number
  cachedSessions: number
  lastFailure?: CodexWebSocketFailure
}

interface Continuation {
  lastRequestBody: Record<string, unknown>
  lastResponseId: string
  lastResponseItems: unknown[]
}

interface SocketEntry {
  socket: UndiciWebSocket
  /** Route that opened this socket; a retired route may not cache it. */
  routeIdentity: object
  createdAt: number
  busy: boolean
  /** A socket opened while the cached one was busy; it is never cached. */
  ephemeral?: boolean
  idleTimer?: ReturnType<typeof setTimeout>
  continuation?: Continuation
}

interface SessionState {
  sockets: Map<string, SocketEntry>
}

interface RouteState {
  sessions: Map<string, SessionState>
  /** A replaced route stops caching but lets its in-flight requests finish. */
  retired: boolean
}

interface RequestState {
  readonly route: CodexWebSocketRoute
  readonly sessionId: string
  readonly useCachedContext: boolean
  readonly connectTimeoutMs: number
  readonly idleTimeoutMs: number
  entry: SocketEntry | undefined
  fullBody: Record<string, unknown> | undefined
  synthetic: boolean
}

type StatsKey =
  | 'requests'
  | 'connectionsCreated'
  | 'connectionsReused'
  | 'deltaRequests'
  | 'fullContextRequests'
  | 'fallbacks'
  | 'errors'

function emptyStats(): CodexWebSocketDebugStats {
  return {
    requests: 0,
    connectionsCreated: 0,
    connectionsReused: 0,
    deltaRequests: 0,
    fullContextRequests: 0,
    fallbacks: 0,
    errors: 0,
    activeSockets: 0,
    cachedSessions: 0,
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Keep abort checks out of narrowing so later awaits re-read the live state. */
function isAborted(signal: AbortSignal | null | undefined): boolean {
  return signal !== undefined && signal !== null && signal.aborted
}

function positiveTimeout(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function requestUrl(input: string | URL | Request): URL | undefined {
  try {
    return new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
  } catch {
    return undefined
  }
}

function webSocketUrl(httpUrl: URL): string {
  const url = new URL(httpUrl.toString())
  if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol === 'http:') url.protocol = 'ws:'
  return url.toString()
}

/** Read the body pi-ai already built, decompressing its optional zstd envelope. */
function requestBodyOf(
  init: RequestInit | undefined,
  headers: Headers,
): Record<string, unknown> | undefined {
  const body = init?.body
  let text: string | undefined
  if (typeof body === 'string') {
    text = body
  } else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body)
    try {
      const decoded = headers.get('content-encoding') === 'zstd'
        ? zstdDecompressSync(bytes)
        : bytes
      text = new TextDecoder().decode(decoded)
    } catch {
      return undefined
    }
  }
  if (text === undefined) return undefined
  try {
    return record(JSON.parse(text))
  } catch {
    return undefined
  }
}

/** Handshake headers: keep auth/account/session/originator, drop payload-only fields. */
function handshakeHeaders(source: HeadersInit | undefined): Record<string, string> {
  const headers = new Headers(source)
  for (const name of ['accept', 'content-type', 'content-encoding', 'content-length', 'openai-beta']) {
    if (headers.has(name)) headers.delete(name)
  }
  headers.set('openai-beta', OPENAI_BETA_WEBSOCKETS)
  const result: Record<string, string> = {}
  headers.forEach((value, key) => { result[key] = value })
  return result
}

function eventType(event: Record<string, unknown>): string {
  return typeof event['type'] === 'string' ? event['type'] : ''
}

function isCompletionEvent(event: Record<string, unknown>): boolean {
  const type = eventType(event)
  return type === 'response.completed' || type === 'response.done' || type === 'response.incomplete'
}

function isPreviousResponseMissing(event: Record<string, unknown>): boolean {
  if (eventType(event) !== 'error' && eventType(event) !== 'response.failed') return false
  const nested = record(event['error'])
  const code = typeof event['code'] === 'string'
    ? event['code']
    : typeof nested?.['code'] === 'string' ? nested['code'] : undefined
  return code === PREVIOUS_RESPONSE_NOT_FOUND
}

function bodyWithoutInput(body: Record<string, unknown>): Record<string, unknown> {
  const { input: _input, ...rest } = body
  return rest
}

/*
 * The continuation delta below is derived from @earendil-works/pi-ai 1.3.0
 * (dist/api/openai-codex-responses.js: getCachedWebSocketInputDelta and
 * buildCachedWebSocketRequestBody).
 *
 * Copyright (c) 2025 Mario Zechner
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

/** One continued WebSocket turn's delta, or undefined for the full context. */
function cachedRequestBody(
  body: Record<string, unknown>,
  continuation: Continuation | undefined,
): Record<string, unknown> | undefined {
  if (continuation === undefined) return undefined
  const previous = continuation.lastRequestBody
  if (JSON.stringify(bodyWithoutInput(body)) !== JSON.stringify(bodyWithoutInput(previous))) {
    return undefined
  }
  const currentInput = Array.isArray(body['input']) ? body['input'] : []
  const baseline = [
    ...(Array.isArray(previous['input']) ? previous['input'] : []),
    ...continuation.lastResponseItems,
  ]
  if (currentInput.length < baseline.length) return undefined
  if (JSON.stringify(currentInput.slice(0, baseline.length)) !== JSON.stringify(baseline)) return undefined
  return {
    ...body,
    previous_response_id: continuation.lastResponseId,
    input: currentInput.slice(baseline.length),
  }
}

/** Rebuild the response items exactly as pi-ai does for its own continuation. */
function outputItems(model: Model<Api>, output: AssistantMessage): unknown[] {
  return convertResponsesMessages(
    model,
    normalizeContext({ messages: [output] }),
    CODEX_TOOL_CALL_PROVIDERS,
    { includeSystemPrompt: false },
  ).filter((item) => {
    const type = record(item)?.['type']
    return type !== 'function_call_output' && type !== 'custom_tool_call_output'
  })
}

interface FrameChannel {
  /** Next decoded event; rejects on abort, close, error, idle, or protocol error. */
  next(): Promise<Record<string, unknown>>
  detach(): void
}

/** Attach before `send` so no frame can be lost between connect and consumption. */
function frameChannel(
  socket: UndiciWebSocket,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number,
): FrameChannel {
  const queue: Record<string, unknown>[] = []
  let waiter: {
    resolve: (event: Record<string, unknown>) => void
    reject: (error: Error) => void
  } | undefined
  let failure: Error | undefined
  let detached = false
  let timer: ReturnType<typeof setTimeout> | undefined
  // Frames arrive as ArrayBuffer once binaryType is set; the chain keeps async
  // Blob decoding in arrival order even when the runtime ignores that hint.
  let decoding: Promise<void> = Promise.resolve()
  let pendingDecodes = 0

  try { socket.binaryType = 'arraybuffer' } catch { /* runtime may reject the hint */ }

  const clearIdle = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const armIdle = (): void => {
    clearIdle()
    if (idleTimeoutMs <= 0) return
    timer = setTimeout(() => {
      failure ??= new Error('WebSocket idle timeout')
      try { socket.close(1000, 'idle_timeout') } catch { /* already closed */ }
      flush()
    }, idleTimeoutMs)
  }
  const flush = (): void => {
    if (detached || waiter === undefined) return
    const pending = waiter
    if (queue.length > 0) {
      waiter = undefined
      armIdle()
      pending.resolve(queue.shift()!)
    } else if (failure !== undefined && pendingDecodes === 0) {
      waiter = undefined
      clearIdle()
      pending.reject(failure)
    }
  }
  const onMessage = (event: { data?: unknown }): void => {
    pendingDecodes += 1
    decoding = decoding.then(async () => {
      try {
        if (detached) return
        const parsed = await decodeFrame(event.data).catch(() => undefined)
        if (detached) return
        if (parsed === undefined) {
          failure ??= new Error('WebSocket returned an undecodable frame')
          return
        }
        queue.push(parsed)
      } finally {
        pendingDecodes -= 1
        flush()
      }
    })
  }
  const onError = (): void => {
    failure ??= new Error('WebSocket stream error')
    flush()
  }
  const onClose = (): void => {
    failure ??= new Error('WebSocket closed before completion')
    flush()
  }
  const onAbort = (): void => {
    failure ??= signal?.reason instanceof Error ? signal.reason : new Error('WebSocket aborted')
    try { socket.close(1000, 'aborted') } catch { /* already closed */ }
    flush()
  }

  socket.addEventListener('message', onMessage)
  socket.addEventListener('error', onError)
  socket.addEventListener('close', onClose)
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted === true) {
    failure = signal.reason instanceof Error ? signal.reason : new Error('WebSocket aborted')
    try { socket.close(1000, 'aborted') } catch { /* already closed */ }
  } else {
    armIdle()
  }

  return {
    next(): Promise<Record<string, unknown>> {
      if (queue.length > 0) {
        armIdle()
        return Promise.resolve(queue.shift()!)
      }
      if (failure !== undefined && pendingDecodes === 0) {
        clearIdle()
        return Promise.reject(failure)
      }
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject }
        armIdle()
      })
    },
    detach(): void {
      if (detached) return
      detached = true
      clearIdle()
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('close', onClose)
      signal?.removeEventListener('abort', onAbort)
      if (waiter !== undefined) {
        const pending = waiter
        waiter = undefined
        pending.reject(new Error('WebSocket channel closed'))
      }
    },
  }
}

/**
 * Route-aware WebSocket transport manager for the Codex provider. HTTP and
 * explicit `transport: "sse"` requests are delegated unchanged; everything
 * else runs through the current proxy route's WebSocket factory.
 */
export class CodexWebSocketTransport {
  private readonly routes = new Map<object, RouteState>()
  private readonly stats = new Map<string, CodexWebSocketDebugStats>()
  /** Every socket ever created, including CONNECTING and busy ephemerals. */
  private readonly sockets = new Set<UndiciWebSocket>()
  private activeIdentity: object | undefined
  private disposed = false

  constructor(private readonly route: () => CodexWebSocketRoute | undefined) {}

  /** Route this provider's WebSocket selections through the plugin proxy. */
  wrap(provider: Provider): Provider {
    return {
      ...provider,
      streamSimple: (model, context, options) => this.streamSimple(provider, model, context, options),
    }
  }

  /** Close every socket and drop all continuation/route state. */
  dispose(): void {
    this.disposed = true
    for (const socket of [...this.sockets]) {
      this.sockets.delete(socket)
      try { socket.close(1000, 'disposed') } catch { /* already closed */ }
    }
    for (const identity of [...this.routes.keys()]) this.closeRoute(identity)
    this.routes.clear()
    this.stats.clear()
    this.activeIdentity = undefined
  }

  /** Safe counters for one session; never returns headers, tokens, or bodies. */
  getDebugStats(sessionId: string): CodexWebSocketDebugStats {
    const stats = this.stats.get(sessionId)
    return {
      ...emptyStats(),
      ...stats,
      activeSockets: this.countSockets(),
      cachedSessions: this.stats.size,
    }
  }

  private streamSimple(
    base: Provider,
    model: Model<Api>,
    context: TranscriptContext,
    options: SimpleStreamOptions | undefined,
  ): AssistantMessageEventStream {
    // Fail closed after disposal: never silently fall back to the global
    // WebSocket that this transport exists to avoid.
    if (this.disposed) throw new Error('Codex WebSocket transport is disposed')
    const transport = options?.transport ?? 'auto'
    const route = this.route()
    if (route === undefined) {
      // Stopping/replacing the proxy retires the old route so a later return to
      // it never reuses sockets from the previous incarnation.
      if (this.activeIdentity !== undefined) {
        this.retireRoute(this.activeIdentity)
        this.activeIdentity = undefined
      }
      return base.streamSimple(model, context, options)
    }
    if (transport === 'sse') return base.streamSimple(model, context, options)
    const sessionId = options?.sessionId === undefined ? '<no-session>' : String(options.sessionId)
    const request: RequestState = {
      route,
      sessionId,
      useCachedContext: options?.cacheRetention !== 'none' && transport !== 'websocket',
      connectTimeoutMs: positiveTimeout(options?.websocketConnectTimeoutMs) || DEFAULT_CONNECT_TIMEOUT_MS,
      idleTimeoutMs: positiveTimeout(options?.timeoutMs),
      entry: undefined,
      fullBody: undefined,
      synthetic: false,
    }
    this.enterRoute(route)
    this.bump(sessionId, 'requests')

    const fetchThroughWebSocket: typeof globalThis.fetch = async (input, init) => {
      const requestSignal = init?.signal
      if (isAborted(requestSignal)) {
        this.fail(sessionId, 'WS_ABORTED')
        throw requestSignal?.reason
      }
      try {
        const response = await this.webSocketResponse(request, input, init)
        if (response !== undefined) {
          request.synthetic = true
          return response
        }
      } catch (error) {
        if (isAborted(requestSignal)) throw error
        this.fail(sessionId, 'WS_CONNECT_FAILED')
        this.bump(sessionId, 'fallbacks')
      }
      return await request.route.fetch(input, init)
    }

    const onResponse = options?.onResponse
    const stream = base.streamSimple(model, context, {
      ...options,
      transport: 'sse',
      fetch: fetchThroughWebSocket,
      ...(onResponse === undefined ? {} : {
        onResponse: (response, responseModel) => {
          // The synthetic SSE response is not an upstream HTTP response.
          if (request.synthetic) return
          return onResponse(response, responseModel)
        },
      }),
    })
    if (request.useCachedContext) {
      // Register before returning so the next turn observes this turn's state.
      void stream.result().then(
        (output) => { this.rememberContinuation(request, model, output) },
        () => undefined,
      )
    }
    return stream
  }

  private rememberContinuation(
    request: RequestState,
    model: Model<Api>,
    output: AssistantMessage,
  ): void {
    const entry = request.entry
    if (!request.synthetic || entry === undefined || request.fullBody === undefined) return
    if (output.stopReason === 'error' || output.stopReason === 'aborted') return
    if (typeof output.responseId !== 'string' || output.responseId.length === 0) return
    // Only a still-cached socket of a live route may carry continuation state.
    if (entry.ephemeral === true || this.locate(entry) === undefined) return
    if (this.routes.get(entry.routeIdentity)?.retired === true) return
    let items: unknown[]
    try {
      items = outputItems(model, output)
    } catch {
      return
    }
    entry.continuation = {
      lastRequestBody: request.fullBody,
      lastResponseId: output.responseId,
      lastResponseItems: items,
    }
  }

  private enterRoute(route: CodexWebSocketRoute): void {
    if (this.activeIdentity === route.identity) return
    if (this.activeIdentity !== undefined) this.retireRoute(this.activeIdentity)
    this.activeIdentity = route.identity
  }

  /** Stop caching on a replaced route without interrupting its in-flight calls. */
  private retireRoute(identity: object): void {
    const state = this.routes.get(identity)
    if (state === undefined) return
    state.retired = true
    for (const session of state.sessions.values()) {
      for (const [accountId, entry] of [...session.sockets]) {
        if (!entry.busy) this.closeEntry(session, accountId, entry)
      }
    }
    if (this.countRouteSockets(state) === 0) this.routes.delete(identity)
  }

  private sessions(route: CodexWebSocketRoute): RouteState {
    let state = this.routes.get(route.identity)
    if (state === undefined) {
      state = { sessions: new Map(), retired: false }
      this.routes.set(route.identity, state)
    }
    return state
  }

  private async webSocketResponse(
    request: RequestState,
    input: string | URL | Request,
    init: RequestInit | undefined,
  ): Promise<Response | undefined> {
    const url = requestUrl(input)
    if (url === undefined || (url.protocol !== 'https:' && url.protocol !== 'http:')) return undefined
    const sourceHeaders = new Headers(init?.headers)
    const body = requestBodyOf(init, sourceHeaders)
    if (body === undefined) return undefined
    request.fullBody = body
    const headers = handshakeHeaders(init?.headers)
    const accountId = headers['chatgpt-account-id'] ?? ''
    const signal = init?.signal ?? undefined
    const wsUrl = webSocketUrl(url)
    const state = this.sessions(request.route)
    let session = state.sessions.get(request.sessionId)
    if (session === undefined) {
      session = { sockets: new Map() }
      state.sessions.set(request.sessionId, session)
    }

    const attempt = async (allowRetry: boolean): Promise<Response | undefined> => {
      const acquired = await this.acquire(request, state, session, accountId, wsUrl, headers, signal)
      request.entry = acquired.entry
      const cached = request.useCachedContext
        ? cachedRequestBody(body, acquired.entry.continuation)
        : undefined
      const payload = cached ?? body
      this.bump(request.sessionId, cached === undefined ? 'fullContextRequests' : 'deltaRequests')
      const channel = frameChannel(acquired.socket, signal, request.idleTimeoutMs)
      let first: Record<string, unknown>
      try {
        acquired.socket.send(JSON.stringify({ type: 'response.create', ...payload }))
        first = await channel.next()
      } catch (error) {
        channel.detach()
        this.release(request, acquired.entry, acquired.socket, signal, false)
        // Only the SDK's own continuation-missing recovery is retried. Every
        // other first-event failure falls back to the route's HTTP fetch.
        throw error
      }
      if (allowRetry && isPreviousResponseMissing(first)) {
        delete acquired.entry.continuation
        channel.detach()
        this.release(request, acquired.entry, acquired.socket, signal, false)
        request.entry = undefined
        return await attempt(false)
      }
      return this.responseFrom(request, acquired.entry, acquired.socket, channel, first, signal)
    }

    return await attempt(true)
  }

  private async acquire(
    request: RequestState,
    state: RouteState,
    session: SessionState,
    accountId: string,
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
  ): Promise<{ socket: UndiciWebSocket; entry: SocketEntry }> {
    const now = Date.now()
    const cached = session.sockets.get(accountId)
    let cachedUsable = false
    if (cached !== undefined) {
      if (cached.idleTimer !== undefined) {
        clearTimeout(cached.idleTimer)
        delete cached.idleTimer
      }
      if (now - cached.createdAt >= SOCKET_MAX_AGE_MS || !reusable(cached.socket)) {
        this.closeEntry(session, accountId, cached)
      } else if (!cached.busy) {
        cached.busy = true
        this.bump(request.sessionId, 'connectionsReused')
        return { socket: cached.socket, entry: cached }
      } else {
        cachedUsable = true
      }
    }
    const socket = request.route.createWebSocket(url, headers)
    this.track(socket)
    try {
      await this.opened(socket, signal, request.connectTimeoutMs)
    } catch (error) {
      this.closeSocket(socket, 'connect_failed')
      throw error
    }
    // A dispose or route switch during connect must not resurrect the socket.
    if (this.disposed || this.routes.get(request.route.identity)?.retired === true) {
      this.closeSocket(socket, 'retired')
      throw new Error('Codex WebSocket route was retired during connect')
    }
    const entry: SocketEntry = {
      socket,
      routeIdentity: request.route.identity,
      createdAt: now,
      busy: true,
    }
    // closeEntry may have detached this session when it removed the expired
    // cached socket; re-attach before publishing the replacement entry.
    state.sessions.set(request.sessionId, session)
    if (cachedUsable) {
      // The cached socket is in flight; this one is per-request and never cached.
      entry.ephemeral = true
    } else {
      session.sockets.set(accountId, entry)
    }
    this.bump(request.sessionId, 'connectionsCreated')
    return { socket, entry }
  }

  /** Track every created socket so dispose can close CONNECTING/ephemeral ones. */
  private track(socket: UndiciWebSocket): void {
    this.sockets.add(socket)
    socket.addEventListener('close', () => { this.sockets.delete(socket) }, { once: true })
  }

  private closeSocket(socket: UndiciWebSocket, reason: string): void {
    this.sockets.delete(socket)
    try { socket.close(1000, reason) } catch { /* already closed */ }
  }

  private opened(
    socket: UndiciWebSocket,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<void> {
    if (socket.readyState === 1) return Promise.resolve()
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
        socket.removeEventListener('close', onClose)
        signal?.removeEventListener('abort', onAbort)
        if (error === undefined) resolve()
        else reject(error)
      }
      const onOpen = (): void => finish()
      const onError = (): void => finish(new Error('WebSocket connection failed'))
      const onClose = (): void => finish(new Error('WebSocket closed before open'))
      const onAbort = (): void => {
        this.closeSocket(socket, 'aborted')
        finish(new Error('WebSocket aborted'))
      }
      const timer = setTimeout(() => finish(new Error('WebSocket connect timeout')), timeoutMs)
      socket.addEventListener('open', onOpen)
      socket.addEventListener('error', onError)
      socket.addEventListener('close', onClose)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private responseFrom(
    request: RequestState,
    entry: SocketEntry,
    socket: UndiciWebSocket,
    channel: FrameChannel,
    first: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Response {
    const encoder = new TextEncoder()
    let finished = false
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const finish = (error?: Error): void => {
          if (finished) return
          finished = true
          channel.detach()
          if (error === undefined) {
            this.release(request, entry, socket, signal, true)
            controller.close()
          } else {
            this.fail(request.sessionId, 'WS_STREAM_FAILED')
            this.release(request, entry, socket, signal, false)
            controller.error(error)
          }
        }
        const emit = (event: Record<string, unknown>): void => {
          if (finished) return
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
          } catch {
            finish(new Error('WebSocket stream closed'))
            return
          }
          if (isCompletionEvent(event)) finish()
        }
        void (async () => {
          try {
            emit(first)
            while (!finished) {
              const event = await channel.next()
              if (finished) return
              emit(event)
            }
          } catch (error) {
            if (signal?.aborted === true) this.fail(request.sessionId, 'WS_ABORTED')
            finish(error instanceof Error ? error : new Error('WebSocket stream failed'))
          }
        })()
      },
      cancel: () => {
        if (finished) return
        finished = true
        channel.detach()
        this.release(request, entry, socket, signal, false)
      },
    })
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  private release(
    request: RequestState,
    entry: SocketEntry,
    socket: UndiciWebSocket,
    signal: AbortSignal | undefined,
    keep: boolean,
  ): void {
    const retired = this.routes.get(entry.routeIdentity)?.retired === true
    if (!keep || entry.ephemeral === true || retired || signal?.aborted === true || !reusable(socket)) {
      this.closeEntryFor(entry)
      return
    }
    entry.busy = false
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => { this.closeEntryFor(entry) }, SOCKET_CACHE_TTL_MS)
  }

  private closeEntryFor(entry: SocketEntry): void {
    delete entry.continuation
    const location = this.locate(entry)
    if (location !== undefined) this.closeEntry(location.session, location.accountId, entry)
    else {
      this.closeSocket(entry.socket, 'done')
    }
  }

  private locate(entry: SocketEntry): { session: SessionState; accountId: string } | undefined {
    for (const state of this.routes.values()) {
      for (const session of state.sessions.values()) {
        for (const [accountId, candidate] of session.sockets) {
          if (candidate === entry) return { session, accountId }
        }
      }
    }
    return undefined
  }

  private closeEntry(session: SessionState, accountId: string, entry: SocketEntry): void {
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer)
    delete entry.idleTimer
    delete entry.continuation
    this.closeSocket(entry.socket, 'done')
    if (session.sockets.get(accountId) === entry) session.sockets.delete(accountId)
    const state = this.routes.get(entry.routeIdentity)
    if (state === undefined) {
      this.pruneStats()
      return
    }
    if (session.sockets.size === 0) {
      for (const [sessionId, candidate] of state.sessions) {
        if (candidate !== session) continue
        state.sessions.delete(sessionId)
        this.pruneStats()
        break
      }
    }
    if (state.retired === true && this.countRouteSockets(state) === 0) {
      this.routes.delete(entry.routeIdentity)
    }
  }

  /** Keep diagnostics bounded even for sessions whose connect never succeeded. */
  private pruneStats(): void {
    while (this.stats.size > 256) {
      const oldest = this.stats.keys().next().value
      if (oldest === undefined) break
      this.stats.delete(oldest)
    }
  }

  private closeRoute(identity: object): void {
    const state = this.routes.get(identity)
    if (state === undefined) return
    for (const session of state.sessions.values()) {
      for (const [accountId, entry] of [...session.sockets]) {
        this.closeEntry(session, accountId, entry)
      }
    }
    state.sessions.clear()
    this.routes.delete(identity)
  }

  private countRouteSockets(state: RouteState): number {
    let count = 0
    for (const session of state.sessions.values()) count += session.sockets.size
    return count
  }

  private countSockets(): number {
    let count = 0
    for (const state of this.routes.values()) count += this.countRouteSockets(state)
    return count
  }

  private bump(sessionId: string, key: StatsKey): void {
    const stats = this.stats.get(sessionId) ?? emptyStats()
    stats[key] += 1
    this.stats.set(sessionId, stats)
    this.pruneStats()
  }

  private fail(sessionId: string, failure: CodexWebSocketFailure): void {
    const stats = this.stats.get(sessionId) ?? emptyStats()
    stats.errors += 1
    stats.lastFailure = failure
    this.stats.set(sessionId, stats)
    this.pruneStats()
  }
}

function reusable(socket: UndiciWebSocket): boolean {
  return socket.readyState === undefined || socket.readyState === 1
}

async function decodeFrame(data: unknown): Promise<Record<string, unknown> | undefined> {
  let text: string
  if (typeof data === 'string') {
    text = data
  } else if (data instanceof ArrayBuffer) {
    text = new TextDecoder().decode(new Uint8Array(data))
  } else if (data instanceof Uint8Array) {
    text = new TextDecoder().decode(data)
  } else if (typeof data === 'object' && data !== null && 'text' in data
    && typeof (data as { text: unknown }).text === 'function') {
    text = await (data as { text(): Promise<string> }).text()
  } else {
    return undefined
  }
  try {
    return record(JSON.parse(text))
  } catch {
    return undefined
  }
}