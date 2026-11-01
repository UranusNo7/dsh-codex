import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRuntime from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { CompactionDiagnostics, foldCompactionEvents, readCompactionSnapshot } from '../src/compaction-diagnostics.ts'
import { CodexContextController } from '../src/codex-context.ts'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import type {} from '@deepseek-ai/dsh-attachment'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as OpenAICodex from '../src/index.ts'

/**
 * Real-core compaction integration.
 *
 * Unlike `codex-compaction.spec.ts` (a hand-written Responses SSE replica), this
 * file mounts the actual Harness compaction backend (`dsh-compaction-basic`),
 * its token meter, the real `SessionStore`, and this plugin, then drives
 * `ctx.compaction` exactly as a command would. Only the upstream HTTP endpoint
 * is mocked.
 *
 * Version caveat: this workspace pins the 0.2.0-rc.1 package family, while the
 * installed Desktop runtime is 0.2.1-rc.5. These assertions bind the rc.1
 * protocol; they are not a target-machine E2E claim.
 */

const MODEL = 'gpt-5.6-sol'
/** 1x1 opaque PNG reused from the existing image fixtures. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
)

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function accessToken(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })}.signature`
}

function userMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function assistantMessage(text: string) {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'openai-codex', model: MODEL },
  })
}

/** Codex V2 compaction SSE: one opaque checkpoint item plus a terminal event. */
function compactionSse(encryptedContent = 'encrypted-checkpoint'): string {
  const events = [
    {
      type: 'response.output_item.done',
      item: { type: 'compaction', id: 'cmp_item_1', encrypted_content: encryptedContent },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_native_compaction',
        status: 'completed',
        output: [],
        usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
      },
    },
  ]
  return `${events.map(event => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\n`
}

/** Ordinary Responses SSE: one assistant text message. */
function standardSse(text = 'harness summary'): string {
  const events = [
    { type: 'response.created', response: { id: 'resp_standard' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_standard', role: 'assistant', content: [] },
    },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_standard',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_standard',
        status: 'completed',
        output: [],
        usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13 },
      },
    },
  ]
  return `${events.map(event => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\n`
}

function requestJson(init: RequestInit): Record<string, unknown> {
  const headers = new Headers(init.headers)
  const raw = init.body
  const bytes = typeof raw === 'string'
    ? Buffer.from(raw, 'utf8')
    : raw instanceof Uint8Array
      ? Buffer.from(raw)
      : raw instanceof ArrayBuffer
        ? Buffer.from(raw)
        : undefined
  if (bytes === undefined) throw new Error(`unsupported request body kind: ${Object.prototype.toString.call(raw)}`)
  const plain = headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(bytes) : bytes
  return JSON.parse(plain.toString('utf8')) as Record<string, unknown>
}

interface Upstream {
  readonly compactionBodies: Record<string, unknown>[]
  readonly standardBodies: Record<string, unknown>[]
}

