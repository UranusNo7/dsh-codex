import { describe, expect, it } from 'vitest'
import { normalizeContext } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { CodexWebSocketTransport } from '../src/codex-websocket.ts'
import { OpenAICodexResponseRuntime } from '../src/responses.ts'
import type { CodexWebSocketRoute } from '../src/proxy.ts'

function accessToken(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })}.signature`
}

type Listener = (event: Record<string, unknown>) => void

/** Minimal undici-WebSocket-shaped double driven by a scripted frame list. */
class FakeSocket extends EventTarget {
  readyState = 0
  binaryType: string | undefined
  readonly sent: string[] = []
  closed = false
  onSend?: (payload: Record<string, unknown>) => void

  send(text: string): void {
    this.sent.push(text)
    this.onSend?.(JSON.parse(text) as Record<string, unknown>)
  }

  open(): void {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }

  message(event: Record<string, unknown>): void {
    const frame = new Event('message') as Event & { data?: unknown }
    frame.data = JSON.stringify(event)
    this.dispatchEvent(frame)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }

  /** Keep listeners inspectable for leak assertions. */
  listenerCount(type: string): number {
    void type
    return (this as unknown as { listeners?: Map<string, Set<Listener>> }).listeners?.size ?? 0
  }
}

interface SocketScript {
  /** Frames emitted after each `response.create`; the first frame is scripted by the test. */
  onSend?: (socket: FakeSocket, payload: Record<string, unknown>) => void
  failOnOpen?: boolean
  /** Leave the socket CONNECTING forever so disposal has to close it. */
  keepConnecting?: boolean
}

function scriptedSocket(script: SocketScript = {}): FakeSocket {
  const socket = new FakeSocket()
  socket.onSend = (payload) => { script.onSend?.(socket, payload) }
  queueMicrotask(() => {
    if (script.keepConnecting === true) return
    if (script.failOnOpen === true) {
      socket.dispatchEvent(new Event('error'))
      socket.close()
      return
    }
    socket.open()
  })
  return socket
}

interface RouteHarness {
  route: CodexWebSocketRoute
  transport: CodexWebSocketTransport
  sockets: FakeSocket[]
  fetches: Array<{ url: string; init?: RequestInit }>
  responses: Response[]
}

function harness(options: {
  identity?: object
  script?: SocketScript
  fetchResponse?: () => Response
} = {}): RouteHarness {
  const identity = options.identity ?? {}
  const sockets: FakeSocket[] = []
  const fetches: Array<{ url: string; init?: RequestInit }> = []
  const responses: Response[] = []
  const route: CodexWebSocketRoute = {
    identity,
    fetch: async (input, init) => {
      fetches.push({ url: String(input), ...(init === undefined ? {} : { init }) })
      const response = options.fetchResponse?.() ?? new Response('', { status: 500 })
      responses.push(response)
      return response
    },
    createWebSocket: (url, headers) => {
      void url
      void headers
      const socket = scriptedSocket(options.script)
      sockets.push(socket)
      return socket as unknown as ReturnType<CodexWebSocketRoute['createWebSocket']>
    },
  }
  return {
    route,
    transport: new CodexWebSocketTransport(() => route),
    sockets,
    fetches,
    responses,
  }
}

function model(): ReturnType<ReturnType<typeof openaiCodexProvider>['getModels']>[number] {
  const provider = openaiCodexProvider()
  const found = provider.getModels().find((entry) => entry.id === 'gpt-5.6-sol')
  if (found === undefined) throw new Error('Codex provider has no test model')
  return found
}

const provider = openaiCodexProvider()

function user(text: string) {
  return { role: 'user' as const, content: [{ type: 'text' as const, text }], timestamp: 1 }
}

function completed(id: string, output: unknown[] = []): Record<string, unknown> {
  return {
    type: 'response.completed',
    response: { id, status: 'completed', output, usage: {} },
  }
}

function created(id: string): Record<string, unknown> {
  return { type: 'response.created', response: { id, status: 'in_progress', output: [], usage: null } }
}

describe('CodexWebSocketTransport', () => {
  it('sends response.create over the route socket and reuses it for cached deltas', async () => {
    const h = harness({
      script: {
        onSend(socket, payload) {
          const turn = socket.sent.length
          if (turn === 1) {
            socket.message(created('resp_1'))
            socket.message({
              type: 'response.output_item.done',
              output_index: 0,
              item: {
                type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
                content: [{ type: 'output_text', text: 'first answer' }],
              },
            })
            socket.message(completed('resp_1'))
          } else {
            socket.message(created('resp_2'))
            socket.message({
              type: 'response.output_item.done',
              output_index: 0,
              item: {
                type: 'message', id: 'msg_2', role: 'assistant', status: 'completed',
                content: [{ type: 'output_text', text: 'second answer' }],
              },
            })
            socket.message(completed('resp_2'))
          }
          void payload
        },
      },
    })
    const wrapped = h.transport.wrap(provider)
    const options = {
      transport: 'websocket-cached' as const,
      sessionId: 'session-delta',
      apiKey: accessToken('account-a'),
    }
    const first = await wrapped.streamSimple(
      model(), normalizeContext({ messages: [user('one')] }), options,
    ).result()
    expect(first.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)).toEqual(['first answer'])
    expect(h.sockets).toHaveLength(1)
    expect(h.fetches).toHaveLength(0)

    await wrapped.streamSimple(
      model(),
      normalizeContext({
        messages: [user('one'), first, user('two')],
      }),
      options,
    ).result()

    expect(h.sockets).toHaveLength(1)
    const second = JSON.parse(h.sockets[0]!.sent[1]!) as Record<string, unknown>
    expect(second['type']).toBe('response.create')
    expect(second['previous_response_id']).toBe('resp_1')
    expect(second['input']).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'two' }] },
    ])
    expect(h.transport.getDebugStats('session-delta')).toMatchObject({
      requests: 2,
      connectionsCreated: 1,
      connectionsReused: 1,
      deltaRequests: 1,
      fullContextRequests: 1,
      fallbacks: 0,
    })
    expect(h.transport.getDebugStats('session-delta').lastFailure).toBeUndefined()
    h.transport.dispose()
  })

  it('keeps routes isolated: a new identity gets a new socket and closes the old idle one', async () => {
    let identity: object = {}
    const sockets: FakeSocket[] = []
    const route = (): CodexWebSocketRoute => ({
      identity,
      fetch: async () => new Response('', { status: 500 }),
      createWebSocket: () => {
        const socket = scriptedSocket({
          onSend(s) {
            s.message(created('resp_route'))
            s.message(completed('resp_route'))
          },
        })
        sockets.push(socket)
        return socket as unknown as ReturnType<CodexWebSocketRoute['createWebSocket']>
      },
    })
    const transport = new CodexWebSocketTransport(route)
    const wrapped = transport.wrap(provider)
    const options = {
      transport: 'websocket-cached' as const,
      sessionId: 'session-route',
      apiKey: accessToken('account-a'),
    }
    await wrapped.streamSimple(model(), normalizeContext({ messages: [user('one')] }), options).result()
    expect(sockets).toHaveLength(1)
    identity = {}
    await wrapped.streamSimple(model(), normalizeContext({ messages: [user('one')] }), options).result()
    expect(sockets).toHaveLength(2)
    expect(sockets[0]!.closed).toBe(true)
    expect(sockets[1]!.closed).toBe(false)
    transport.dispose()
    expect(sockets[1]!.closed).toBe(true)
  })

  it('falls back to the same route fetch before the first event', async () => {
    const h = harness({
      script: { failOnOpen: true },
      fetchResponse: () => new Response('', { status: 500 }),
    })
    const wrapped = h.transport.wrap(provider)
    const options = {
      transport: 'websocket-cached' as const,
      sessionId: 'session-fallback',
      apiKey: accessToken('account-a'),
    }
    const message = await wrapped.streamSimple(
      model(), normalizeContext({ messages: [user('one')] }), options,
    ).result()
    expect(message.stopReason).toBe('error')
    expect(h.fetches).toHaveLength(1)
    expect(h.transport.getDebugStats('session-fallback')).toMatchObject({
      fallbacks: 1,
      errors: 1,
      lastFailure: 'WS_CONNECT_FAILED',
    })
    h.transport.dispose()
  })

  it('does not fall back once an event was emitted', async () => {
    const h = harness({
      script: {
        onSend(socket) {
          socket.message(created('resp_after_start'))
          socket.dispatchEvent(new Event('error'))
          socket.close()
        },
      },
    })
    const wrapped = h.transport.wrap(provider)
    const message = await wrapped.streamSimple(model(), normalizeContext({ messages: [user('one')] }), {
      transport: 'websocket-cached',
      sessionId: 'session-after',
      apiKey: accessToken('account-a'),
    }).result()
    expect(message.stopReason).toBe('error')
    expect(h.fetches).toHaveLength(0)
    expect(h.transport.getDebugStats('session-after')).toMatchObject({
      fallbacks: 0,
      errors: 1,
      lastFailure: 'WS_STREAM_FAILED',
    })
    h.transport.dispose()
  })

  it('aborts the socket and never touches the HTTP route', async () => {
    const h = harness({
      script: {
        onSend() {
          // Never answer; the caller aborts.
        },
      },
    })
    const controller = new AbortController()
    const wrapped = h.transport.wrap(provider)
    const stream = wrapped.streamSimple(model(), normalizeContext({ messages: [user('one')] }), {
      transport: 'websocket-cached',
      sessionId: 'session-abort',
      apiKey: accessToken('account-a'),
      signal: controller.signal,
    })
    controller.abort(new Error('cancelled'))
    const aborted = await stream.result()
    expect(aborted.stopReason).toBe('aborted')
    expect(h.fetches).toHaveLength(0)
    expect(h.sockets.every((socket) => socket.closed)).toBe(true)
    expect(h.transport.getDebugStats('session-abort').requests).toBe(1)
    h.transport.dispose()
  })

  it('fails closed after dispose and leaves the global WebSocket constructor alone', async () => {
    const globalConstructor = globalThis.WebSocket
    const h = harness({
      script: {
        onSend(socket) {
          socket.message(created('resp_dispose'))
          socket.message(completed('resp_dispose'))
        },
      },
    })
    const wrapped = h.transport.wrap(provider)
    await wrapped.streamSimple(model(), normalizeContext({ messages: [user('one')] }), {
      transport: 'websocket-cached',
      sessionId: 'session-dispose',
      apiKey: accessToken('account-a'),
    }).result()
    h.transport.dispose()
    expect(h.sockets[0]!.closed).toBe(true)
    expect(globalThis.WebSocket).toBe(globalConstructor)
    expect(() => wrapped.streamSimple(model(), normalizeContext({ messages: [user('one')] }), {
      transport: 'websocket-cached',
      sessionId: 'session-dispose',
      apiKey: accessToken('account-a'),
    })).toThrow(/disposed/)
  })

  it('keeps HTTP/SSE and route-less requests delegated to the SDK path', async () => {
    const h = harness({ script: { failOnOpen: true } })
    const wrapped = h.transport.wrap(provider)
    const delegated = await wrapped.streamSimple(model(), normalizeContext({ messages: [user('one')] }), {
      transport: 'sse',
      sessionId: 'session-sse',
      apiKey: accessToken('account-a'),
      fetch: async () => new Response('', { status: 500 }),
    }).result()
    expect(delegated.stopReason).toBe('error')
    expect(h.sockets).toHaveLength(0)
    expect(h.fetches).toHaveLength(0)
    h.transport.dispose()

    const noRoute = new CodexWebSocketTransport(() => undefined)
    expect(noRoute.getDebugStats('none')).toMatchObject({ requests: 0, activeSockets: 0 })
    noRoute.dispose()
  })

  it('applies the Response runtime onPayload marker expansion before the WS body is sent', async () => {
    const h = harness({
      script: {
        onSend(socket) {
          socket.message(created('resp_marker'))
          socket.message(completed('resp_marker'))
        },
      },
    })
    const runtime = new OpenAICodexResponseRuntime(
      () => ({ useWebSocketContextReuse: true, useNativeCompaction: false }),
      async () => new Response('', { status: 500 }),
      undefined,
      undefined,
      undefined,
      () => true,
    )
    const wrapped = runtime.wrap(h.transport.wrap(provider))
    const marker = `${'<dsh-openai-codex-compaction-4f5cf1b7-v1>'}${JSON.stringify([
      { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque' },
    ])}${'</dsh-openai-codex-compaction-4f5cf1b7-v1>'}`
    await wrapped.streamSimple(model(), normalizeContext({ messages: [user(marker)] }), {
      transport: 'websocket-cached',
      sessionId: 'session-marker',
      apiKey: accessToken('account-a'),
      onPayload: async () => undefined,
    }).result()

    const sent = JSON.parse(h.sockets[0]!.sent[0]!) as { input: Array<Record<string, unknown>> }
    expect(JSON.stringify(sent)).not.toContain('dsh-openai-codex-compaction')
    expect(sent.input).toContainEqual({ type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque' })
    h.transport.dispose()
  })

  it('reconnects after a cached socket closes and disposes the replacement', async () => {
    const h = harness({
      script: {
        onSend(socket) {
          socket.message(created(`resp_${socket.sent.length}`))
          socket.message(completed(`resp_${socket.sent.length}`))
        },
      },
    })
    const wrapped = h.transport.wrap(provider)
    const options = {
      transport: 'websocket-cached' as const,
      sessionId: 'session-reconnect',
      apiKey: accessToken('account-a'),
    }
    await wrapped.streamSimple(model(), normalizeContext({ messages: [user('one')] }), options).result()
    expect(h.sockets).toHaveLength(1)

    // The server closes the cached socket; the next turn must reconnect and
    // the manager must still own (and dispose) the replacement.
    h.sockets[0]!.close()
    await wrapped.streamSimple(model(), normalizeContext({ messages: [user('two')] }), options).result()
    expect(h.sockets).toHaveLength(2)
    expect(h.sockets[0]!.closed).toBe(true)
    expect(h.sockets[1]!.closed).toBe(false)

    h.transport.dispose()
    expect(h.sockets[1]!.closed).toBe(true)
  })

  it('closes CONNECTING and concurrent same-session sockets on dispose', async () => {
    const h = harness({ script: { keepConnecting: true } })
    const wrapped = h.transport.wrap(provider)
    const options = {
      transport: 'websocket-cached' as const,
      sessionId: 'session-concurrent',
      apiKey: accessToken('account-a'),
    }
    const first = wrapped.streamSimple(model(), normalizeContext({ messages: [user('one')] }), options).result()
    await waitFor(() => h.sockets.length === 1)
    const second = wrapped.streamSimple(model(), normalizeContext({ messages: [user('two')] }), options).result()
    await waitFor(() => h.sockets.length === 2)

    h.transport.dispose()
    const [firstMessage, secondMessage] = await Promise.all([first, second])
    expect(firstMessage.stopReason).toBe('error')
    expect(secondMessage.stopReason).toBe('error')
    expect(h.sockets.every((socket) => socket.closed)).toBe(true)
  })

  it('bounds debug stats for sessions whose connect never succeeds', async () => {
    const route: CodexWebSocketRoute = {
      identity: {},
      fetch: async () => new Response('', { status: 500 }),
      createWebSocket: () => { throw new Error('connection refused') },
    }
    const transport = new CodexWebSocketTransport(() => route)
    const wrapped = transport.wrap(provider)
    for (let index = 0; index < 257; index += 1) {
      await wrapped.streamSimple(model(), normalizeContext({ messages: [user('x')] }), {
        transport: 'websocket-cached',
        sessionId: `session-fail-${index}`,
        apiKey: accessToken('account-a'),
      }).result()
    }
    expect(transport.getDebugStats('session-fail-0').requests).toBe(0)
    expect(transport.getDebugStats('session-fail-256').requests).toBe(1)
    transport.dispose()
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('condition was not reached')
}
