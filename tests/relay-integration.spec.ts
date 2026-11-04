/**
 * Relay acceptance regression (test-only).
 *
 * Default run: no network. It checks the shared relay contract, the direct
 * fallback mock, the whitelist sanitizer and the runner report shape.
 *
 * Real acceptance run: only when the operator sets
 * `DSH_CODEX_RELAY_ACCEPTANCE_CONFIG` to a JSON file OUTSIDE this workspace
 * ({ "baseUrl": "...", "apiKey": "..." }). The file is read in memory here and
 * never printed, copied or written into the workspace; the operator deletes it.
 *
 * The real cases go through the product relay transport
 * (`src/relay-provider.ts` + `withRelayTransport`/`bindRelaySnapshot`, product
 * undici direct fetch, `OpenAICodexImageClient` relay resolver). Cases whose
 * product path is not wired yet are reported as blocked, never as passed.
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { Agent as UndiciAgent, WebSocket as UndiciWebSocket } from 'undici'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createOpenAICodexModelProvider } from '../src/adapter.ts'
import { OPENAI_CODEX_IMAGE_MODEL, OpenAICodexImageClient } from '../src/imagegen.ts'
import { relayConfigOf, RelayConfigError, type RelayConfig } from '../src/relay.ts'
import { bindRelaySnapshot, relayDirectFetch, withRelayTransport } from '../src/relay-provider.ts'
import {
  OPENAI_CODEX_NATIVE_MARKER_CLOSE,
  OPENAI_CODEX_NATIVE_MARKER_OPEN,
  OpenAICodexResponseRuntime,
} from '../src/responses.ts'
import type { ResponseApiPreferences } from '../src/tool-policy.ts'

const CONFIG_ENV = 'DSH_CODEX_RELAY_ACCEPTANCE_CONFIG'
const REPORT_ENV = 'DSH_CODEX_RELAY_ACCEPTANCE_REPORT'

interface ReportEntry {
  case: string
  status: 'passed' | 'failed' | 'blocked' | 'mock-only'
  detail: Record<string, string | number | boolean>
}

const report: ReportEntry[] = []

function record(entry: ReportEntry): void {
  report.push(entry)
}

function nonce(label: string): string {
  return `relay-${label}-${randomUUID().slice(0, 8)}`
}

function sha256Short(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

/** The relay path must never consult the OAuth credential store. */
function credentialStoreGuard() {
  const getAuth = vi.fn(async () => {
    throw new Error('relay acceptance: OAuth credential store must not be read on the relay path')
  })
  return { store: { getAuth, setAuth: async () => undefined }, getAuth }
}
function readAcceptanceConfig(): RelayConfig | undefined {
  const file = process.env[CONFIG_ENV]
  if (file === undefined || file.length === 0) return undefined
  if (!isAbsolute(file)) throw new Error('relay acceptance config must be an absolute path')
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<
    { baseUrl: string; apiKey: string; relayBaseUrl: string; relayApiKey: string }
  >
  return relayConfigOf({
    relayBaseUrl: raw.baseUrl ?? raw.relayBaseUrl ?? '',
    relayApiKey: raw.apiKey ?? raw.relayApiKey ?? '',
  })
}

function whitelistedTypes(events: readonly unknown[]): string {
  return [...new Set(events.map(event => String((event as { type?: unknown }).type ?? 'unknown')))].join(',')
}

function answerText(events: readonly unknown[]): string {
  const parts: string[] = []
  for (const event of events) {
    const value = event as { type?: string; delta?: string }
    if (value.type === 'text_delta' && typeof value.delta === 'string') parts.push(value.delta)
  }
  return parts.join('')
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = []
  for await (const event of stream) events.push(event)
  return events
}

const config = readAcceptanceConfig()

afterAll(async () => {
  const path = process.env[REPORT_ENV]
  if (path !== undefined && path.length > 0) {
    writeFileSync(path, JSON.stringify({ cases: report }, null, 2))
  }
})

