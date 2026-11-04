import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context as PiContext, FetchFunction, Model, Provider, SimpleStreamOptions } from '@earendil-works/pi-ai'
import {
  RELAY_WEBSOCKET_FALLBACK_NOTE,
  runRelayDecision,
  withRelayTransport,
  closeRelaySockets,
  disposeRelayTransport,
} from '../src/relay-provider.ts'
import type { RelaySocketLike } from '../src/relay-provider.ts'
import { createOpenAICodexAdapter } from '../src/adapter.ts'
import {
  OPENAI_CODEX_NATIVE_MARKER_CLOSE,
  OPENAI_CODEX_NATIVE_MARKER_OPEN,
} from '../src/responses.ts'
import { OpenAICodexResponseRuntime } from '../src/responses.ts'
import type { ResponseApiPreferences } from '../src/tool-policy.ts'
import type { RelayConfig } from '../src/relay.ts'

const BASE = 'https://cpa.example/backend-api/codex'
const KEY = 'sk-relay-static-key'
const RELAY: RelayConfig = { baseUrl: BASE, apiKey: KEY }

const preferences: ResponseApiPreferences = {
  useWebSocketContextReuse: false,
  useNativeCompaction: true,
}

function model(): Model<'openai-codex-responses'> {
  return {
    id: 'gpt-5.6-sol',
    name: 'sol',
    provider: 'openai-codex',
    api: 'openai-codex-responses',
    input: ['text'],
    contextWindow: 400_000,
    maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    headers: { 'chatgpt-account-id': 'acct-first-party', cookie: 'session=first-party' },
    compat: {},
  } as unknown as Model<'openai-codex-responses'>
}

function context(): PiContext {
  return {
    systemPrompt: 'system',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
  } as unknown as PiContext
}

function baseProvider(stream = vi.fn()): Provider {
  return {
    id: 'openai-codex',
    getModels: () => [],
    streamSimple: stream,
  } as unknown as Provider
}

function sseResponse(frames: readonly unknown[]): Response {
  const body = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const COMPLETED = { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [] } }

interface Captured {
  readonly url: string
  readonly headers: Headers
  readonly body: Record<string, unknown>
  readonly init: RequestInit
}

function captureFetch(response: () => Response | Promise<Response>): { fetch: FetchFunction; calls: Captured[] } {
  const calls: Captured[] = []
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    calls.push({ url: String(input), headers: new Headers(init?.headers), body, init: init ?? {} })
    return response()
  }) as unknown as FetchFunction
  return { fetch, calls }
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = []
  for await (const event of stream) events.push(event)
  return events
}

function headerOf(captured: Captured, name: string): string | null {
  return captured.headers.get(name)
}