/** Mock every upstream call; the catalog warm and both stream kinds stay local. */
function mockUpstream(options: { compaction?: () => string; standard?: () => string } = {}): Upstream {
  const compactionBodies: Record<string, unknown>[] = []
  const standardBodies: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (init === undefined || init.body === undefined) {
      // Model-catalog warm and any other metadata read never reaches the network precondition.
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const body = requestJson(init)
    const isCompaction = Array.isArray(body['input']) &&
      (body['input'] as unknown[]).some(item =>
        typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'compaction_trigger')
    if (isCompaction) {
      compactionBodies.push(body)
      return new Response((options.compaction ?? compactionSse)(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    standardBodies.push(body)
    return new Response((options.standard ?? standardSse)(), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  })
  return { compactionBodies, standardBodies }
}

interface Harness {
  readonly ctx: Context
  readonly upstream: Upstream
}

async function mount(options: {
  useNativeCompaction: boolean
  summarization?: { provider: string; model: string } | null
  compaction?: () => string
  standard?: () => string
}): Promise<Harness> {
  root = await mkdtemp(join(tmpdir(), 'dsh-codex-compaction-core-'))
  vi.stubEnv('DSH_HOME', root)
  const store = new OpenAICodex.OpenAICodexCredentialStore()
  await store.modify(OpenAICodex.OPENAI_CODEX_PROVIDER, () => Promise.resolve({
    type: 'oauth',
    access: accessToken('account-1'),
    refresh: 'refresh-token',
    expires: Date.now() + 3_600_000,
    accountId: 'account-1',
  }))
  const upstreamOptions: { compaction?: () => string; standard?: () => string } = {}
  if (options.compaction !== undefined) upstreamOptions.compaction = options.compaction
  if (options.standard !== undefined) upstreamOptions.standard = options.standard
  const upstream = mockUpstream(upstreamOptions)
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SessionProjectionRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(WebRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(TokenMeter)
  // Real local attachment store (test composition; no product code changes).
  await ctx.plugin(LocalAttachmentStore, {})
  await ctx.plugin(BasicCompactionEngine, {
    auto: false,
    ...options.summarization === null
      ? {}
      : {
        summarizationProvider: options.summarization?.provider ?? 'openai-codex',
        summarizationModel: options.summarization?.model ?? MODEL,
      },
  })
  await ctx.plugin(OpenAICodex, {
    useNativeCompaction: options.useNativeCompaction,
    models: [MODEL],
  })
  return { ctx, upstream }
}

/**
 * A closed turn whose last surface node is a short retained prompt and whose
 * compacted span holds the long assistant text that proves the checkpoint
 * smaller than its source.
 */
function seedSession(ctx: Context) {
  const session = ctx.sessions.create('session-compaction-core' as never)
  const append = session.append.bind(session)
  append('turn/start', { turn: 1 })
  append('step/start', { turn: 1, step: 1 })
  append(
    'system/message',
    { turn: 1, step: 1, message: createSystemMessage('You are a coding agent.') },
    { surfaceOp: 'append' },
  )
  append(
    'user/message',
    userMessage('Refactor the parser and keep the public API stable.'),
    { surfaceOp: 'append' },
  )
  append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: assistantMessage('x'.repeat(6_000)),
      stream: [],
    },
    { surfaceOp: 'append' },
  )
  append('step/end', { turn: 1, step: 1 })
  append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  append(
    'user/message',
    userMessage('Continue with the next step.'),
    { surfaceOp: 'append' },
  )
  return session
}

/** A session that is too small to compact: no safe useful range exists. */
function seedTinySession(ctx: Context) {
  const session = ctx.sessions.create('session-compaction-tiny' as never)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append(
    'system/message',
    { turn: 1, step: 1, message: createSystemMessage('You are a coding agent.') },
    { surfaceOp: 'append' },
  )
  session.append('user/message', userMessage('Only prompt'), { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

/**
 * A real tool call/result pair inside the compacted span, so the range
 * selection has to keep the assistant call and its result together.
 */
function seedToolPairSession(
  ctx: Context,
  options: { readonly sessionId?: string; readonly resultText?: string } = {},
) {
  const session = ctx.sessions.create((options.sessionId ?? 'session-compaction-tools') as never)
  const append = session.append.bind(session)
  append('turn/start', { turn: 1 })
  append('step/start', { turn: 1, step: 1 })
  append(
    'system/message',
    { turn: 1, step: 1, message: createSystemMessage('You are a coding agent.') },
    { surfaceOp: 'append' },
  )
  append('user/message', userMessage('Read the parser module.'), { surfaceOp: 'append' })
  const callId = 'call_pair|fc_pair'
  const callEvent = append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [
          { type: 'text', text: 'y'.repeat(6_000) },
          { type: 'tool-call', id: callId as never, name: 'read_file', arguments: '{"path":"parser.ts"}' },
        ],
        source: { provider: 'openai-codex', model: MODEL },
      }),
      stream: [],
    },
    { surfaceOp: 'append' },
  )
  const resultEvent = append(
    'tool/result',
    {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: callId as never,
        content: [{ type: 'text', text: options.resultText ?? 'export function parse() {}' }],
        isError: false,
      }),
    },
    { surfaceOp: 'append' },
  )
  append('step/end', { turn: 1, step: 1 })
  append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  append('user/message', userMessage('Now summarize what you found.'), { surfaceOp: 'append' })
  return { session, callSeq: callEvent.seq, resultSeq: resultEvent.seq }
}

