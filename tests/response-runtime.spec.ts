import { describe, expect, it } from 'vitest'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  Transport,
  Usage,
} from '@earendil-works/pi-ai'
import type { Api } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import {
  OPENAI_CODEX_CHECKPOINT_FRAME_ALLOWANCE,
  OpenAICodexResponseRuntime,
  expandNativeCompactionMarkers,
} from '../src/responses.ts'
import type { CompactionDecision } from '../src/compaction-types.ts'

function runtimeHarness(initialReuse: boolean) {
  let reuse = initialReuse
  const transports: Array<Transport | undefined> = []
  const streamOptions: SimpleStreamOptions[] = []
  const base = openaiCodexProvider()
  const provider = {
    ...base,
    streamSimple: (_model, _context, options?: SimpleStreamOptions) => {
      transports.push(options?.transport)
      if (options !== undefined) streamOptions.push(options)
      return createAssistantMessageEventStream()
    },
  } satisfies typeof base
  const runtime = new OpenAICodexResponseRuntime(() => ({
    useWebSocketContextReuse: reuse,
    useNativeCompaction: false,
  }))
  const wrapped = runtime.wrap(provider)
  const model = base.getModels().find(candidate => candidate.id === 'gpt-5.6-sol')
    ?? base.getModels()[0]
  if (model === undefined) throw new Error('Codex provider has no test model')
  const call = (sessionId: string): void => {
    wrapped.streamSimple(model, { messages: [] }, { sessionId })
  }
  return {
    transports,
    streamOptions,
    runtime,
    model,
    call,
    setReuse(value: boolean): void { reuse = value },
  }
}

describe('OpenAICodexResponseRuntime transport policy', () => {
  it('uses explicit SSE while context reuse is disabled', () => {
    const harness = runtimeHarness(false)

    harness.call('session-sse')

    expect(harness.transports).toEqual(['sse'])
  })

  it('delegates matching continuation state to pi-ai WebSocket caching', () => {
    const harness = runtimeHarness(true)

    harness.call('session-websocket')

    expect(harness.transports).toEqual(['websocket-cached'])
  })

  it('preserves the provider-owned store:false payload', async () => {
    const harness = runtimeHarness(true)
    harness.call('session-store-false')

    const transformed = await harness.streamOptions[0]?.onPayload?.({ store: false, input: [] }, harness.model)

    expect(transformed).toEqual({ store: false, input: [] })
  })

  it('keeps Harness compaction calls off the conversation WebSocket chain', () => {
    const harness = runtimeHarness(true)
    const leaveCompaction = harness.runtime.enterCompaction('session-compact')

    harness.call('session-compact')
    leaveCompaction()
    harness.call('session-compact')

    expect(harness.transports).toEqual(['sse', 'websocket-cached'])
  })

  it('applies live preference changes without retaining plugin continuation state', () => {
    const harness = runtimeHarness(false)

    harness.call('session-live')
    harness.setReuse(true)
    harness.call('session-live')
    harness.setReuse(false)
    harness.call('session-live')

    expect(harness.transports).toEqual(['sse', 'websocket-cached', 'sse'])
  })
})

const MARKER_OPEN = '<dsh-openai-codex-compaction-4f5cf1b7-v1>'
const MARKER_CLOSE = '</dsh-openai-codex-compaction-4f5cf1b7-v1>'

/** Core-compatible chars/4 heuristic (block +4, role +4), copied into the test. */
function heuristicEstimate(text: string): number {
  return Math.ceil(text.length / 4) + 8
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function textSummaryStream(model: Model<Api>, text: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  const message: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-codex-responses',
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: 'stop',
    timestamp: Date.now(),
  }
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: message })
    stream.push({ type: 'done', reason: 'stop', message })
  })
  return stream
}

/** The exact durable marker the runtime builds for one converted user message. */
function expectedMarker(opaque: string, userText = 'keep this request'): string {
  const output = [
    { role: 'user', content: [{ type: 'input_text', text: userText }] },
    { type: 'compaction', id: 'cmp_item_1', encrypted_content: opaque },
  ]
  return `${MARKER_OPEN}${JSON.stringify(output)}${MARKER_CLOSE}`
}

function compactionResponse(opaque: string): Response {
  const events = [
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'compaction', id: 'cmp_item_1', encrypted_content: opaque },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_native_gate',
        status: 'completed',
        output: [],
        usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
      },
    },
  ]
  return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** The same native response with an arbitrary (or absent) provider usage object. */
