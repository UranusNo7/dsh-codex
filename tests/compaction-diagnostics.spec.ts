import { describe, expect, it, vi } from 'vitest'
import {
  COMPACTION_DOMAIN_NAME,
  CompactionDiagnostics,
  applyCompactionEvent,
  foldCompactionEvents,
  initCompactionProjection,
  openCompactionId,
  openCompactionIdOfState,
  mergeRequestStatuses,
  readCompactionSnapshot,
  viewCompactionProjection,
  type CompactionReadPorts,
  type CompactionSessionEventLike,
} from '../src/compaction-diagnostics.ts'
import {
  COMPACTION_DIAGNOSTICS_VERSION,
  type CompactionDecision,
  type CompactionDiagnostic,
  type CompactionRequestFact,
  type CompactionSessionStatus,
} from '../src/compaction-types.ts'

const MARKER_OPEN = '<dsh-openai-codex-compaction-4f5cf1b7-v1>'
const MARKER_CLOSE = '</dsh-openai-codex-compaction-4f5cf1b7-v1>'

function nativeMarker(payload: unknown = [{ type: 'compaction', encrypted_content: 'opaque' }]): string {
  return `${MARKER_OPEN}${JSON.stringify(payload)}${MARKER_CLOSE}`
}

function event(type: string, seq: number, data: unknown, extra: Partial<CompactionSessionEventLike> = {}): CompactionSessionEventLike {
  return { type, seq, time: 1_700_000_000_000 + seq, data, ...extra }
}

function start(seq: number, compactionId = 'compaction-a'): CompactionSessionEventLike {
  return event('compaction/start', seq, { compactionId, turn: 3 })
}

function summary(
  seq: number,
  compactionId = 'compaction-a',
  usage: unknown = {
    inputTokens: 356_563,
    outputTokens: 3_738,
    totalTokens: 360_301,
    cacheReadTokens: 12,
    cacheWriteTokens: 34,
  },
): CompactionSessionEventLike {
  return event('compaction/summary', seq, {
    compactionId,
    summary: nativeMarker(),
    shadowedRange: { start: 1, end: 9 },
    shadowedSeqs: [1, 2, 3],
    shadowedTokenCount: 41_000,
    provider: 'openai-codex',
    model: 'gpt-6-sol',
    usage,
  })
}

function checkpoint(seq: number, text: string, compactionId = 'compaction-a'): CompactionSessionEventLike {
  return event(
    'user/message',
    seq,
    {
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'compact-checkpoint', compactionId },
    },
    { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 9 } },
  )
}

function end(seq: number, compactionId = 'compaction-a', error?: unknown): CompactionSessionEventLike {
  return event('compaction/end', seq, { compactionId, turn: 3, ...(error === undefined ? {} : { error }) })
}