describe('relay SSE transport', () => {
  it('posts to the exact endpoint with the static key and no first-party binding', async () => {
    const { fetch, calls } = captureFetch(() => sseResponse([COMPLETED]))
    const provider = withRelayTransport(baseProvider(), { fetch })
    const fastMode: SimpleStreamOptions = { transport: 'sse' as never }
    const events = await runRelayDecision({ relay: RELAY }, () =>
      collect(provider.streamSimple(model(), context(), {
        ...fastMode,
        headers: { 'chatgpt-account-id': 'acct-first-party', cookie: 'session=first-party' },
        onPayload: async (payload: Record<string, unknown>) => ({ ...payload, service_tier: 'priority' }),
        sessionId: 'session-1',
      } as never)),
    )

    expect(calls).toHaveLength(1)
    const request = calls[0] as Captured
    expect(request.url).toBe(`${BASE}/responses`)
    expect(headerOf(request, 'authorization')).toBe(`Bearer ${KEY}`)
    expect(headerOf(request, 'chatgpt-account-id')).toBeNull()
    expect(headerOf(request, 'cookie')).toBeNull()
    expect(headerOf(request, 'originator')).toBe('dsh-codex')
    expect(request.body['store']).toBe(false)
    expect(request.body['service_tier']).toBe('priority')
    expect(JSON.stringify(request.body)).not.toContain('acct-first-party')
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('never reads the OAuth store in relay mode', async () => {
    const read = vi.fn(async () => undefined)
    const credentials = { read, write: vi.fn(), remove: vi.fn() }
    const { fetch, calls } = captureFetch(() => sseResponse([COMPLETED]))
    const adapter = createOpenAICodexAdapter(
      credentials as never,
      () => undefined,
      () => preferences,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => RELAY,
      fetch,
    )
    const prepared = await adapter.prepareCall('openai-codex', 'gpt-5.6-sol')
    await collect(prepared.stream({ provider: 'openai-codex', model: 'gpt-5.6-sol', messages: [], sessionId: 's1' } as never))

    expect(read).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    expect((calls[0] as Captured).headers.get('authorization')).toBe(`Bearer ${KEY}`)
  })

  it('refuses a redirect instead of following it', async () => {
    const redirect = new Response('secret-relay-body', {
      status: 302,
      headers: { location: 'https://attacker.example/responses' },
    })
    const cancel = vi.spyOn(redirect.body as ReadableStream<Uint8Array>, 'cancel')
    const fetch = (async () => redirect) as unknown as FetchFunction
    const provider = withRelayTransport(baseProvider(), { fetch })
    const events = await runRelayDecision({ relay: RELAY }, () =>
      collect(provider.streamSimple(model(), context(), { transport: 'sse' } as never)))
    const error = events.at(-1) as { type: string; error: { errorMessage: string } }
    expect(error.type).toBe('error')
    expect(error.error.errorMessage).toBe('relay redirect refused')
    expect(cancel).toHaveBeenCalled()
  })

  it('reports a fixed error for a failed response without echoing its body', async () => {
    const failed = new Response(`bad key ${KEY}`, { status: 401 })
    const cancel = vi.spyOn(failed.body as ReadableStream<Uint8Array>, 'cancel')
    const fetch = (async () => failed) as unknown as FetchFunction
    const provider = withRelayTransport(baseProvider(), { fetch })
    const events = await runRelayDecision({ relay: RELAY }, () =>
      collect(provider.streamSimple(model(), context(), { transport: 'sse' } as never)))
    const text = JSON.stringify(events)
    expect(text).toContain('relay request failed with HTTP 401')
    expect(text).not.toContain(KEY)
    expect(cancel).toHaveBeenCalled()
  })

  it('keeps direct traffic on the base provider and ignores a stale snapshot', async () => {
    const direct = vi.fn(() => collectIterable([{ type: 'done' }]))
    const provider = withRelayTransport(baseProvider(direct as never), { fetch: vi.fn() as never })
    // An explicit direct decision must win over any bound options snapshot.
    await runRelayDecision({}, async () => {
      const stream = provider.streamSimple(model(), context(), { transport: 'sse' } as never)
      await collect(stream as unknown as AsyncIterable<unknown>)
    })
    expect(direct).toHaveBeenCalledTimes(1)
  })

  it('serves a relay request again after a plugin unload disposed the transport', async () => {
    const first = captureFetch(() => sseResponse([COMPLETED]))
    const provider = withRelayTransport(baseProvider(), { fetch: first.fetch })
    await runRelayDecision({ relay: RELAY }, () => collect(provider.streamSimple(model(), context(), { transport: 'sse' } as never)))
    expect(first.calls).toHaveLength(1)

    disposeRelayTransport()
    disposeRelayTransport()

    const second = captureFetch(() => sseResponse([COMPLETED]))
    const resumed = withRelayTransport(baseProvider(), { fetch: second.fetch })
    const events = await runRelayDecision({ relay: RELAY }, () => collect(resumed.streamSimple(model(), context(), { transport: 'sse' } as never)))
    expect(second.calls).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('forwards the Harness reasoning level as the wire reasoning effort', async () => {
    const { fetch, calls } = captureFetch(() => sseResponse([COMPLETED]))
    const provider = withRelayTransport(baseProvider(), { fetch })
    await runRelayDecision({ relay: RELAY }, () =>
      collect(provider.streamSimple(model(), context(), {
        transport: 'sse',
        reasoning: 'high',
      } as never)))

    const request = calls[0] as Captured
    expect((request.body['reasoning'] as Record<string, unknown>)['effort']).toBe('high')
  })

  it('sends the expanded checkpoint item even when an observer hook returns undefined', async () => {
    const marker = `${OPENAI_CODEX_NATIVE_MARKER_OPEN}${JSON.stringify([{ type: 'compaction', encrypted_content: 'opaque' }])}${OPENAI_CODEX_NATIVE_MARKER_CLOSE}`
    const { fetch, calls } = captureFetch(() => sseResponse([COMPLETED]))
    const runtime = new OpenAICodexResponseRuntime(
      () => preferences,
      vi.fn() as never,
      undefined,
      undefined,
      () => RELAY,
      { fetch },
    )
    const provider = runtime.wrap(withRelayTransport(baseProvider(), { fetch }))
    const checkpointContext = {
      systemPrompt: 'system',
      messages: [{ role: 'user', content: [{ type: 'text', text: marker }] }],
      tools: [],
    } as unknown as PiContext
    const observer = vi.fn(async () => undefined)

    await collect(provider.streamSimple(model(), checkpointContext, {
      transport: 'sse',
      onPayload: observer,
    } as never))

    expect(observer).toHaveBeenCalledTimes(1)
    const request = calls[0] as Captured
    const serialized = JSON.stringify(request.body)
    expect(serialized).toContain('"type":"compaction"')
    expect(serialized).not.toContain(OPENAI_CODEX_NATIVE_MARKER_OPEN)
  })

  it('binds each concurrent step to its own endpoint and key', async () => {
    const calls: Captured[] = []
    const fetch = (async (input: unknown, init?: RequestInit) => {
      await new Promise(resolve => setTimeout(resolve, 5))
      calls.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        init: init ?? {},
      })
      return sseResponse([COMPLETED])
    }) as unknown as FetchFunction
    const provider = withRelayTransport(baseProvider(), { fetch })
    const first: RelayConfig = { baseUrl: 'https://a.example/codex', apiKey: 'sk-a' }
    const second: RelayConfig = { baseUrl: 'https://b.example/codex', apiKey: 'sk-b' }

    await Promise.all([
      runRelayDecision({ relay: first }, () => collect(provider.streamSimple(model(), context(), { transport: 'sse' } as never))),
      runRelayDecision({ relay: second }, () => collect(provider.streamSimple(model(), context(), { transport: 'sse' } as never))),
    ])

    expect(calls.map(call => call.url).sort()).toEqual([
      'https://a.example/codex/responses',
      'https://b.example/codex/responses',
    ])
    expect(calls.map(call => call.headers.get('authorization')).sort()).toEqual([
      'Bearer sk-a',
      'Bearer sk-b',
    ])
  })

  it('freezes the runtime entry snapshot when the resolver changes mid-call', async () => {
    const first: RelayConfig = { baseUrl: 'https://first.example/codex', apiKey: 'sk-first' }
    const second: RelayConfig = { baseUrl: 'https://second.example/codex', apiKey: 'sk-second' }
    const resolver = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValue(second)
    const direct = vi.fn()
    const { fetch, calls } = captureFetch(() => sseResponse([COMPLETED]))
    const runtime = new OpenAICodexResponseRuntime(
      () => preferences,
      direct as never,
      undefined,
      undefined,
      resolver,
      { fetch },
    )
    const provider = runtime.wrap(withRelayTransport(baseProvider(), { fetch }))

    await collect(provider.streamSimple(model(), context(), { transport: 'sse' } as never))
    expect((calls[0] as Captured).url).toBe('https://first.example/codex/responses')
    expect((calls[0] as Captured).headers.get('authorization')).toBe('Bearer sk-first')

    await collect(provider.streamSimple(model(), context(), { transport: 'sse' } as never))
    expect((calls[1] as Captured).url).toBe('https://second.example/codex/responses')
    expect((calls[1] as Captured).headers.get('authorization')).toBe('Bearer sk-second')
    expect(direct).not.toHaveBeenCalled()
  })
  it('refuses traffic for an invalid relay configuration instead of going direct', async () => {
    const direct = vi.fn()
    const provider = withRelayTransport(baseProvider(direct as never), { fetch: vi.fn() as never })
    expect(() =>
      runRelayDecision({ error: new Error('relay base URL is configured but no API key is set') }, () =>
        provider.streamSimple(model(), context(), { transport: 'sse' } as never)),
    ).toThrow('relay base URL is configured but no API key is set')
    expect(direct).not.toHaveBeenCalled()
  })
})

function collectIterable(events: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event
    },
  }
}