/**
 * Minimal ManualCompactAgentContext face.
 *
 * The real `dsh-agent` implementation owns `runMaintenance` (idle admission)
 * and the driver owns `agent/status`. Both are out of scope for these
 * engine-level assertions, so the gap is stated here rather than imitated:
 * these tests prove `BasicCompactionEngine` + `SessionStore` + `TokenMeter` +
 * this plugin agree on the protocol; they do not prove driver ordering.
 */
function manualAgent(session: { session: never } | ReturnType<typeof seedSession>) {
  const target = 'seq' in session ? session : session.session
  return {
    agent: {
      session: target,
      options: { provider: 'openai-codex', model: MODEL },
      runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
        return task(new AbortController().signal)
      },
    },
  }
}

function eventsSince(session: Session, before: number): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let index = before; index < session.seq; index += 1) {
    const event = session.eventAt(index as never)
    if (event !== undefined) events.push(event)
  }
  return events
}

function allEvents(session: Session): SessionEvent[] {
  return eventsSince(session, 0)
}

function eventAt(session: Session, seq: number): SessionEvent {
  const event = session.eventAt(seq as never)
  if (event === undefined) throw new Error(`session event ${seq} is missing`)
  return event
}

/** Whether one durable event is the compaction checkpoint replacement message. */
function isCheckpointEvent(event: SessionEvent | undefined): boolean {
  if (event === undefined || event.type !== 'user/message') return false
  return isCompactCheckpointSource((event.data as UserMessage).source)
}

/** Rebuild the model-visible messages a later request would send. */
function surfaceMessages(session: Session) {
  return session.surface.nodes
    .map(seq => session.deriveEventMessage(eventAt(session, seq)))
    .filter(message => message !== null)
}

/**
 * Test-only SessionQuery subclass: the full-text search methods are not used by
 * this read; `observeSession` is the real concrete engine implementation.
 */
class TestSessionQuery extends SessionQueryEngine {
  async searchSessions(): Promise<never> {
    throw new Error('searchSessions is not used by the recall integration coverage')
  }

  async searchEvents(): Promise<never> {
    throw new Error('searchEvents is not used by the recall integration coverage')
  }
}