describe('compaction projection fold', () => {
  it('folds a committed native compaction with its summary facts and usage', () => {
    const view = foldCompactionEvents([
      start(10),
      summary(11),
      checkpoint(12, nativeMarker()),
      end(13),
    ])

    expect(view.v).toBe(COMPACTION_DIAGNOSTICS_VERSION)
    expect(view.facts).toEqual([
      {
        compactionId: 'compaction-a',
        status: 'native',
        startSeq: 10,
        summarySeq: 11,
        checkpointSeq: 12,
        endSeq: 13,
        turn: 3,
        summary: {
          provider: 'openai-codex',
          model: 'gpt-6-sol',
          shadowedTokenCount: 41_000,
          shadowedSeqCount: 3,
          usage: {
            inputTokens: 356_563,
            outputTokens: 3_738,
            totalTokens: 360_301,
            cacheReadTokens: 12,
            cacheWriteTokens: 34,
            source: 'summary-request',
            at: 1_700_000_000_011,
          },
        },
      },
    ])
  })

  it('classifies an ordinary framed summary checkpoint as ordinary', () => {
    const view = foldCompactionEvents([
      start(10),
      summary(11),
      checkpoint(12, '<compacted-summary>\nplain summary\n</compacted-summary>'),
      end(13),
    ])

    expect(view.facts[0]?.status).toBe('ordinary')
    expect(view.facts[0]?.checkpointSeq).toBe(12)
  })

  it('keeps an unmatched start open and treats every real end error as failed', () => {
    const open = foldCompactionEvents([start(10)])
    expect(open.facts[0]?.status).toBe('open')

    // The real core records errorChain(error) as a plain string. It cannot
    // distinguish cancellation, so an errored transaction stays failed.
    const stringError = foldCompactionEvents([
      start(20),
      end(21, 'compaction-a', 'AbortError: the operation was aborted'),
    ])
    expect(stringError.facts[0]?.status).toBe('failed')

    const failed = foldCompactionEvents([
      start(30),
      end(31, 'compaction-a', 'Error: summary failed: secret text'),
    ])
    expect(failed.facts[0]?.status).toBe('failed')
    // Raw error text never reaches the client-visible fact.
    expect(JSON.stringify(failed)).not.toContain('secret text')
  })

  it('does not keep the raw error text in the state', () => {
    const state = [start(1), end(2, 'compaction-a', 'Error: boom')]
      .reduce(applyCompactionEvent, initCompactionProjection())
    expect(JSON.stringify(state)).not.toContain('boom')
    expect(viewCompactionProjection(state).facts[0]?.status).toBe('failed')
  })

  it('maps the core shrink-gate failure text to a fixed reason without keeping it', () => {
    const exact = 'summary is not smaller than the shadowed content (987919 estimated framed tokens >= 321121)'
    const view = foldCompactionEvents([start(1), end(2, 'compaction-a', exact)])

    expect(view.facts[0]?.status).toBe('failed')
    expect(view.facts[0]?.failureReason).toBe('not-smaller')
    // The numbers and wording never leave the Host.
    expect(JSON.stringify(view)).not.toContain('987919')
    expect(JSON.stringify(view)).not.toContain('not smaller than')

    for (const text of [
      'summary is not smaller than the shadowed content',
      `prefix ${exact}`,
      `${exact} suffix`,
      'the operation was aborted',
    ]) {
      const other = foldCompactionEvents([start(1), end(2, 'compaction-a', text)])
      expect(other.facts[0]?.failureReason, text).toBeUndefined()
      expect(other.facts[0]?.status, text).toBe('failed')
    }
  })
  it('marks success only when the checkpoint carries the same real compaction id', () => {
    const view = foldCompactionEvents([
      start(10, 'compaction-a'),
      checkpoint(11, nativeMarker(), 'compaction-b'),
      end(12, 'compaction-a'),
    ])
    // A checkpoint of another transaction cannot prove this one committed.
    expect(view.facts[0]?.checkpointSeq).toBeNull()
    expect(view.facts[0]?.status).toBe('failed')
  })

  it('returns the same state reference for irrelevant events and handles duplicates idempotently', () => {
    const state = applyCompactionEvent(initCompactionProjection(), start(1))
    expect(applyCompactionEvent(state, event('assistant/message', 2, { message: {} }))).toBe(state)
    expect(applyCompactionEvent(state, event('compaction/start', 2, {}))).toBe(state)
    const summarized = applyCompactionEvent(state, summary(2))
    expect(applyCompactionEvent(summarized, summary(3))).toBe(summarized)
  })

  it('rejects prefixed, truncated, malformed, and non-compaction markers', () => {
    const text = nativeMarker()
    const cases = [
      `prefix ${text}`,
      `${text} suffix`,
      text.slice(0, -MARKER_CLOSE.length),
      `${MARKER_OPEN}{not json${MARKER_CLOSE}`,
      nativeMarker([{ type: 'message', role: 'assistant' }]),
      // A summary that merely quotes the marker is not a checkpoint.
      `<compacted-summary>${text}</compacted-summary>`,
    ]
    for (const [index, checkpointText] of cases.entries()) {
      const view = foldCompactionEvents([
        start(10),
        checkpoint(11, checkpointText),
        end(12),
      ])
      expect(view.facts[0]?.status, `case ${index}`).not.toBe('native')
    }
  })

  it('does not treat pi-ai Usage field names as core TokenUsage', () => {
    const view = foldCompactionEvents([
      start(10),
      summary(11, 'compaction-a', { input: 10, output: 2, cacheRead: 1, cacheWrite: 1, totalTokens: 12 }),
      checkpoint(12, '<compacted-summary>plain</compacted-summary>'),
      end(13),
    ])
    // `totalTokens` is a real TokenUsage column, so the group exists, but the
    // pi-ai-only keys must not be invented into it.
    const usage = view.facts[0]?.summary?.usage
    expect(usage).toEqual({ totalTokens: 12, source: 'summary-request', at: 1_700_000_000_011 })
  })

  it('derives activitySeq from own tool call/result pairs without retaining tool text', () => {
    const call = (seq: number, id: string, name = 'codex_context'): CompactionSessionEventLike =>
      event('assistant/message', seq, { message: { role: 'assistant', content: [{ type: 'tool-call', id, name, arguments: '{"action":"request_compaction"}' }] } })
    const result = (seq: number, callId: string): CompactionSessionEventLike =>
      event('tool/result', seq, { message: { role: 'toolResult', content: [{ type: 'text', text: 'accepted' }], source: { callId } } })

    const before = foldCompactionEvents([
      call(5, 'call-own'),
      result(6, 'call-own'),
      // An unrelated tool call never moves the status signal.
      call(7, 'call-other', 'read_image'),
      event('assistant/message', 8, { message: { content: [{ type: 'text', text: 'hello' }] } }),
    ])
    expect(before.activitySeq).toBe(6)

    const pending = foldCompactionEvents([call(9, 'call-pending')])
    expect(pending.activitySeq).toBe(9)

    const compactionOnly = foldCompactionEvents([start(11)])
    expect(compactionOnly.activitySeq).toBe(11)

    // No tool arguments or result text survive into the projection value.
    const wire = JSON.stringify(foldCompactionEvents([
      call(12, 'call-own'),
      result(13, 'call-own'),
    ]))
    expect(wire).not.toContain('request_compaction')
    expect(wire).not.toContain('accepted')
  })
  it('finds exactly one open compaction, refusing ambiguous starts', () => {
    expect(openCompactionId(foldCompactionEvents([start(1, 'a'), end(2, 'a')]))).toBeUndefined()
    expect(openCompactionId(foldCompactionEvents([start(1, 'a')]))).toBe('a')
    expect(openCompactionId(foldCompactionEvents([start(1, 'a'), start(2, 'b')]))).toBeUndefined()
    const state = [start(5, 'z')].reduce(applyCompactionEvent, initCompactionProjection())
    expect(openCompactionIdOfState(state)).toBe('z')
    expect(openCompactionIdOfState(undefined)).toBeUndefined()
  })
})