async function* sseFrames(text: string): AsyncIterable<unknown> {
  for (const frame of text.split('\n\n')) {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('')
    if (data.length > 0) yield JSON.parse(data)
  }
}

describe('relay native V2 compaction', () => {
  it('keeps store:false, compaction_trigger, priority and no account header', async () => {
    const { fetch, calls } = captureFetch(() => sseResponse([
      { type: 'response.output_item.done', output_index: 0, item: { type: 'compaction', encrypted_content: 'opaque' } },
      COMPLETED,
    ]))
    const runtime = new OpenAICodexResponseRuntime(
      () => preferences,
      vi.fn() as never,
      () => 10,
      undefined,
      () => RELAY,
      { fetch },
      () => true,
    )
    const provider = runtime.wrap(withRelayTransport(baseProvider(), { fetch }))
    const release = runtime.enterCompaction('s1', 'source text that should shrink '.repeat(50))
    try {
      const events = await runRelayDecision({ relay: RELAY }, () =>
        collect(provider.streamSimple(model(), context(), {
          transport: 'sse',
          apiKey: 'oauth-access-token',
          sessionId: 's1',
        } as never)))
      expect(events.length).toBeGreaterThan(0)
    } finally {
      release()
    }

    const request = calls[0] as Captured
    expect(request.url).toBe(`${BASE}/responses`)
    expect(headerOf(request, 'authorization')).toBe(`Bearer ${KEY}`)
    expect(headerOf(request, 'chatgpt-account-id')).toBeNull()
    expect(request.body['store']).toBe(false)
    expect(request.body['service_tier']).toBe('priority')
    const input = request.body['input'] as unknown[]
    expect(input.at(-1)).toMatchObject({ type: 'compaction_trigger' })
  })
})