function compactionResponseWithUsage(usage: unknown): Response {
  const events = [
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'compaction', id: 'cmp_item_1', encrypted_content: 'opaque-checkpoint' },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_native_usage',
        status: 'completed',
        output: [],
        ...usage === undefined ? {} : { usage },
      },
    },
  ]
  return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function accessToken(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })}.signature`
}

interface GateHarnessOptions {
  readonly estimateText?: (text: string) => number | undefined
  readonly opaque?: string
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  readonly native?: boolean
}

interface CompactOutcome {
  readonly text: string
  readonly aborted: boolean
}

function gateHarness(options: GateHarnessOptions = {}) {
  const base = openaiCodexProvider()
  const model = base.getModels().find(candidate => candidate.id === 'gpt-5.6-sol')
    ?? base.getModels()[0]
  if (model === undefined) throw new Error('Codex provider has no test model')
  const opaque = options.opaque ?? 'opaque-checkpoint'
  const standardCalls: Array<string | undefined> = []
  const nativeRequests: Array<{ url: string; init?: RequestInit }> = []
  const decisions: CompactionDecision[] = []
  const provider = {
    ...base,
    streamSimple: (_model, _context, streamOptions?: SimpleStreamOptions) => {
      standardCalls.push(streamOptions?.sessionId)
      return textSummaryStream(model, 'standard summary')
    },
  } satisfies typeof base
  const respond = options.fetch ?? (async () => compactionResponse(opaque))
  const requestFetch = async (input: string | URL | Request, init?: RequestInit) => {
    nativeRequests.push({ url: String(input), ...(init === undefined ? {} : { init }) })
    return respond(input, init)
  }
  const runtime = new OpenAICodexResponseRuntime(
    () => ({ useWebSocketContextReuse: false, useNativeCompaction: options.native ?? true }),
    requestFetch as never,
    options.estimateText,
    decision => decisions.push(decision),
  )
  const wrapped = runtime.wrap(provider)
  const context = {
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'keep this request' }],
        timestamp: Date.now(),
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Summarize the conversation.' }],
        timestamp: Date.now(),
      },
    ],
  } as never
  const compact = async (sessionId: string, sourceText: string | undefined, signal?: AbortSignal): Promise<CompactOutcome> => {
    const leave = runtime.enterCompaction(sessionId, sourceText)
    try {
      let text = ''
      let aborted = false
      for await (const event of wrapped.streamSimple(model, context, {
        sessionId,
        apiKey: accessToken('account-1'),
        ...(signal === undefined ? {} : { signal }),
      })) {
        if (event.type === 'text_delta') text += event.delta
        else if (event.type === 'done') text = event.message.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('')
        else if (event.type === 'error') aborted = event.reason === 'aborted'
      }
      return { text, aborted }
    } finally {
      leave()
    }
  }
  return { compact, standardCalls, nativeRequests, decisions, marker: expectedMarker(opaque), opaque }
}

/** Source string whose heuristic price is exactly `budget`. */
function sourceForBudget(budget: number): string {
  return 's'.repeat((budget - 8) * 4)
}

describe('OpenAICodexResponseRuntime native checkpoint preflight', () => {
  it('publishes a small native marker when it is at least the frame allowance below the source', async () => {
    const harness = gateHarness({ estimateText: heuristicEstimate })
    const markerEstimate = heuristicEstimate(harness.marker)

    const outcome = await harness.compact('session-small', sourceForBudget(markerEstimate + OPENAI_CODEX_CHECKPOINT_FRAME_ALLOWANCE + 1))

    expect(outcome.text).toBe(harness.marker)
    expect(harness.nativeRequests).toHaveLength(1)
    expect(harness.standardCalls).toHaveLength(0)
  })

  it('rejects the strict-boundary marker and falls back once to the standard summary', async () => {
    const harness = gateHarness({ estimateText: heuristicEstimate })
    const markerEstimate = heuristicEstimate(harness.marker)

    const outcome = await harness.compact('session-boundary', sourceForBudget(markerEstimate + OPENAI_CODEX_CHECKPOINT_FRAME_ALLOWANCE))

    expect(outcome.text).toBe('standard summary')
    expect(harness.nativeRequests).toHaveLength(1)
    expect(harness.standardCalls).toEqual(['session-boundary'])
  })

  it('skips the native request entirely without a usable estimator or source budget', async () => {
    const noEstimator = gateHarness()
    expect(await noEstimator.compact('session-no-estimator', 'source text')).toMatchObject({
      text: 'standard summary',
      aborted: false,
    })
    expect(noEstimator.nativeRequests).toHaveLength(0)
    expect(noEstimator.standardCalls).toEqual(['session-no-estimator'])

    for (const estimateText of [
      () => undefined,
      () => Number.NaN,
      () => -1,
      () => { throw new Error('estimator unavailable') },
    ]) {
      const harness = gateHarness({ estimateText })
      expect((await harness.compact('session-invalid-estimator', 'source text')).text)
        .toBe('standard summary')
      expect(harness.nativeRequests).toHaveLength(0)
      expect(harness.standardCalls).toEqual(['session-invalid-estimator'])
    }

    const emptySource = gateHarness({ estimateText: heuristicEstimate })
    expect((await emptySource.compact('session-empty-source', '')).text)
      .toBe('standard summary')
    expect(emptySource.nativeRequests).toHaveLength(0)
  })

  it('falls back to the standard summary when only the marker estimation throws', async () => {
    const harness = gateHarness({
      // The source budget succeeds; only pricing the durable marker throws.
      estimateText: (text) => {
        if (text.startsWith(MARKER_OPEN)) throw new Error('marker estimate failed')
        return heuristicEstimate(text)
      },
    })

    const outcome = await harness.compact('session-gate-throws', 'source text')

    expect(outcome.text).toBe('standard summary')
    expect(harness.nativeRequests).toHaveLength(1)
    expect(harness.standardCalls).toEqual(['session-gate-throws'])
  })

  it('propagates cancellation after the native response without requesting a fallback', async () => {
    const controller = new AbortController()
    const harness = gateHarness({
      estimateText: () => 1_000_000,
      fetch: async () => {
        // The native response is already in flight when the caller cancels.
        controller.abort()
        return compactionResponse('opaque-checkpoint')
      },
    })

    const outcome = await harness.compact('session-aborted', 'source text', controller.signal)

    expect(outcome.aborted).toBe(true)
    expect(harness.nativeRequests).toHaveLength(1)
    expect(harness.standardCalls).toHaveLength(0)
  })

  it('binds each compaction call to its own source budget on a shared session', async () => {
    const harness = gateHarness({ estimateText: heuristicEstimate })
    const markerEstimate = heuristicEstimate(harness.marker)

    const large = await harness.compact('session-shared', sourceForBudget(markerEstimate + OPENAI_CODEX_CHECKPOINT_FRAME_ALLOWANCE))
    const small = await harness.compact('session-shared', sourceForBudget(markerEstimate + OPENAI_CODEX_CHECKPOINT_FRAME_ALLOWANCE + 1))

    expect(large.text).toBe('standard summary')
    expect(small.text).toBe(harness.marker)
    expect(harness.nativeRequests).toHaveLength(2)
    expect(harness.standardCalls).toEqual(['session-shared'])
  })

  it('keeps reading the persisted v1 marker format', () => {
    const output = [
      { role: 'user', content: [{ type: 'input_text', text: 'keep this request' }] },
      { type: 'compaction', id: 'cmp_item_1', encrypted_content: 'opaque' },
    ]
    const marker = `${MARKER_OPEN}${JSON.stringify(output)}${MARKER_CLOSE}`

    expect(expandNativeCompactionMarkers([
      { role: 'user', content: [{ type: 'input_text', text: marker }] },
      { role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
    ])).toEqual([
      ...output,
      { role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
    ])
  })
})

describe('OpenAICodexResponseRuntime native usage accuracy', () => {
  const compactWithUsage = async (usage: unknown) => {
    const harness = gateHarness({
      estimateText: heuristicEstimate,
      fetch: async () => compactionResponseWithUsage(usage),
    })
    await harness.compact(
      'session-usage',
      sourceForBudget(heuristicEstimate(expectedMarker('opaque-checkpoint')) + OPENAI_CODEX_CHECKPOINT_FRAME_ALLOWANCE + 2),
    )
    expect(harness.decisions.map(decision => decision.reason)).toEqual(['selected-native'])
    return harness.decisions[0]?.nativeUsage
  }

  it('omits a missing or empty provider usage group entirely', async () => {
    expect(await compactWithUsage(undefined)).toBeUndefined()
    expect(await compactWithUsage({})).toBeUndefined()
  })

  it('keeps only the columns actually reported by the provider', async () => {
    expect(await compactWithUsage({ input_tokens: 30 })).toMatchObject({ inputTokens: 30 })
    const partial = await compactWithUsage({ input_tokens: 30 })
    expect(partial).not.toHaveProperty('outputTokens')
    expect(partial).not.toHaveProperty('cacheReadTokens')
    expect(partial).not.toHaveProperty('cacheWriteTokens')
    expect(partial).not.toHaveProperty('totalTokens')
  })

  it('preserves explicit zeros instead of treating them as absent', async () => {
    expect(await compactWithUsage({ input_tokens: 0, output_tokens: 0, total_tokens: 0 })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      source: 'native-request',
      at: expect.any(Number),
    })
  })

  it('splits the frozen non-cached input shape from reported cache columns only', async () => {
    const usage = await compactWithUsage({
      input_tokens: 40,
      input_tokens_details: { cached_tokens: 10, cache_write_tokens: 5 },
      output_tokens: 2,
      total_tokens: 50,
    })
    expect(usage).toMatchObject({
      inputTokens: 25,
      outputTokens: 2,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      totalTokens: 50,
      source: 'native-request',
    })
  })
})

describe('OpenAICodexResponseRuntime compaction decisions', () => {
  it('records exactly one fixed selection reason per compaction attempt', async () => {
    const selected = gateHarness({ estimateText: heuristicEstimate })
    await selected.compact(
      'session-selected',
      sourceForBudget(heuristicEstimate(selected.marker) + OPENAI_CODEX_CHECKPOINT_FRAME_ALLOWANCE + 2),
    )
    expect(selected.decisions.map(decision => decision.reason)).toEqual(['selected-native'])
    expect(selected.decisions[0]?.sessionId).toBe('session-selected')
    expect(selected.decisions[0]?.sourceEstimate).toMatchObject({
      source: 'source-text',
      estimator: 'host-token-meter',
    })
    expect(selected.decisions[0]?.markerEstimate?.tokens).toBe(heuristicEstimate(selected.marker))
    // Provider usage of the native request is recorded verbatim, never estimated.
    expect(selected.decisions[0]?.nativeUsage).toMatchObject({
      inputTokens: 20,
      outputTokens: 4,
      totalTokens: 24,
      source: 'native-request',
    })

    const boundary = gateHarness({ estimateText: heuristicEstimate })
    await boundary.compact(
      'session-boundary',
      sourceForBudget(heuristicEstimate(boundary.marker) + OPENAI_CODEX_CHECKPOINT_FRAME_ALLOWANCE),
    )
    expect(boundary.decisions.map(decision => decision.reason)).toEqual(['not-smaller'])

    const disabled = gateHarness({ estimateText: heuristicEstimate, native: false })
    await disabled.compact('session-disabled', 'source text')
    expect(disabled.decisions.map(decision => decision.reason)).toEqual(['native-disabled'])
    expect(disabled.nativeRequests).toHaveLength(0)

    const noEstimator = gateHarness()
    await noEstimator.compact('session-no-estimator', 'source text')
    expect(noEstimator.decisions.map(decision => decision.reason)).toEqual(['no-estimator'])

    const noSource = gateHarness({ estimateText: heuristicEstimate })
    await noSource.compact('session-no-source', undefined)
    expect(noSource.decisions.map(decision => decision.reason)).toEqual(['no-source-budget'])
  })

  it('separates a protocol-invalid native response from a transport failure', async () => {
    const invalid = gateHarness({
      estimateText: heuristicEstimate,
      fetch: async () => new Response(
        'data: {"type":"response.completed","response":{"id":"resp_empty","output":[],"usage":{}}}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    })
    await invalid.compact('session-invalid', sourceForBudget(50_000))
    expect(invalid.decisions.map(decision => decision.reason)).toEqual(['invalid-response'])

    const transport = gateHarness({
      estimateText: heuristicEstimate,
      fetch: async () => { throw new Error('network down') },
    })
    await transport.compact('session-transport', sourceForBudget(50_000))
    expect(transport.decisions.map(decision => decision.reason)).toEqual(['native-request-failed'])
  })

  it('reports a real abort and stays silent for ordinary requests', async () => {
    const aborted = gateHarness({
      estimateText: heuristicEstimate,
      fetch: async () => { throw new Error('should not be requested') },
    })
    const controller = new AbortController()
    controller.abort(new Error('user cancel'))

    const outcome = await aborted.compact('session-abort', sourceForBudget(50_000), controller.signal)

    expect(outcome.aborted).toBe(true)
    expect(aborted.decisions.map(decision => decision.reason)).toEqual(['aborted'])
    expect(aborted.standardCalls).toHaveLength(0)

    // A non-compaction call reports nothing: the hook only observes compaction.
    const decisions: CompactionDecision[] = []
    const base = openaiCodexProvider()
    const model = base.getModels()[0]
    if (model === undefined) throw new Error('Codex provider has no test model')
    const runtime = new OpenAICodexResponseRuntime(
      () => ({ useWebSocketContextReuse: false, useNativeCompaction: true }),
      undefined,
      heuristicEstimate,
      decision => decisions.push(decision),
    )
    const wrapped = runtime.wrap({
      ...base,
      streamSimple: () => textSummaryStream(model, 'ordinary answer'),
    } satisfies typeof base)
    for await (const _event of wrapped.streamSimple(model, { messages: [] } as never, { sessionId: 'session-plain' })) {
      // Drain the ordinary stream.
    }
    expect(decisions).toHaveLength(0)
  })
})