interface FakeDomainState {
  opened: number
  closed: number
  putRejected: boolean
  records: Map<string, unknown>
  events: string[]
}

function fakeDomain(overrides: {
  openGate?: () => Promise<void>
  putGate?: () => Promise<void>
  openError?: Error
  existing?: boolean
} = {}) {
  const state: FakeDomainState = {
    opened: 0,
    closed: 0,
    putRejected: false,
    records: new Map(),
    events: [],
  }
  const get = vi.fn(() => undefined)
  const table = {
    get: (key: string) => state.records.get(key),
    put: async (key: string, value: unknown) => {
      state.events.push('put')
      await overrides.putGate?.()
      if (state.putRejected) throw new Error('disk full')
      state.records.set(key, value)
    },
    entries: () => state.records.entries(),
  }
  const handle = {
    table: () => table,
    close: async () => {
      state.events.push('close')
      state.closed += 1
    },
  }
  const facility = {
    get,
    open: async (spec: unknown) => {
      state.opened += 1
      state.events.push('open')
      await overrides.openGate?.()
      if (overrides.openError !== undefined) throw overrides.openError
      return handle
    },
  }
  return { state, facility, get, table, handle }
}

function decision(overrides: Partial<CompactionDecision> = {}): CompactionDecision {
  return {
    sessionId: 'session-a',
    reason: 'selected-native',
    at: 1_000,
    sourceEstimate: { tokens: 900, source: 'source-text', estimator: 'host-token-meter', at: 990 },
    markerEstimate: { tokens: 100, source: 'marker', estimator: 'host-token-meter', at: 995 },
    nativeUsage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, source: 'native-request', at: 996 },
    ...overrides,
  }
}