describe('relay WebSocket transport', () => {
  beforeEach(() => {
    closeRelaySockets()
  })

  interface FakeSocket extends RelaySocketLike {
    readonly sent: string[]
    readonly headers: Record<string, string>
    readonly url: string
    opened: boolean
    sendsBeforeOpen: number
    receive(events: readonly unknown[]): void
  }

  function fakeSocketFactory(openDelayMs = 0): {
    open: (url: string, headers: Record<string, string>) => FakeSocket
    sockets: FakeSocket[]
  } {
    const sockets: FakeSocket[] = []
    const open = (url: string, headers: Record<string, string>): FakeSocket => {
      const sent: string[] = []
      const socket = {
        url,
        headers,
        sent,
        opened: false,
        sendsBeforeOpen: 0,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        send(data: string) {
          if (!socket.opened) socket.sendsBeforeOpen += 1
          sent.push(data)
          const requested = JSON.parse(data) as Record<string, unknown>
          expect(requested['type']).toBe('response.create')
          // Reply with the completed response exactly once per request.
          queueMicrotask(() => socket.receive([{ ...COMPLETED, response: { id: `resp-${sent.length}`, status: 'completed', output: [] } }]))
          void requested
        },
        close: () => undefined,
        receive(events: readonly unknown[]) {
          for (const event of events) socket.onmessage?.({ data: JSON.stringify(event) })
        },
      } as unknown as FakeSocket
      sockets.push(socket)
      const markOpen = () => {
        socket.opened = true
        socket.onopen?.()
      }
      if (openDelayMs > 0) setTimeout(markOpen, openDelayMs)
      else queueMicrotask(markOpen)
      return socket
    }
    return { open, sockets }
  }

  function wsProvider(open: (url: string, headers: Record<string, string>) => FakeSocket): Provider {
    return withRelayTransport(baseProvider(), { fetch: vi.fn() as never, openSocket: open })
  }

  it('reuses a socket only for the same endpoint, key, and session', async () => {
    const factory = fakeSocketFactory()
    const provider = wsProvider(factory.open)
    const options = { transport: 'websocket-cached', sessionId: 's1' } as never
    await collectRelay(provider, options)
    await collectRelay(provider, options)
    expect(factory.sockets).toHaveLength(1)
    expect(factory.sockets[0]?.sent).toHaveLength(2)
    expect(factory.sockets[0]?.headers['authorization']).toBe(`Bearer ${KEY}`)
    expect(factory.sockets[0]?.headers['chatgpt-account-id']).toBeUndefined()

    const other = withRelayTransport(baseProvider(), {
      fetch: vi.fn() as never,
      openSocket: fakeSocketFactory().open,
    })
    await runRelayDecision({ relay: { baseUrl: BASE, apiKey: 'sk-other' } }, () =>
      collectRelay(other, options))
    expect(factory.sockets).toHaveLength(1)
  })

  it('sends previous_response_id plus the exact input delta on reuse', async () => {
    const factory = fakeSocketFactory()
    const provider = wsProvider(factory.open)
    const first = { transport: 'websocket-cached', sessionId: 's1', messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }] } as never
    await collectRelay(provider, first)
    const firstBody = JSON.parse(factory.sockets[0]?.sent[0] ?? '{}') as Record<string, unknown>
    expect(firstBody['previous_response_id']).toBeUndefined()

    const grown = {
      transport: 'websocket-cached',
      sessionId: 's1',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'a' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      ],
    } as never
    const grownContext = contextWith([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      { role: 'user', content: [{ type: 'text', text: 'again' }] },
    ])
    await collectRelay(provider, grown, grownContext)
    const secondBody = JSON.parse(factory.sockets[0]?.sent[1] ?? '{}') as Record<string, unknown>
    expect(secondBody['previous_response_id']).toBe('resp-1')
    expect((secondBody['input'] as unknown[]).length).toBe(2)
  })

  it('waits for a CONNECTING socket to open before the first frame', async () => {
    const factory = fakeSocketFactory(5)
    const provider = wsProvider(factory.open)
    const events = await collectRelay(provider, { transport: 'websocket-cached', sessionId: 's1' } as never)
    expect(factory.sockets).toHaveLength(1)
    expect(factory.sockets[0]?.sendsBeforeOpen).toBe(0)
    expect(factory.sockets[0]?.sent).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('falls back to SSE once when the socket cannot connect', async () => {
    const { fetch, calls } = captureFetch(() => sseResponse([COMPLETED]))
    const provider = withRelayTransport(baseProvider(), {
      fetch,
      openSocket: () => {
        throw new Error('connect refused')
      },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const events = await runRelayDecision({ relay: RELAY }, () =>
        collectRelay(provider, { transport: 'websocket-cached', sessionId: 's1' } as never))
      expect(events.at(-1)).toMatchObject({ type: 'done' })
      expect(warn).toHaveBeenCalledWith(RELAY_WEBSOCKET_FALLBACK_NOTE)
      expect(calls).toHaveLength(1)
    } finally {
      warn.mockRestore()
      closeRelaySockets()
    }
  })
})

async function collectRelay(provider: Provider, options: never, ctx: PiContext = context()): Promise<unknown[]> {
  return runRelayDecision({ relay: RELAY }, () => collect(provider.streamSimple(model(), ctx, options)))
}

function contextWith(messages: readonly unknown[]): PiContext {
  return { systemPrompt: 'system', messages, tools: [] } as unknown as PiContext
}