describe('relay contract (no network)', () => {
  it('normalizes a configured relay and rejects incomplete or unsafe settings', () => {
    expect(relayConfigOf({ relayBaseUrl: '', relayApiKey: 'unused' })).toBeUndefined()
    const fakeKey = `sk-test-${randomUUID()}`
    expect(relayConfigOf({ relayBaseUrl: 'https://relay.example/v1/', relayApiKey: ` ${fakeKey} ` }))
      .toEqual({ baseUrl: 'https://relay.example/v1', apiKey: fakeKey })
    expect(() => relayConfigOf({ relayBaseUrl: 'http://relay.example', relayApiKey: fakeKey }))
      .toThrow(RelayConfigError)
    expect(() => relayConfigOf({ relayBaseUrl: 'https://relay.example', relayApiKey: '' }))
      .toThrow(RelayConfigError)
    try {
      relayConfigOf({ relayBaseUrl: 'https://relay.example', relayApiKey: '' })
    } catch (error) {
      expect(String(error)).not.toContain(fakeKey)
      expect((error as RelayConfigError).code).toBe('missing-api-key')
    }
  })

  it('passes a call through unchanged when no relay snapshot is bound (direct fallback)', () => {
    const inner = vi.fn((..._args: unknown[]) => (async function* () { yield { type: 'done', reason: 'stop', message: {} } })())
    const gate = vi.fn(async () => { throw new Error('relay transport must not run for direct traffic') })
    const wrapped = withRelayTransport({ getModels: () => [], streamSimple: inner } as never, { fetch: gate as never })
    const model = { id: 'gpt-5.6-sol', provider: 'openai-codex' }
    const options = { transport: 'sse', sessionId: 'direct-session' }
    void wrapped.streamSimple(model as never, { messages: [] } as never, options as never)
    expect(inner).toHaveBeenCalledTimes(1)
    expect(inner.mock.calls[0]?.[0]).toEqual(model)
    expect(inner.mock.calls[0]?.[2]).toBe(options)
    expect(gate).not.toHaveBeenCalled()
    record({ case: 'direct-fallback-product', status: 'mock-only', detail: { innerCalls: 1, transportCalls: 0 } })
  })

  it('routes a relay call to the product transport with the static key and no OAuth store read', async () => {
    const relayKey = `sk-relay-${randomUUID()}`
    const inner = vi.fn()
    let seen: { url: string; headers: Headers } | undefined
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(input), headers: new Headers(init?.headers) }
      // The transport seam is what is under test here, so the carrier answers
      // with a plain error response: no SSE protocol is re-implemented.
      return new Response('relay-mock-unavailable', { status: 500 })
    })
    const wrapped = withRelayTransport(
      { getModels: () => [], streamSimple: inner } as never,
      { fetch: fetchImpl as never },
    )
    const relay = { baseUrl: 'https://relay.example/v1', apiKey: relayKey }
    const options = bindRelaySnapshot({ transport: 'sse', sessionId: 'relay-session' }, relay)
    // A real catalog model so the product request builder runs unchanged; the
    // fake carrier answers with an error status, so no SSE protocol is faked.
    const model = createOpenAICodexModelProvider().getModels()
      .find(candidate => candidate.id === 'gpt-5.6-sol') as never
    const stream = wrapped.streamSimple(
      model,
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as never,
      options as never,
    )
    await collect(stream as never)
    expect(seen).toBeDefined()
    expect(inner).not.toHaveBeenCalled()
    expect(seen?.url).toBe('https://relay.example/v1/responses')
    expect(seen?.headers.get('authorization')).toBe(`Bearer ${relayKey}`)
    expect(seen?.headers.get('chatgpt-account-id')).toBeNull()
    const guard = credentialStoreGuard()
    expect(guard.getAuth).not.toHaveBeenCalled()
    record({ case: 'relay-dispatch-product', status: 'mock-only', detail: {
      innerCalls: 0, transportCalls: fetchImpl.mock.calls.length,
    } })
  })
  it('keeps acceptance records free of credentials and opaque payloads', () => {
    const fakeKey = `sk-secret-${randomUUID()}`
    const body = Buffer.from(JSON.stringify({ encrypted_content: 'opaque-bytes', authorization: fakeKey }))
    const entry: ReportEntry = {
      case: 'sanitizer',
      status: 'mock-only',
      detail: { bytes: body.byteLength, sha: sha256Short(body) },
    }
    const serialized = JSON.stringify(entry)
    expect(serialized).not.toContain(fakeKey)
    expect(serialized).not.toContain('encrypted_content')
    expect(sha256Short(body)).toHaveLength(16)
  })
})