describe('compaction diagnostics store', () => {
  it('persists one sanitized record per real compaction id and reports durable metadata', async () => {
    const domain = fakeDomain()
    const diagnostics = new CompactionDiagnostics({
      storage: () => domain.facility,
      resolveCompactionId: () => 'compaction-a',
    })

    diagnostics.recordDecision(decision())
    await diagnostics.settled()

    expect(diagnostics.persistent).toBe(true)
    expect(domain.state.opened).toBe(1)
    expect([...domain.state.records.keys()]).toEqual(['session-a/compaction-a'])
    const records = await diagnostics.recordsFor('session-a')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ compactionId: 'compaction-a', decision: 'selected-native' })
    expect(domain.state.events).not.toContain('close')
    await diagnostics.dispose()
    expect(domain.state.closed).toBe(1)
  })

  it('keeps an unlinked decision in memory and never persists a guessed id', async () => {
    const domain = fakeDomain()
    const diagnostics = new CompactionDiagnostics({
      storage: () => domain.facility,
      resolveCompactionId: () => undefined,
    })

    diagnostics.recordDecision(decision())
    await diagnostics.settled()

    expect(domain.state.records.size).toBe(0)
    expect(diagnostics.latest('session-a')).toMatchObject({ compactionId: null })
    await expect(diagnostics.recordsFor('session-a')).resolves.toHaveLength(1)
  })

  it('whitelists the record shape so extra raw fields never reach the readonly RPC', async () => {
    const diagnostics = new CompactionDiagnostics({ resolveCompactionId: () => 'compaction-a' })
    const raw = decision() as CompactionDecision & { secret?: string; opaque?: unknown }
    raw.secret = 'prompt text'
    raw.opaque = { huge: 'payload' }

    diagnostics.recordDecision(raw)

    const latest = diagnostics.latest('session-a')
    expect(JSON.stringify(latest)).not.toContain('prompt text')
    expect(JSON.stringify(latest)).not.toContain('payload')
    expect(Object.keys(latest ?? {}).sort()).toEqual(
      ['at', 'compactionId', 'decision', 'markerEstimate', 'nativeUsage', 'sourceEstimate'].sort(),
    )
  })

  it('reports persistent false when a write fails but keeps the memory record', async () => {
    const domain = fakeDomain()
    domain.state.putRejected = true
    const diagnostics = new CompactionDiagnostics({
      storage: () => domain.facility,
      resolveCompactionId: () => 'compaction-a',
    })

    diagnostics.recordDecision(decision())
    await diagnostics.settled()

    expect(diagnostics.persistent).toBe(false)
    expect(await diagnostics.recordsFor('session-a')).toHaveLength(1)
  })

  it('falls back to memory without borrowing an already-open domain', async () => {
    const domain = fakeDomain({ openError: new Error('already-open') })
    const diagnostics = new CompactionDiagnostics({
      storage: () => domain.facility,
      resolveCompactionId: () => 'compaction-a',
    })

    diagnostics.recordDecision(decision())
    await diagnostics.settled()
    await diagnostics.dispose()

    expect(domain.get).not.toHaveBeenCalled()
    expect(diagnostics.persistent).toBe(false)
    expect(domain.state.closed).toBe(0)
    expect(await diagnostics.recordsFor('session-a')).toHaveLength(1)
  })

  it('settles an in-flight open on dispose, closes only its own handle, and never rebuilds', async () => {
    let releaseOpen: () => void = () => undefined
    const domain = fakeDomain({ openGate: () => new Promise<void>(resolve => { releaseOpen = resolve }) })
    const diagnostics = new CompactionDiagnostics({
      storage: () => domain.facility,
      resolveCompactionId: () => 'compaction-a',
    })

    diagnostics.recordDecision(decision())
    const disposing = diagnostics.dispose()
    releaseOpen()
    await disposing

    expect(domain.state.opened).toBe(1)
    expect(domain.state.closed).toBe(1)
    expect(diagnostics.persistent).toBe(false)
    // A late decision after disposal neither reopens nor writes.
    diagnostics.recordDecision(decision())
    await diagnostics.settled()
    expect(domain.state.opened).toBe(1)
    expect(domain.state.events.filter(entry => entry === 'close')).toHaveLength(1)
  })

  it('drains an in-flight write before closing the domain', async () => {
    let releasePut: () => void = () => undefined
    const domain = fakeDomain({ putGate: () => new Promise<void>(resolve => { releasePut = resolve }) })
    const diagnostics = new CompactionDiagnostics({
      storage: () => domain.facility,
      resolveCompactionId: () => 'compaction-a',
    })

    diagnostics.recordDecision(decision())
    // Wait until the open finished and the blocked put actually started.
    for (let tick = 0; tick < 50 && !domain.state.events.includes('put'); tick += 1) {
      await Promise.resolve()
    }
    expect(domain.state.events).toEqual(['open', 'put'])
    const disposing = diagnostics.dispose()
    releasePut()
    await disposing

    expect(domain.state.events).toEqual(['open', 'put', 'close'])
  })
})