describe('real core compaction integration', () => {
  it('publishes a native checkpoint through ctx.compaction and reuses it upstream', async () => {
    const { ctx, upstream } = await mount({ useNativeCompaction: true })
    const session = seedSession(ctx)
    const { agent } = manualAgent(session)
    const before = session.seq

    const result = await ctx.compaction.compactNow(agent as never, new AbortController().signal)

    expect(result).not.toBeNull()
    if (result === null) return
    // Durable lifecycle: start -> summary -> end, all standalone (turn null).
    const events = eventsSince(session, before)
    const start = events.find(event => event.type === 'compaction/start')
    const summary = events.find(event => event.type === 'compaction/summary')
    const end = events.find(event => event.type === 'compaction/end')
    expect(start?.data).toMatchObject({ turn: null })
    expect(summary?.data).toMatchObject({ provider: 'openai-codex', model: MODEL, llmStreamCall: true })
    expect(end?.data).not.toHaveProperty('error')
    // The replacement node carries the compaction checkpoint source.
    const replacement = events.find(event => event.type === 'user/message')
    expect(replacement?.type === 'user/message' && isCompactCheckpointSource(replacement.data.source)).toBe(true)
    // Exactly one native upstream request, carrying the compaction trigger.
    expect(upstream.compactionBodies).toHaveLength(1)
    expect(upstream.standardBodies).toHaveLength(0)
    expect(upstream.compactionBodies[0]?.['input']).toEqual(
      expect.arrayContaining([{ type: 'compaction_trigger' }]),
    )
    // Estimate and real provider usage stay separate fields, never merged.
    const summaryData = summary?.type === 'compaction/summary' ? summary.data : undefined
    expect(result.shadowedTokenCount).toBeGreaterThan(0)
    expect(summaryData?.usage).toMatchObject({ inputTokens: 20, outputTokens: 4 })
    expect(summaryData?.shadowedTokenCount).toBe(result.shadowedTokenCount)

    // A later ordinary request replays the opaque item instead of the shadowed text.
    const messages = surfaceMessages(session)
    const chunks: unknown[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'openai-codex',
      model: MODEL,
      sessionId: session.id,
      messages,
    })) {
      chunks.push(chunk)
    }
    expect(upstream.standardBodies).toHaveLength(1)
    const input = upstream.standardBodies[0]?.['input']
    expect(Array.isArray(input)).toBe(true)
    expect(input as unknown[]).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'compaction', encrypted_content: 'encrypted-checkpoint' }),
    ]))
    expect(JSON.stringify(input)).not.toContain('xxxxxxxxxx')
  })

  it('returns null and appends nothing when no safe range exists', async () => {
    const { ctx, upstream } = await mount({ useNativeCompaction: true })
    const session = seedTinySession(ctx)
    const { agent } = manualAgent(session)
    const before = session.seq
    const surfaceBefore = [...session.surface.nodes]

    const result = await ctx.compaction.compactNow(agent as never, new AbortController().signal)

    expect(result).toBeNull()
    expect(session.seq).toBe(before)
    expect([...session.surface.nodes]).toEqual(surfaceBefore)
    expect(upstream.compactionBodies).toHaveLength(0)
    expect(upstream.standardBodies).toHaveLength(0)
  })

  it('preserves the caller abort reason before touching the log', async () => {
    const { ctx, upstream } = await mount({ useNativeCompaction: true })
    const session = seedSession(ctx)
    const { agent } = manualAgent(session)
    const before = session.seq
    const reason = new Error('user cancelled compaction')

    const thrown = await Promise.resolve()
      .then(() => ctx.compaction.compactNow(agent as never, AbortSignal.abort(reason)))
      .then(() => undefined, (error: unknown) => error)
    expect(thrown).toBe(reason)

    expect(session.seq).toBe(before)
    expect(upstream.compactionBodies).toHaveLength(0)
    expect(upstream.standardBodies).toHaveLength(0)
  })

  it('records the failed attempt when cancellation lands mid-flight', async () => {
    const controller = new AbortController()
    const { ctx, upstream } = await mount({
      useNativeCompaction: true,
      compaction: () => {
        controller.abort(new Error('cancelled while summarizing'))
        return compactionSse()
      },
    })
    const session = seedSession(ctx)
    const { agent } = manualAgent(session)
    const before = session.seq

    await expect(ctx.compaction.compactNow(agent as never, controller.signal))
      .rejects.toMatchObject({ message: 'cancelled while summarizing' })

    const events = eventsSince(session, before)
    // The attempt stayed visible: one start, one closing end carrying the error.
    expect(events.filter(event => event.type === 'compaction/start')).toHaveLength(1)
    const ends = events.filter(event => event.type === 'compaction/end')
    expect(ends).toHaveLength(1)
    expect(ends[0]?.data).toMatchObject({ error: expect.stringContaining('cancelled while summarizing') })
    expect(events.some(event => event.type === 'compaction/summary')).toBe(false)
    expect(upstream.compactionBodies).toHaveLength(1)
  })

  it('falls back to the Harness summary when the checkpoint cannot be proven smaller', async () => {
    const { ctx, upstream } = await mount({ useNativeCompaction: true })
    const session = ctx.sessions.create('session-compaction-short' as never)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append(
      'system/message',
      { turn: 1, step: 1, message: createSystemMessage('You are a coding agent.') },
      { surfaceOp: 'append' },
    )
    session.append('user/message', userMessage('Short prompt'), { surfaceOp: 'append' })
    session.append(
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: assistantMessage(`short answer ${'z'.repeat(600)}`),
        stream: [],
      },
      { surfaceOp: 'append' },
    )
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('user/message', userMessage('Next'), { surfaceOp: 'append' })
    const { agent } = manualAgent(session)

    const result = await ctx.compaction.compactNow(agent as never, new AbortController().signal)

    expect(result).not.toBeNull()
    // The native request ran, then the size gate rejected its checkpoint.
    expect(upstream.compactionBodies).toHaveLength(1)
    expect(upstream.standardBodies).toHaveLength(1)
    const text = (result?.summary ?? [])
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('')
    expect(text).toContain('harness summary')
    expect(text).not.toContain('<dsh-openai-codex-compaction-')
  })

  it('falls back when the upstream answers without a compaction item', async () => {
    const { ctx, upstream } = await mount({
      useNativeCompaction: true,
      compaction: () => standardSse('not a checkpoint'),
    })
    const session = seedSession(ctx)
    const { agent } = manualAgent(session)

    const result = await ctx.compaction.compactNow(agent as never, new AbortController().signal)

    expect(result).not.toBeNull()
    expect(upstream.compactionBodies).toHaveLength(1)
    expect(upstream.standardBodies).toHaveLength(1)
    const text = (result?.summary ?? [])
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('')
    expect(text).not.toContain('<dsh-openai-codex-compaction-')
  })

  it('classifies the real core shrink-gate failure without retaining raw error text', async () => {
    // The ordinary summary is deliberately longer than the shadowed span, so the
    // real core shrink gate fails with its own strict sentence.
    const { ctx } = await mount({
      useNativeCompaction: false,
      standard: () => standardSse(`harness summary ${'z'.repeat(40_000)}`),
    })
    const session = seedSession(ctx)
    const failure = await Promise.resolve()
      .then(() => ctx.compaction.compactNow(manualAgent(session).agent as never, new AbortController().signal))
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(ManualCompactionError)
    expect((failure as ManualCompactionError).code).toBe('summary')

    const events = allEvents(session)
    const end = events.find(event => event.type === 'compaction/end')
    const recorded = (end?.data as { error?: string } | undefined)?.error
    expect(typeof recorded).toBe('string')
    // The durable log carries the core's generated sentence, not a test fixture.
    expect(recorded).toMatch(
      /^summary is not smaller than the shadowed content \(\d+ estimated framed tokens >= \d+\)$/,
    )

    // The product projection maps exactly that string to a fixed reason.
    const view = foldCompactionEvents(events as never)
    expect(view.facts).toHaveLength(1)
    expect(view.facts[0]?.status).toBe('failed')
    expect(view.facts[0]?.failureReason).toBe('not-smaller')
    // And it never re-emits the raw error text.
    const wire = JSON.stringify(view)
    expect(wire).not.toContain('estimated framed tokens')
    expect(wire).not.toContain(recorded as string)
  })

  it('keeps a tool call and its result inside one compacted span', async () => {
    const { ctx, upstream } = await mount({ useNativeCompaction: true })
    const { session, callSeq, resultSeq } = seedToolPairSession(ctx)
    const { agent } = manualAgent(session)

    const result = await ctx.compaction.compactNow(agent as never, new AbortController().signal)

    expect(result).not.toBeNull()
    const shadowed = result?.shadowedSeqs ?? []
    expect(shadowed).toContain(callSeq)
    expect(shadowed).toContain(resultSeq)
    // The retained tail node keeps its own position; the pair never splits.
    expect(shadowed).not.toContain(session.surface.nodes.at(-1))
    expect(upstream.compactionBodies).toHaveLength(1)
    expect(upstream.standardBodies).toHaveLength(0)
    const input = upstream.compactionBodies[0]?.['input'] as unknown[] | undefined
    const functionCall = input?.find(item =>
      typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'function_call')
    const functionOutput = input?.find(item =>
      typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'function_call_output')
    expect(functionCall).toBeDefined()
    expect(functionOutput).toBeDefined()
  })

  it('round-trips the compacted log through the real JSONL format and forks it', async () => {
    const { ctx } = await mount({ useNativeCompaction: true })
    const session = seedSession(ctx)
    const { agent } = manualAgent(session)
    const result = await ctx.compaction.compactNow(agent as never, new AbortController().signal)
    expect(result).not.toBeNull()

    // Real physical codec: header + one row per durable event.
    const formatHeader = {
      ...session.header,
      delegationDepth: session.header.delegationDepth ?? 0,
    }
    const header = sessionFormatCatalog.encodeCurrentHeader(
      formatHeader as never,
      session.inheritedEventCount as never,
    )
    const rows = allEvents(session).map(event => sessionFormatCatalog.encodeCurrentEvent(event as never))
    const jsonl = [header, ...rows].map(row => JSON.stringify(row)).join('\n') + '\n'
    const restoredHeader = sessionFormatCatalog.readHeader(JSON.parse(JSON.stringify(header)))
    expect(JSON.stringify(restoredHeader)).toContain(session.id)

    const restore = sessionFormatCatalog.createRestore(header, {
      recovery: 'strict',
      validation: 'current',
    })
    const decoded = jsonl.split('\n').filter(line => line.length > 0).slice(1)
    for (const line of decoded) restore.decodeRow(JSON.parse(line))
    const artifact = restore.finish()
    expect(artifact.events).toHaveLength(session.seq)

    // Replay the decoded artifact into a live session: same surface, same checkpoint.
    const restored = ctx.sessions.create('session-compaction-restored' as never, {
      seed: artifact.events as never,
    })
    expect(restored.surface.nodes.length).toBe(session.surface.nodes.length)
    const restoredCheckpoint = allEvents(restored).filter(isCheckpointEvent)
    expect(restoredCheckpoint.length).toBeGreaterThan(0)
    // Shadowed history stays durable but never re-enters the surface.
    expect(allEvents(restored).some(event =>
      event.type === 'assistant/message' && JSON.stringify(event.data).includes('xxxxxxxxxx'))).toBe(true)
    const surfaceText = restored.surface.nodes
      .map(seq => restored.deriveEventMessage(eventAt(restored, seq)))
      .filter(message => message !== null)
      .map(message => JSON.stringify(message))
      .join('\n')
    expect(surfaceText).not.toContain('xxxxxxxxxx')

    // Fork inherits the compacted surface without re-inflating the shadowed span.
    const fork = ctx.sessions.fork(session)
    expect(fork.surface.nodes.length).toBe(session.surface.nodes.length)
    expect(allEvents(fork).filter(isCheckpointEvent).length).toBeGreaterThan(0)
    const forkText = fork.surface.nodes
      .map(seq => fork.deriveEventMessage(eventAt(fork, seq)))
      .filter(message => message !== null)
      .map(message => JSON.stringify(message))
      .join('\n')
    expect(forkText).not.toContain('xxxxxxxxxx')
  })

  it('keeps a real image attachment readable through compaction, continuation, and fork', async () => {
    const { ctx, upstream } = await mount({ useNativeCompaction: true })
    const store = ctx.attachments
    const ref = await store.saveImage({ data: new Uint8Array(PNG_1X1), mediaType: 'image/png' })
    const reread = await store.readImage(ref)
    expect(Buffer.from(reread.data).equals(PNG_1X1)).toBe(true)
    expect(ref.width).toBe(1)
    expect(ref.height).toBe(1)

    const session = ctx.sessions.create('session-compaction-image' as never)
    const append = session.append.bind(session)
    append('turn/start', { turn: 1 })
    append('step/start', { turn: 1, step: 1 })
    append(
      'system/message',
      { turn: 1, step: 1, message: createSystemMessage('You are a coding agent.') },
      { surfaceOp: 'append' },
    )
    append('user/message', userMessage('Refactor the parser.'), { surfaceOp: 'append' })
    append(
      'assistant/message',
      { turn: 1, step: 1, message: assistantMessage('y'.repeat(6_000)), stream: [] },
      { surfaceOp: 'append' },
    )
    append('step/end', { turn: 1, step: 1 })
    append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const imageEvent = append(
      'user/message',
      createUserMessage({
        content: [
          { type: 'text', text: 'Look at this screenshot and keep the layout.' },
          { type: 'image', attachment: ref },
        ],
        source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )

    const result = await ctx.compaction.compactNow(
      manualAgent(session).agent as never,
      new AbortController().signal,
    )
    expect(result).not.toBeNull()
    // The retained tail (with its real attachment) is never inside the compacted span.
    expect(result?.shadowedSeqs ?? []).not.toContain(imageEvent.seq)
    const surface = surfaceMessages(session)
    expect(JSON.stringify(surface)).toContain(ref.attachmentId)
    const afterCompaction = await store.readImage(ref)
    expect(Buffer.from(afterCompaction.data).equals(PNG_1X1)).toBe(true)

    // A continuation request still projects the durable reference as an input image.
    for await (const _chunk of ctx.llm.stream({
      provider: 'openai-codex',
      model: MODEL,
      sessionId: session.id,
      messages: surface,
    })) {
      // Drain; the captured request body is the assertion target.
    }
    const body = upstream.standardBodies.at(-1)
    expect(JSON.stringify(body?.['input'])).toContain('input_image')

    // Fork keeps the same accessible attachment reference.
    const fork = ctx.sessions.fork(session)
    expect(JSON.stringify(surfaceMessages(fork))).toContain(ref.attachmentId)
    const afterFork = await store.readImage(ref)
    expect(Buffer.from(afterFork.data).equals(PNG_1X1)).toBe(true)
  })

  it('recalls pre-compaction tool text through the public query and product port', async () => {
    const { ctx } = await mount({ useNativeCompaction: true })
    await ctx.plugin(TestSessionQuery)
    const token = 'RECALL-7f3a-unique-tool-result'
    const { session, resultSeq } = seedToolPairSession(ctx, {
      sessionId: 'session-compaction-recall',
      resultText: `tool output ${token}`,
    })

    const result = await ctx.compaction.compactNow(
      manualAgent(session).agent as never,
      new AbortController().signal,
    )
    expect(result).not.toBeNull()
    // The unique tool text left the model-visible surface but stayed in the log.
    expect(JSON.stringify(surfaceMessages(session))).not.toContain(token)
    expect(allEvents(session).some(event => JSON.stringify(event.data).includes(token))).toBe(true)

    const controller = new CodexContextController({
      resolveCompaction: () => ({
        compactNow: (agent, signal) => ctx.compaction.compactNow(agent as never, signal),
      }),
      takeoverDeclared: () => false,
      // Mirrors product index.ts: observe exactly the calling Agent's session
      // through the public async query, filter the range, and dispose the lease.
      readHistory: async (agent, range, signal) => {
        const sessionId = agent.session?.id
        const sessionQuery = (ctx as unknown as { get(name: string): unknown }).get('sessionQuery') as
          | typeof ctx.sessionQuery
          | undefined
        if (sessionId === undefined || sessionQuery === undefined) return undefined
        const observation = await sessionQuery.observeSession(sessionId as never, {
          projectionMode: 'none',
          ...(signal === undefined ? {} : { signal }),
        })
        try {
          const all = observation.events
          return {
            events: all.filter(event => event.seq >= range.fromSeq && event.seq < range.toSeqExclusive),
            // Derived from the complete observation, never from the filtered window.
            endSeq: all.reduce((max, event) => Math.max(max, event.seq + 1), 0),
          }
        } finally {
          observation[Symbol.dispose]()
        }
      },
    })

    const agent = { id: session.id, session } as never
    const page = await controller.recall(agent, { query: token })
    expect(page.ok).toBe(true)
    if (!page.ok) return
    expect(page.items.length).toBeGreaterThan(0)
    // The original tool-result event is found by seq, with a bounded snippet.
    expect(page.items[0]?.seq).toBe(resultSeq)
    expect(page.items[0]?.text).toContain(token)
    expect((page.items[0]?.text ?? '').length).toBeLessThanOrEqual(500)

    // The port never addresses another session: a mismatched Agent is refused.
    const refused = await controller.recall({ id: 'other-session', session } as never, { query: token })
    expect(refused.ok).toBe(false)
    expect(refused).toMatchObject({ reason: 'identity' })
    await controller.dispose()
  })

  it('settles a true noop request through one idle-window read', async () => {
    // True-core noop: the tiny session has a single non-system surface node, so
    // `compactNow` returns null before appending any `compaction/start`.
    const { ctx } = await mount({ useNativeCompaction: true })
    await ctx.plugin(TestSessionQuery)
    const session = seedTinySession(ctx)
    const agent = {
      id: session.id,
      session,
      options: { provider: 'openai-codex' },
      // Fixture-only provider-like delay: it keeps the real settle window open
      // long enough for the read to observe it (the client never sleeps).
      async runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
        await new Promise(resolve => setTimeout(resolve, 5))
        return task(new AbortController().signal)
      },
    }
    const controller = new CodexContextController({
      resolveCompaction: () => ({
        compactNow: (target, signal) => ctx.compaction.compactNow(target as never, signal),
      }),
      takeoverDeclared: () => false,
      // Fixture: this engine composition has no agent loop, so the public
      // `turnBoundary` projection is supplied with the loop's real shape.
      resolveSourceTurn: () => ({
        openTurnStartSeq: allEvents(session).find(event => event.type === 'turn/start')?.seq ?? 1,
        lastTurn: 1,
      }),
    })
    // Public agent event feed fixture: the real loop is not mounted here, so the
    // test delivers the durable `turn/end` and then the idle transition.
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const feed = {
      on(event: string, listener: (...args: unknown[]) => void) {
        const current = listeners.get(event) ?? []
        listeners.set(event, [...current, listener])
        return () => {
          listeners.set(event, (listeners.get(event) ?? []).filter(entry => entry !== listener))
        }
      },
      emit(event: string, ...args: unknown[]) {
        for (const listener of listeners.get(event) ?? []) listener(...args)
      },
    }
    const detach = controller.attach(feed as never)
    expect(controller.requestCompaction(agent as never).status).toBe('queued')
    const seqBefore = session.seq

    feed.emit('session/event', session, allEvents(session).find(event => event.type === 'turn/end'))
    feed.emit('agent/status', { agent, status: 'idle' })

    // No start was appended, so this is the real settle window of an own request.
    const settle = controller.settleForRead(session.id)
    expect(settle).toBeDefined()

    // One read through the product path: observe → await settle → fresh observe → fold.
    let observes = 0
    const liveQuery = ctx.sessionQuery
    const snapshot = await readCompactionSnapshot(
      {
        sessionQuery: () => ({
          observeSession: async (id: never, options?: never) => {
            observes += 1
            return liveQuery.observeSession(id, options)
          },
        }) as never,
        diagnostics: new CompactionDiagnostics(),
        sessionStatus: sessionId => controller.statusForSession(sessionId),
        requests: sessionId => controller.requestsForSession(sessionId),
        settleRequests: (sessionId, signal) => controller.settleForRead(sessionId, signal),
      },
      { sessionId: session.id },
    )

    // The idle-time read was awaited once, then re-observed once: no polling.
    expect(observes).toBe(2)
    expect(snapshot.facts).toHaveLength(0)
    expect(snapshot.requests).toHaveLength(1)
    expect(snapshot.requests?.[0]).toMatchObject({ phase: 'noop' })
    expect(snapshot.requests?.[0]?.compactionId).toBeUndefined()
    expect(snapshot.session.state).not.toBe('running')
    // noop appended nothing: the log and its compaction events are untouched.
    expect(session.seq).toBe(seqBefore)
    expect(allEvents(session).filter(event => event.type === 'compaction/start')).toHaveLength(0)
    detach()
    await controller.dispose()
  })
})