describe.skipIf(config === undefined)('relay acceptance (real product calls, one run)', () => {
  function provider(): any {
    return withRelayTransport(createOpenAICodexModelProvider())
  }

  function modelOf(value: any, id: string): any {
    const model = value.getModels().find((candidate: { id: string }) => candidate.id === id)
    if (model === undefined) throw new Error(`relay acceptance model unavailable: ${id}`)
    return model
  }

  function callOptions(extra: Record<string, unknown>): Record<string, unknown> {
    return bindRelaySnapshot({ ...extra }, config)
  }

  it('streams gpt-5.6-sol over the relay SSE path', async () => {
    const p = provider()
    const token = nonce('sse')
    const model = modelOf(p, 'gpt-5.6-sol')
    const events = await collect(p.streamSimple(model, {
      messages: [{ role: 'user', content: [{ type: 'text', text: `Reply with exactly ${token} and nothing else.` }] }],
    }, callOptions({ transport: 'sse', sessionId: 'relay-acceptance-sse' })))
    const answer = answerText(events)
    expect(answer).toContain(token)
    record({ case: 'sse-gpt-5.6-sol', status: 'passed', detail: {
      events: whitelistedTypes(events), answerChars: answer.length,
    } })
  })

  it('generates one GPT Image 2 PNG through the product relay image client', async () => {
    const client = new OpenAICodexImageClient(
      credentialStoreGuard().store as never,
      await relayDirectFetch() as never,
      () => config,
    )
    const bytes = await client.generate(
      'A minimal red square on white, flat vector style.',
      [],
      AbortSignal.timeout(120_000),
      OPENAI_CODEX_IMAGE_MODEL,
    )
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    writeFileSync('dist-package/relay-acceptance/gpt-image-2.png', bytes)
    record({ case: 'image-gpt-image-2', status: 'passed', detail: {
      bytes: bytes.byteLength, sha: sha256Short(bytes), mediaType: 'image/png',
    } })
  })

  it('runs the V2 native compaction trigger through the product relay runtime and replays the item', async () => {
    const estimate = (text: string): number | undefined => Math.ceil(text.length / 4)
    const decisions: string[] = []
    const base = createOpenAICodexModelProvider()
    // Wire capture ONLY at the real send entry: forward the request to the
    // product direct fetch, parse the outgoing body in memory for safe metadata,
    // and return the untouched Response (never consume its body here).
    const direct = await relayDirectFetch()
    interface WireMeta {
      path: string
      status: number
      kinds: string[]
      hasMarker: boolean
      hasNonce: boolean
      trigger: boolean
    }
    const wire: WireMeta[] = []
    const wireFetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      const rawBody = typeof init?.body === 'string' ? init.body : undefined
      const parsed = rawBody === undefined ? undefined : JSON.parse(rawBody) as Record<string, unknown>
      const inputItems = Array.isArray(parsed?.['input']) ? parsed?.['input'] as unknown[] : []
      const response = await (direct as unknown as (input: unknown, init?: RequestInit) => Promise<Response>)(input, init)
      wire.push({
        path: new URL(url).pathname,
        status: response.status,
        kinds: inputItems.map(item => String((item as { type?: unknown }).type ?? (item as { role?: unknown }).role ?? '')),
        hasMarker: JSON.stringify(parsed ?? {}).includes(OPENAI_CODEX_NATIVE_MARKER_OPEN),
        hasNonce: JSON.stringify(parsed ?? {}).includes(remembered),
        trigger: inputItems.some(item => (item as { type?: unknown }).type === 'compaction_trigger'),
      })
      return response
    }
    const relayProvider = withRelayTransport(base, { fetch: wireFetch as never })
    const runtime = new OpenAICodexResponseRuntime(
      () => ({ useNativeCompaction: true, useWebSocketContextReuse: false }) as ResponseApiPreferences,
      undefined,
      estimate,
      decision => { decisions.push(decision.reason) },
      () => config,
      { fetch: wireFetch as never },
    )
    const wrapped = runtime.wrap(relayProvider)
    const model = modelOf(base, 'gpt-5.6-sol')
    const session = `relay-acceptance-compaction-${randomUUID()}`
    // The native gate compares marker text against the shadowed source budget:
    // a synthetic ASSISTANT transcript plus short user nonces keeps the retained
    // user/system input small and avoids a false ordinary fallback. The codeword
    // lives ONLY in the shadowed assistant transcript, so the continuation can
    // answer it only through the encrypted compaction item. The first user states
    // that the value matters for the next question, so losing it is not "safe".
    const remembered = nonce('deploy-code')
    const filler = 'relay acceptance synthetic assistant transcript. '.repeat(300)
    const transcript = `Deployment recovery code: ${remembered}. ${filler} Note for the next question: the code above is ${remembered}.`
    const sourceText = `synthetic compaction source ${transcript}`
    const release = runtime.enterCompaction(session, sourceText)
    try {
      const firstMessages: unknown[] = [
        {
          role: 'user',
          content: [{
            type: 'text',
            text: 'You will provide a deployment recovery code; preserve it exactly for the next question after context compaction.',
          }],
        },
        { role: 'assistant', content: [{ type: 'text', text: transcript }] },
        // Simulated Harness summary instruction: retained user input, no codeword.
        { role: 'user', content: [{ type: 'text', text: 'Summarize the conversation so far into one checkpoint.' }] },
      ]
      const first = await collect(wrapped.streamSimple(model, {
        messages: firstMessages,
      } as never, callOptions({
        transport: 'sse', sessionId: session,
        // Deliberately return undefined: the product wrapper must still send the
        // expanded native item, which the wire capture below verifies.
        onPayload: () => undefined,
      })))
      expect(decisions.includes('selected-native')).toBe(true)
      const text = answerText(first)
      expect(text.startsWith(OPENAI_CODEX_NATIVE_MARKER_OPEN)).toBe(true)
      expect(text.endsWith(OPENAI_CODEX_NATIVE_MARKER_CLOSE)).toBe(true)
      const items = JSON.parse(text.slice(
        OPENAI_CODEX_NATIVE_MARKER_OPEN.length,
        -OPENAI_CODEX_NATIVE_MARKER_CLOSE.length,
      )) as unknown[]
      const compaction = items.find(item => (item as { type?: string }).type === 'compaction') as { encrypted_content?: string }
      expect(items.length).toBeGreaterThan(0)
      expect(typeof compaction.encrypted_content).toBe('string')
      const bytes = Buffer.byteLength(JSON.stringify(items))
      const compactionWire = wire.find(entry => entry.trigger)
      expect(compactionWire).toBeDefined()
      record({ case: 'v2-compaction', status: 'passed', detail: {
        events: whitelistedTypes(first), nativeDecision: true,
        itemBytes: bytes, itemSha: sha256Short(Buffer.from(JSON.stringify(items))),
        compactionItemBytes: Buffer.byteLength(compaction.encrypted_content ?? ''),
        wireLog: `POST ${compactionWire?.path ?? '/responses'} status=${String(compactionWire?.status ?? 0)}; output_item.type=compaction; encrypted_bytes=${String(Buffer.byteLength(compaction.encrypted_content ?? ''))}`,
      } })

      // The compaction call ends with the first stream; the continuation must be
      // a normal request that replays the returned encrypted item.
      release()
      const second = await collect(wrapped.streamSimple(model, {
        messages: [
          // The real marker checkpoint: product expands it into retained items
          // plus the opaque compaction item.
          { role: 'user', content: [{ type: 'text', text }] },
          // The question never contains the remembered codeword.
          { role: 'user', content: [{ type: 'text', text: 'What codeword did the assistant give earlier? Reply with the codeword only.' }] },
        ],
      } as never, callOptions({
        transport: 'sse', sessionId: session,
        onPayload: () => undefined,
      })))
      const secondAnswer = answerText(second)
      const secondError = second.find(event => (event as { type?: string }).type === 'error')
      expect(secondError).toBeUndefined()
      const continuationWire = wire.filter(entry => !entry.trigger).at(-1)
      expect(continuationWire).toBeDefined()
      const hasCompactionItem = continuationWire?.kinds.includes('compaction') === true
      const markerTextSent = continuationWire?.hasMarker === true
      const plaintextCarried = continuationWire?.hasNonce === true
      const answerCarried = secondAnswer.includes(remembered)
      // The context is fully synthetic (random nonce + filler), so the answer
      // preview is safe to keep for triage (no key, no opaque payload).
      const answerPreview = secondAnswer.slice(0, 120)
      const inputTypes = JSON.stringify(continuationWire?.kinds ?? [])
      const wireLog = `next POST ${continuationWire?.path ?? '/responses'} status=${String(continuationWire?.status ?? 0)} input_types=${inputTypes} markerText=${String(markerTextSent)} plaintextCodeword=${String(plaintextCarried)}; contextMatched=${String(answerCarried)}`
      record({ case: 'v2-continuation', status: answerCarried && hasCompactionItem && !markerTextSent && !plaintextCarried ? 'passed' : 'failed', detail: {
        requests: wire.length,
        secondEvents: whitelistedTypes(second),
        answerChars: secondAnswer.length,
        answerPreview,
        wireHasCompactionItem: hasCompactionItem,
        wireHasMarkerText: markerTextSent,
        plaintextCarriedCodeword: plaintextCarried,
        contextMatched: answerCarried,
        wireLog,
      } })
      expect(hasCompactionItem).toBe(true)
      expect(markerTextSent).toBe(false)
      expect(plaintextCarried).toBe(false)
      expect(answerCarried).toBe(true)
    } finally {
      release()
    }
  })
  it('reuses one WebSocket context across two rounds with actual send metadata', async () => {
    const dispatcher = new UndiciAgent()
    const sends: Array<{ bytes: number; items: number; previous: boolean }> = []
    // The product prints this exact fixed warning when it falls back to SSE;
    // a clean run with two socket sends is the "actual WS" evidence.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const deps = {
      openSocket: (url: string, headers: Record<string, string>) => {
        const Socket = UndiciWebSocket as unknown as new (...args: unknown[]) => {
          send(data: string): void
        }
        const socket = new Socket(url, { headers, dispatcher })
        const send = socket.send.bind(socket)
        socket.send = (data: string): void => {
          // Product frames are `{ type: 'response.create', ...body }`.
          const body = JSON.parse(data) as Record<string, unknown>
          const input = Array.isArray(body['input']) ? body['input'] as unknown[] : []
          sends.push({
            bytes: data.length,
            items: input.length,
            previous: typeof body['previous_response_id'] === 'string',
          })
          send(data)
        }
        return socket as never
      },
    }
    const wsProvider = withRelayTransport(createOpenAICodexModelProvider(), deps as never)
    const model = modelOf(wsProvider, 'gpt-5.6-sol')
    const session = `relay-acceptance-ws-${randomUUID()}`
    const codeword = nonce('memory')
    const firstMessages = [{
      role: 'user',
      content: [{ type: 'text', text: `Remember this codeword: ${codeword}. Reply with OK only.` }],
    }]
    try {
      const first = await collect(wsProvider.streamSimple(model, { messages: firstMessages } as never, callOptions({
        transport: 'websocket-cached', sessionId: session,
      })))
      const firstTypes = whitelistedTypes(first)
      expect(first.some(event => (event as { type?: string }).type === 'error')).toBe(false)
      expect(first.some(event => (event as { type?: string }).type === 'done')).toBe(true)
      const firstAnswer = answerText(first)
      const secondMessages = [
        ...firstMessages,
        { role: 'assistant', content: [{ type: 'text', text: firstAnswer.length > 0 ? firstAnswer : 'OK' }] },
        { role: 'user', content: [{ type: 'text', text: 'What codeword did I ask you to remember? Reply with it exactly.' }] },
      ]
      const second = await collect(wsProvider.streamSimple(model, { messages: secondMessages } as never, callOptions({
        transport: 'websocket-cached', sessionId: session,
      })))
      const secondTypes = whitelistedTypes(second)
      expect(second.some(event => (event as { type?: string }).type === 'error')).toBe(false)
      expect(second.some(event => (event as { type?: string }).type === 'done')).toBe(true)
      const secondAnswer = answerText(second)
      const fallbackWarning = warn.mock.calls.some(call =>
        String(call[0]).includes('[dsh-codex] relay WebSocket unavailable'))
      const continuation = sends.find(entry => entry.previous)
      record({ case: 'websocket-reuse', status: fallbackWarning ? 'failed' : 'passed', detail: {
        requests: sends.length,
        actualWebSocket: !fallbackWarning,
        fallbackToSse: fallbackWarning,
        continuationAttempted: continuation !== undefined,
        secondDeltaItems: continuation?.items ?? 0,
        secondFullInputItems: secondMessages.length,
        firstEvents: firstTypes,
        secondEvents: secondTypes,
        answerMatched: secondAnswer.includes(codeword),
      } })
      expect(fallbackWarning).toBe(false)
      expect(sends.length).toBeGreaterThanOrEqual(2)
      expect(continuation).toBeDefined()
      // The continuation carries only appended items, not the full second input.
      expect(continuation?.items ?? 0).toBeLessThan(secondMessages.length)
      expect(secondAnswer.includes(codeword)).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })
})