function observation(events: readonly CompactionSessionEventLike[]) {
  const dispose = vi.fn()
  return {
    lease: { events, [Symbol.dispose]: dispose },
    dispose,
  }
}

function remotePorts(options: {
  events?: readonly CompactionSessionEventLike[]
  diagnostics?: CompactionDiagnostics
  status?: CompactionSessionStatus
} = {}) {
  const observeSession = vi.fn(async (
    _sessionId: string,
    _init: { signal?: AbortSignal; projectionMode?: 'all' | 'none' } = {},
  ) => observation(options.events ?? [start(1), checkpoint(2, nativeMarker()), end(3)]).lease)
  const ports: CompactionReadPorts = {
    sessionQuery: () => ({ observeSession }),
    diagnostics: options.diagnostics ?? new CompactionDiagnostics(),
    ...options.status === undefined ? {} : { sessionStatus: () => options.status },
    now: () => 42,
  }
  return { ports, observeSession }
}

describe('readonly compaction snapshot', () => {
  it('validates visibility with a disposed cold observation and folds its events', async () => {
    const observed = observation([start(1), checkpoint(2, nativeMarker()), end(3)])
    const observeSession = vi.fn(async () => observed.lease)
    const ports = {
      sessionQuery: () => ({ observeSession }),
      diagnostics: new CompactionDiagnostics(),
      now: () => 42,
    }
    const controller = new AbortController()

    const snapshot = await readCompactionSnapshot(ports, { sessionId: 'session-a' }, controller.signal)

    expect(observeSession).toHaveBeenCalledTimes(1)
    expect(observeSession).toHaveBeenCalledWith('session-a', {
      signal: controller.signal,
      projectionMode: 'none',
    })
    expect(observed.dispose).toHaveBeenCalledTimes(1)
    expect(snapshot.v).toBe(COMPACTION_DIAGNOSTICS_VERSION)
    expect(snapshot.facts).toHaveLength(1)
    expect(snapshot.facts[0]?.status).toBe('native')
    expect(snapshot.session).toEqual({
      state: 'unknown',
      owner: { state: 'unknown', evidence: [] },
      at: 42,
    })
    expect(snapshot.persistent).toBe(false)
  })

  it('returns only the addressed session diagnostics', async () => {
    const diagnostics = new CompactionDiagnostics({ resolveCompactionId: () => 'compaction-a' })
    diagnostics.recordDecision(decision({ sessionId: 'session-b' }))
    diagnostics.recordDecision(decision({ sessionId: 'session-a' }))
    const { ports } = remotePorts({ diagnostics, events: [start(1)] })

    const snapshot = await readCompactionSnapshot(ports, { sessionId: 'session-a' })

    expect(snapshot.records).toHaveLength(1)
    expect(snapshot.records[0]?.compactionId).toBe('compaction-a')
    expect(snapshot.facts.map(fact => fact.compactionId)).toEqual(['compaction-a'])
  })

  it('merges controller status without inventing one', async () => {
    const status: CompactionSessionStatus = {
      state: 'running',
      owner: { state: 'declared-takeover', evidence: ['external gate declared'], provider: 'other' },
      at: 7,
      requestId: 'request-1',
    }
    const { ports } = remotePorts({ status })

    const snapshot = await readCompactionSnapshot(ports, { sessionId: 'session-a' })

    expect(snapshot.session).toEqual(status)
  })

  it('rejects a malformed request and maps an unknown session without leaking it', async () => {
    const { ports, observeSession } = remotePorts()

    await expect(readCompactionSnapshot(ports, {} as never)).rejects.toMatchObject({
      code: 'gateway/bad-request',
    })
    observeSession.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' }))
    await expect(readCompactionSnapshot(ports, { sessionId: 'other' })).rejects.toMatchObject({
      code: 'gateway/internal',
    })
  })

  it('refines a failed fact to cancelled only from a real aborted record of the same id', async () => {
    const events = [start(1, 'compaction-a'), end(2, 'compaction-a', 'Error: aborted by user')]
    const noRecord = remotePorts({ events })
    const failed = await readCompactionSnapshot(noRecord.ports, { sessionId: 'session-a' })
    expect(failed.facts[0]?.status).toBe('failed')

    const diagnostics = new CompactionDiagnostics({ resolveCompactionId: () => 'compaction-a' })
    diagnostics.recordDecision({ sessionId: 'session-a', reason: 'aborted', at: 5 })

    const matching = await readCompactionSnapshot(
      remotePorts({ events, diagnostics }).ports,
      { sessionId: 'session-a' },
    )
    expect(matching.facts[0]?.status).toBe('cancelled')
    expect(matching.records[0]?.decision).toBe('aborted')

    // A record of another transaction never reclassifies this fact.
    const other = new CompactionDiagnostics({ resolveCompactionId: () => 'compaction-b' })
    other.recordDecision({ sessionId: 'session-a', reason: 'aborted', at: 6 })
    const unrelated = await readCompactionSnapshot(
      remotePorts({ events, diagnostics: other }).ports,
      { sessionId: 'session-a' },
    )
    expect(unrelated.facts[0]?.status).toBe('failed')
  })
})

describe('compaction diagnostics store fixtures', () => {
  it('names the plugin-owned domain', () => {
    expect(COMPACTION_DOMAIN_NAME).toBe('dsh-codex-compaction')
  })

  it('keeps records typed as CompactionDiagnostic after the RPC whitelist', async () => {
    const diagnostics = new CompactionDiagnostics({ resolveCompactionId: () => 'compaction-a' })
    diagnostics.recordDecision(decision())
    const records: readonly CompactionDiagnostic[] = await diagnostics.recordsFor('session-a')
    expect(records[0]?.decision).toBe('selected-native')
  })
})

describe('compaction request diagnostics merge', () => {
  const eventsFor = (compactionId: string): CompactionSessionEventLike[] => [
    start(10, compactionId),
    summary(11, compactionId),
    checkpoint(12, nativeMarker(), compactionId),
    end(13, compactionId),
  ]

  it('joins each request to its own compaction id and never to another request', () => {
    const facts = foldCompactionEvents(eventsFor('compaction-a')).facts
    const requests: CompactionRequestFact[] = [
      { requestId: 'req-a', phase: 'queued', queuedAt: 1, compactionId: 'compaction-a', startedAt: 2 },
      { requestId: 'req-b', phase: 'queued', queuedAt: 3, compactionId: 'compaction-b', startedAt: 4 },
    ]

    const merged = mergeRequestStatuses(facts, requests)

    expect(merged[0]).toMatchObject({
      requestId: 'req-a',
      phase: 'completed',
      result: 'native',
      checkpointSeq: 12,
      summarySeq: 11,
    })
    // The second request has no matching fact: still queued, never "completed".
    expect(merged[1]).toMatchObject({ requestId: 'req-b', phase: 'queued' })
    expect(merged[1]?.result).toBeUndefined()
    expect(merged[1]?.checkpointSeq).toBeUndefined()
  })

  it('overrides a stale running phase when the core end already committed', () => {
    const facts = foldCompactionEvents(eventsFor('compaction-a')).facts
    const merged = mergeRequestStatuses(facts, [
      { requestId: 'req-a', phase: 'running', startedAt: 2, compactionId: 'compaction-a' },
    ])

    expect(merged[0]?.phase).toBe('completed')
    expect(merged[0]?.result).toBe('native')
  })

  it('downgrades an unproven completed claim and never fabricates checkpoints', () => {
    const facts = foldCompactionEvents(eventsFor('compaction-a')).facts

    // Completed without any matching fact is unknown, not success.
    const unproven = mergeRequestStatuses(facts, [
      { requestId: 'req-x', phase: 'completed', compactionId: 'compaction-b' },
    ])[0]
    expect(unproven?.phase).toBe('unknown')
    expect(unproven?.result).toBeUndefined()
    expect(unproven?.checkpointSeq).toBeUndefined()

    // No-event terminals keep their phase and gain no checkpoint fields.
    for (const phase of ['noop', 'skipped-busy', 'refused', 'cancelled'] as const) {
      const merged = mergeRequestStatuses([], [{ requestId: `req-${phase}`, phase }])
      expect(merged[0]).toMatchObject({ phase })
      expect(merged[0]?.checkpointSeq).toBeUndefined()
      expect(merged[0]?.result).toBeUndefined()
    }
  })

  it('reports no requests at all when the controller has no facts (restart)', async () => {
    const observeSession = vi.fn(async (_sessionId: string, _init: { signal?: AbortSignal; projectionMode?: 'all' | 'none' } = {}) =>
      observation([]).lease)
    const ports = {
      sessionQuery: () => ({ observeSession }),
      diagnostics: new CompactionDiagnostics(),
      now: () => 42,
    }

    const snapshot = await readCompactionSnapshot(ports, { sessionId: 'session-a' })

    expect(snapshot.requests).toBeUndefined()
  })

  it('awaits the causal settle window and then takes a fresh observation', async () => {
    const observes: Array<readonly CompactionSessionEventLike[]> = [
      [start(10, 'compaction-a')],
      eventsFor('compaction-a'),
    ]
    let call = 0
    const observeSession = vi.fn(async () => observation(observes[Math.min(call++, observes.length - 1)] ?? []).lease)
    let settled = false
    const ports = {
      sessionQuery: () => ({ observeSession }),
      diagnostics: new CompactionDiagnostics(),
      requests: () => [{ requestId: 'req-a', phase: 'running' as const, compactionId: 'compaction-a' }],
      settleRequests: () => {
        settled = true
        return Promise.resolve()
      },
      now: () => 42,
    }

    const snapshot = await readCompactionSnapshot(ports, { sessionId: 'session-a' })

    expect(settled).toBe(true)
    // The first observation authorized visibility; the second one is the fresh
    // snapshot taken after settling, so the completion is not missed.
    expect(observeSession).toHaveBeenCalledTimes(2)
    expect(snapshot.facts[0]?.status).toBe('native')
    expect(snapshot.requests?.[0]).toMatchObject({ phase: 'completed', result: 'native' })
  })

  it('does not observe twice when nothing is settling', async () => {
    const observeSession = vi.fn(async () => observation(eventsFor('compaction-a')).lease)
    const ports = {
      sessionQuery: () => ({ observeSession }),
      diagnostics: new CompactionDiagnostics(),
      settleRequests: () => undefined,
    }

    await readCompactionSnapshot(ports, { sessionId: 'session-a' })

    expect(observeSession).toHaveBeenCalledTimes(1)
  })
})

describe('compaction request metadata persistence', () => {
  it('annotates a record with the real request id and acceptance time', async () => {
    const diagnostics = new CompactionDiagnostics({ resolveCompactionId: () => 'compaction-a' })
    diagnostics.recordDecision(decision())
    diagnostics.linkRequest('session-a', {
      requestId: 'request-1',
      compactionId: 'compaction-a',
      queuedAt: 900,
    })

    const records = await diagnostics.recordsFor('session-a')
    expect(records[0]).toMatchObject({
      compactionId: 'compaction-a',
      requestId: 'request-1',
      queuedAt: 900,
    })
  })

  it('links a decision that arrives after the queued request was known', async () => {
    const diagnostics = new CompactionDiagnostics({ resolveCompactionId: () => 'compaction-a' })
    diagnostics.linkRequest('session-a', { requestId: 'request-1', compactionId: 'compaction-a', queuedAt: 900 })
    diagnostics.recordDecision(decision())

    const records = await diagnostics.recordsFor('session-a')
    expect(records[0]).toMatchObject({ requestId: 'request-1', queuedAt: 900 })
  })
})

describe('compaction request restart recovery', () => {
  function eventsForRequest(): CompactionSessionEventLike[] {
    return [
      start(10, 'compaction-a'),
      checkpoint(11, nativeMarker(), 'compaction-a'),
      end(12, 'compaction-a'),
    ]
  }

  async function persistRecord(
    domain: ReturnType<typeof fakeDomain>,
    link: { requestId?: string; queuedAt?: number } | undefined,
  ): Promise<void> {
    const writer = new CompactionDiagnostics({
      storage: () => domain.facility,
      resolveCompactionId: () => 'compaction-a',
    })
    writer.recordDecision(decision())
    if (link?.requestId !== undefined) {
      writer.linkRequest('session-a', {
        requestId: link.requestId,
        compactionId: 'compaction-a',
        ...(link.queuedAt === undefined ? {} : { queuedAt: link.queuedAt }),
      })
    }
    await writer.settled()
    await writer.dispose()
  }

  it('recovers a completed request from its persisted link and matching end fact', async () => {
    const domain = fakeDomain()
    await persistRecord(domain, { requestId: 'request-1', queuedAt: 900 })

    // A brand-new instance simulates a restart: only the storage domain remains.
    const restarted = new CompactionDiagnostics({ storage: () => domain.facility })
    const snapshot = await readCompactionSnapshot({
      sessionQuery: () => ({ observeSession: async () => observation(eventsForRequest()).lease }),
      diagnostics: restarted,
    }, { sessionId: 'session-a' })

    expect(snapshot.requests).toHaveLength(1)
    expect(snapshot.requests?.[0]).toMatchObject({
      requestId: 'request-1',
      phase: 'completed',
      result: 'native',
      compactionId: 'compaction-a',
      queuedAt: 900,
      checkpointSeq: 11,
    })
    await restarted.dispose()
  })

  it('keeps requests absent when the persisted record carries no real link', async () => {
    const domain = fakeDomain()
    await persistRecord(domain, undefined)

    const restarted = new CompactionDiagnostics({ storage: () => domain.facility })
    const snapshot = await readCompactionSnapshot({
      sessionQuery: () => ({ observeSession: async () => observation(eventsForRequest()).lease }),
      diagnostics: restarted,
    }, { sessionId: 'session-a' })

    expect(snapshot.requests).toBeUndefined()
    await restarted.dispose()
  })

  it('uses cancellation-refined facts so an aborted request is not reported failed', async () => {
    const domain = fakeDomain()
    const writer = new CompactionDiagnostics({
      storage: () => domain.facility,
      resolveCompactionId: () => 'compaction-a',
    })
    writer.recordDecision({ sessionId: 'session-a', reason: 'aborted', at: 5 })
    writer.linkRequest('session-a', { requestId: 'request-1', compactionId: 'compaction-a' })
    await writer.settled()
    await writer.dispose()

    const restarted = new CompactionDiagnostics({ storage: () => domain.facility })
    const snapshot = await readCompactionSnapshot({
      sessionQuery: () => ({
        observeSession: async () => observation([
          start(10, 'compaction-a'),
          end(11, 'compaction-a', 'Error: aborted by user'),
        ]).lease,
      }),
      diagnostics: restarted,
    }, { sessionId: 'session-a' })

    expect(snapshot.requests?.[0]).toMatchObject({ requestId: 'request-1', phase: 'cancelled' })
    expect(snapshot.requests?.[0]?.result).toBeUndefined()
    await restarted.dispose()
  })
})

describe('compaction request open-fact boundaries', () => {
  const openFact = (): CompactionSessionEventLike[] => [start(10, 'compaction-a')]

  it('keeps a recovered link unknown while its start fact stays open', async () => {
    const domain = fakeDomain()
    const writer = new CompactionDiagnostics({
      storage: () => domain.facility,
      resolveCompactionId: () => 'compaction-a',
    })
    writer.recordDecision(decision())
    writer.linkRequest('session-a', { requestId: 'request-1', compactionId: 'compaction-a', queuedAt: 900 })
    await writer.settled()
    await writer.dispose()

    // Restart: persisted link + open start fact, no live controller operation.
    const restarted = new CompactionDiagnostics({ storage: () => domain.facility })
    const snapshot = await readCompactionSnapshot({
      sessionQuery: () => ({ observeSession: async () => observation(openFact()).lease }),
      diagnostics: restarted,
    }, { sessionId: 'session-a' })

    expect(snapshot.requests?.[0]).toMatchObject({ requestId: 'request-1', phase: 'unknown' })
    await restarted.dispose()
  })

  it('reports running only when a live controller phase says so', async () => {
    const diagnostics = new CompactionDiagnostics()
    const snapshot = await readCompactionSnapshot({
      sessionQuery: () => ({ observeSession: async () => observation(openFact()).lease }),
      diagnostics,
      requests: () => [{ requestId: 'request-live', phase: 'running', compactionId: 'compaction-a', startedAt: 5 }],
    }, { sessionId: 'session-a' })

    expect(snapshot.requests?.[0]).toMatchObject({ requestId: 'request-live', phase: 'running' })
    await diagnostics.dispose()
  })
})
