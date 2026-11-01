import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_CONTEXT_PROVIDER,
  COMPACTION_COOLDOWN_MS,
  CodexContextController,
  RECALL_DEFAULT_LIMIT,
  RECALL_MAX_ITEM_CHARS,
  RECALL_MAX_LIMIT,
  RECALL_MAX_SCAN_EVENTS,
  RECALL_MAX_TOTAL_CHARS,
  agentProvider,
  extractEventText,
  takeoverDeclared,
  type CodexCompactionService,
  type CodexContextAgent,
  type CodexContextEvent,
  type CodexContextSession,
  type HistoryPage,
} from '../src/codex-context.ts'

interface EventSourceStub {
  on(event: string, listener: (payload: never) => void): () => void
  emit(event: string, ...args: unknown[]): void
}

function eventSource(): EventSourceStub {
  const listeners = new Map<string, Set<(payload: never) => void>>()
  return {
    on(event, listener) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => {
        set.delete(listener)
      }
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) {
        ;(listener as (...values: unknown[]) => void)(...args)
      }
    },
  }
}

function session(overrides: Partial<CodexContextSession> = {}): CodexContextSession {
  return {
    id: 'session-1',
    requestHeader: () => ({ config: { provider: CODEX_CONTEXT_PROVIDER } }),
    ...overrides,
  }
}

function agent(overrides: Partial<CodexContextAgent> = {}): CodexContextAgent {
  return {
    id: 'session-1',
    session: session(),
    options: { provider: CODEX_CONTEXT_PROVIDER },
    ...overrides,
  }
}

interface ControllerOptions {
  readonly takeover?: boolean
  readonly now?: () => number
  readonly cooldownMs?: number
  readonly idFactory?: () => string
  /** `null` simulates an absent turnBoundary capability. */
  readonly boundary?: { openTurnStartSeq: number | null; lastTurn: number } | null
  readonly history?: readonly CodexContextEvent[]
  readonly endSeq?: number
  readonly readHistory?: (
    target: CodexContextAgent,
    range: { fromSeq: number; toSeqExclusive: number },
    signal?: AbortSignal,
  ) => Promise<HistoryPage | undefined>
}

function controller(
  resolveCompaction: (target: CodexContextAgent) => CodexCompactionService | undefined,
  options: ControllerOptions = {},
): CodexContextController {
  const boundary =
    options.boundary === undefined ? { openTurnStartSeq: 5, lastTurn: 1 } : options.boundary
  return new CodexContextController({
    resolveCompaction,
    takeoverDeclared: () => options.takeover === true,
    ...(boundary === null ? {} : { resolveSourceTurn: () => boundary }),
    ...(options.readHistory === undefined ? {} : { readHistory: options.readHistory }),
    ...(options.history === undefined
      ? {}
      : {
          readHistory: async () => ({
            events: options.history ?? [],
            endSeq: options.endSeq ?? (options.history ?? []).length,
          }),
        }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.cooldownMs === undefined ? {} : { cooldownMs: options.cooldownMs }),
    ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
  })
}

/** Emit the accepted turn's durable end through the existing session feed. */
function finishTurn(source: EventSourceStub, target: CodexContextAgent, kind = 'completed'): void {
  source.emit(
    'session/event',
    { id: target.id },
    { seq: 6, type: 'turn/end', data: { turn: 1, reason: { kind } } },
  )
  source.emit('agent/status', { agent: target, status: 'idle' })
}

function textEvent(seq: number, type: string, text: string): CodexContextEvent {
  const block = [{ type: 'text', text }]
  switch (type) {
    case 'tool/result':
      return { seq, type, data: { message: { role: 'tool', content: block } } }
    case 'user/message':
      return { seq, type, data: { role: 'user', content: block } }
    default:
      return { seq, type, data: { message: { role: 'assistant', content: block } } }
  }
}

describe('agentProvider', () => {
  it('prefers the routed header and falls back to the configured option', () => {
    expect(agentProvider(agent())).toBe(CODEX_CONTEXT_PROVIDER)
    expect(
      agentProvider(
        agent({
          session: session({ requestHeader: () => ({ config: { provider: 'other' } }) }),
          options: { provider: CODEX_CONTEXT_PROVIDER },
        }),
      ),
    ).toBe('other')
    expect(
      agentProvider(
        agent({ session: session({ requestHeader: () => undefined }), options: { provider: 'p' } }),
      ),
    ).toBe('p')
  })
})

describe('takeoverDeclared', () => {
  it('reads only an explicit active declaration from the host record', () => {
    expect(takeoverDeclared({})).toBe(false)
    expect(takeoverDeclared({ __BILI_DSH_COMPACTION_VERDICT__: 'inactive' })).toBe(false)
    expect(takeoverDeclared({ __BILI_DSH_COMPACTION_VERDICT__: 'active' })).toBe(true)
  })
})

describe('CodexContextController owner facts', () => {
  const service: CodexCompactionService = { compactNow: async () => undefined }

  it('reports available only with a scoped service and no takeover declaration', () => {
    const owner = controller(() => service).owner(agent())
    expect(owner).toMatchObject({ state: 'available', provider: CODEX_CONTEXT_PROVIDER })
    expect(owner.evidence).toContain('agent-scoped-compaction-service-present')
  })

  it('reports unavailable without a service and without a declaration', () => {
    expect(controller(() => undefined).owner(agent()).state).toBe('unavailable')
  })

  it('reports declared-takeover for an active declaration and no service', () => {
    expect(controller(() => undefined, { takeover: true }).owner(agent()).state).toBe(
      'declared-takeover',
    )
  })

  it('reports conflict when a scoped service coexists with an active declaration', () => {
    expect(controller(() => service, { takeover: true }).owner(agent()).state).toBe('conflict')
  })
})

describe('CodexContextController request queue', () => {
  it('refuses every owner state other than available without touching compaction', async () => {
    const compactNow = vi.fn(async () => undefined)
    for (const [resolve, options] of [
      [() => undefined, {}],
      [() => undefined, { takeover: true }],
      [() => ({ compactNow }), { takeover: true }],
    ] as const) {
      const instance = controller(resolve as never, options)
      const source = eventSource()
      instance.attach(source as never)
      const target = agent()
      expect(instance.requestCompaction(target).status).toBe('refused')
      finishTurn(source, target)
      await Promise.resolve()
      expect(compactNow).not.toHaveBeenCalled()
    }
  })

  it('refuses a non-Codex agent', () => {
    const instance = controller(() => ({ compactNow: async () => undefined }))
    const result = instance.requestCompaction(
      agent({
        session: session({ requestHeader: () => ({ config: { provider: 'anthropic' } }) }),
        options: { provider: 'anthropic' },
      }),
    )
    expect(result).toMatchObject({ status: 'refused', reason: 'provider' })
  })

  it('refuses when the Agent id and its session id disagree', async () => {
    const instance = controller(() => ({ compactNow: async () => undefined }))
    const mismatched = agent({ id: 'agent-a', session: session({ id: 'session-b' }) })
    expect(instance.requestCompaction(mismatched)).toMatchObject({
      status: 'refused',
      reason: 'identity',
    })
    expect(await instance.recall(mismatched)).toEqual({ ok: false, reason: 'identity' })
  })

  it('accepts one ticket and does not call compactNow inside the request', () => {
    const compactNow = vi.fn(async () => undefined)
    const instance = controller(() => ({ compactNow }))
    const result = instance.requestCompaction(agent())
    expect(result).toMatchObject({
      status: 'queued',
      ticket: { status: 'queued', boundary: 'after-current-turn' },
    })
    expect(compactNow).not.toHaveBeenCalled()
  })

  it('dedupes a second request while one ticket is pending or running', async () => {
    let release: (() => void) | undefined
    const instance = controller(() => ({
      compactNow: () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    }))
    const source = eventSource()
    instance.attach(source as never)
    const target = agent()
    expect(instance.requestCompaction(target).status).toBe('queued')
    expect(instance.requestCompaction(target).status).toBe('already-queued')
    finishTurn(source, target)
    await vi.waitFor(() => expect(release).toBeDefined())
    expect(instance.requestCompaction(target).status).toBe('already-queued')
    release?.()
    await vi.waitFor(() =>
      expect(instance.snapshot(target).lastOutcome).toMatchObject({ state: 'completed' }),
    )
  })

  it('runs once at idle and reports the running boundary to the status reader', async () => {
    const target = agent()
    const calls: Array<{ state?: string }> = []
    const instance = controller(() => ({
      async compactNow() {
        calls.push({ state: instance.statusForSession(target.id)?.state ?? 'unknown' })
      },
    }))
    const source = eventSource()
    instance.attach(source as never)
    instance.requestCompaction(target)
    finishTurn(source, target)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]?.state).toBe('running')
    expect(instance.snapshot(target).lastOutcome).toMatchObject({ state: 'completed' })
    source.emit('agent/status', { agent: target, status: 'idle' })
    await Promise.resolve()
    expect(calls).toHaveLength(1)
  })

  it('records a null result as noop and a busy failure as skipped-busy', async () => {
    const noopTarget = agent()
    const noop = controller(() => ({ compactNow: async () => null }))
    const noopSource = eventSource()
    noop.attach(noopSource as never)
    noop.requestCompaction(noopTarget)
    finishTurn(noopSource, noopTarget)
    await vi.waitFor(() =>
      expect(noop.snapshot(noopTarget).lastOutcome).toMatchObject({ state: 'noop' }),
    )

    const busyTarget = agent()
    const compactNow = vi.fn(async () => {
      throw Object.assign(new Error('busy'), { code: 'busy' })
    })
    const busy = controller(() => ({ compactNow }))
    const busySource = eventSource()
    busy.attach(busySource as never)
    busy.requestCompaction(busyTarget)
    finishTurn(busySource, busyTarget)
    await vi.waitFor(() =>
      expect(busy.snapshot(busyTarget).lastOutcome).toMatchObject({
        state: 'skipped-busy',
        reason: 'busy',
      }),
    )
    expect(compactNow).toHaveBeenCalledTimes(1)
  })

  it('maps cancellation and unknown failures without leaking error text', async () => {
    const codeTarget = agent()
    const cancelledByCode = controller(() => ({
      async compactNow() {
        throw Object.assign(new Error('cancelled by core'), { code: 'cancelled' })
      },
    }))
    const codeSource = eventSource()
    cancelledByCode.attach(codeSource as never)
    cancelledByCode.requestCompaction(codeTarget)
    finishTurn(codeSource, codeTarget)
    await vi.waitFor(() => expect(cancelledByCode.snapshot(codeTarget).lastOutcome).toBeDefined())
    const cancelledOutcome = cancelledByCode.snapshot(codeTarget).lastOutcome
    expect(cancelledOutcome).toMatchObject({ state: 'cancelled' })
    expect(JSON.stringify(cancelledOutcome)).not.toContain('cancelled by core')

    const failedTarget = agent()
    const failed = controller(() => ({
      async compactNow() {
        throw new Error('raw body token=secret')
      },
    }))
    const failSource = eventSource()
    failed.attach(failSource as never)
    failed.requestCompaction(failedTarget)
    finishTurn(failSource, failedTarget)
    await vi.waitFor(() => expect(failed.snapshot(failedTarget).lastOutcome).toBeDefined())
    const failedOutcome = failed.snapshot(failedTarget).lastOutcome
    expect(failedOutcome).toMatchObject({ state: 'failed', reason: 'unknown' })
    expect(JSON.stringify(failedOutcome)).not.toContain('secret')
  })

  it('refuses at acceptance when the turnBoundary capability is absent', () => {
    const target = agent()
    const instance = controller(() => ({ compactNow: async () => undefined }), { boundary: null })
    expect(instance.requestCompaction(target)).toMatchObject({
      status: 'refused',
      reason: 'source-turn',
    })
    expect(instance.pending(target)).toBeUndefined()
    expect(instance.snapshot(target).queued).toBeUndefined()
  })

  it('refuses at acceptance when no turn is open (null open seq)', () => {
    const target = agent()
    const instance = controller(() => ({ compactNow: async () => undefined }), {
      boundary: { openTurnStartSeq: null, lastTurn: 3 },
    })
    expect(instance.requestCompaction(target)).toMatchObject({
      status: 'refused',
      reason: 'source-turn',
    })
  })

  it('does not run a request whose source turn ended cancelled/aborted', async () => {
    const target = agent()
    const compactNow = vi.fn(async () => undefined)
    const instance = controller(() => ({ compactNow }))
    const source = eventSource()
    instance.attach(source as never)
    instance.requestCompaction(target)
    finishTurn(source, target, 'aborted')
    await vi.waitFor(() =>
      expect(instance.snapshot(target).lastOutcome).toMatchObject({ state: 'cancelled' }),
    )
    expect(compactNow).not.toHaveBeenCalled()
    expect(instance.pending(target)).toBeUndefined()
  })

  it('does not run when the source turn end was never observed', async () => {
    const target = agent()
    const compactNow = vi.fn(async () => undefined)
    const instance = controller(() => ({ compactNow }))
    const source = eventSource()
    instance.attach(source as never)
    instance.requestCompaction(target)
    source.emit('agent/status', { agent: target, status: 'idle' })
    await vi.waitFor(() =>
      expect(instance.snapshot(target).lastOutcome).toMatchObject({ state: 'refused' }),
    )
    expect(compactNow).not.toHaveBeenCalled()
  })

  it('applies the default cooldown and allows a test override', async () => {
    let now = 1_000
    const target = agent()
    const instance = controller(() => ({ compactNow: async () => undefined }), {
      now: () => now,
    })
    const source = eventSource()
    instance.attach(source as never)
    instance.requestCompaction(target)
    finishTurn(source, target)
    await vi.waitFor(() => expect(instance.snapshot(target).lastOutcome).toBeDefined())
    now += 10
    expect(instance.requestCompaction(target)).toMatchObject({
      status: 'cooldown',
      retryAt: 1_000 + COMPACTION_COOLDOWN_MS,
    })
    expect(COMPACTION_COOLDOWN_MS).toBe(60_000)

    const quickTarget = agent()
    const quick = controller(() => ({ compactNow: async () => undefined }), {
      now: () => now,
      cooldownMs: 5,
    })
    const quickSource = eventSource()
    quick.attach(quickSource as never)
    quick.requestCompaction(quickTarget)
    finishTurn(quickSource, quickTarget)
    await vi.waitFor(() => expect(quick.snapshot(quickTarget).lastOutcome).toBeDefined())
    now += 5
    expect(quick.requestCompaction(quickTarget)).toMatchObject({ status: 'queued' })
  })

  it('abandons a pending ticket and clears old state when the agent is disposed', async () => {
    const target = agent()
    const compactNow = vi.fn(async () => undefined)
    const instance = controller(() => ({ compactNow }))
    const source = eventSource()
    instance.attach(source as never)
    instance.requestCompaction(target)
    finishTurn(source, target)
    await vi.waitFor(() =>
      expect(instance.snapshot(target).lastOutcome).toMatchObject({ state: 'completed' }),
    )
    instance.requestCompaction(target)
    source.emit('agent/disposed', { agent: target })
    expect(instance.snapshot(target).queued).toBeUndefined()
    expect(instance.snapshot(target).lastOutcome).toBeUndefined()
    expect(instance.pending(target)).toBeUndefined()
  })

  it('aborts and awaits an in-flight maintenance on dispose', async () => {
    const target = agent()
    let signalSeen: AbortSignal | undefined
    const instance = controller(() => ({
      compactNow: (_agent, signal) => {
        signalSeen = signal
        return new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve())
        })
      },
    }))
    const source = eventSource()
    instance.attach(source as never)
    instance.requestCompaction(target)
    finishTurn(source, target)
    await vi.waitFor(() => expect(signalSeen).toBeDefined())
    await instance.dispose()
    expect(signalSeen?.aborted).toBe(true)
    expect(instance.snapshot(target).lastOutcome).toMatchObject({ state: 'cancelled' })
    expect(instance.statusForSession('session-1')).toBeUndefined()
  })
})

describe('CodexContextController receipts', () => {
  it('mints request ids from a random factory, never a process counter', () => {
    const instance = controller(() => ({ compactNow: async () => undefined }))
    const first = instance.requestCompaction(agent())
    const second = instance.requestCompaction(
      agent({ id: 'session-2', session: session({ id: 'session-2' }) }),
    )
    if (first.status !== 'queued' || second.status !== 'queued') throw new Error('expected tickets')
    expect(first.ticket.requestId).not.toMatch(/^codex-context-\d+$/)
    expect(first.ticket.requestId).not.toBe(second.ticket.requestId)
    const other = controller(() => ({ compactNow: async () => undefined }))
    const otherTicket = other.requestCompaction(agent())
    if (otherTicket.status !== 'queued') throw new Error('expected a ticket')
    expect(otherTicket.ticket.requestId).not.toBe(first.ticket.requestId)
  })

  it('ignores a stale instance completion after the session is re-adopted', async () => {
    let releaseOld: (() => void) | undefined
    const oldAgent = agent()
    const newAgent = agent()
    let counter = 0
    const instance = controller(
      () => ({
        compactNow: (target) => {
          if (target === oldAgent) {
            return new Promise<void>((resolve) => {
              releaseOld = resolve
            })
          }
          return Promise.resolve(null)
        },
      }),
      { idFactory: () => `req-${++counter}` },
    )
    const source = eventSource()
    instance.attach(source as never)
    const oldTicket = instance.requestCompaction(oldAgent)
    if (oldTicket.status !== 'queued') throw new Error('expected a ticket')
    finishTurn(source, oldAgent)
    await vi.waitFor(() => expect(releaseOld).toBeDefined())

    const newTicket = instance.requestCompaction(newAgent)
    if (newTicket.status !== 'queued') throw new Error('expected a fresh ticket')
    finishTurn(source, newAgent)
    await vi.waitFor(() =>
      expect(instance.lastOutcome(newAgent)).toMatchObject({
        state: 'noop',
        requestId: newTicket.ticket.requestId,
      }),
    )

    releaseOld?.()
    await Promise.resolve()
    expect(instance.lastOutcome(newAgent)).toMatchObject({
      state: 'noop',
      requestId: newTicket.ticket.requestId,
    })
    await instance.dispose()
  })
})

describe('CodexContextController statusForSession', () => {
  it('reports pending, running, and terminal sanitized states', async () => {
    const target = agent()
    let release: (() => void) | undefined
    const instance = controller(() => ({
      compactNow: () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    }))
    const source = eventSource()
    instance.attach(source as never)
    expect(instance.statusForSession(target.id)).toBeUndefined()
    instance.requestCompaction(target)
    expect(instance.statusForSession(target.id)).toMatchObject({
      state: 'pending',
      owner: { state: 'available' },
    })
    finishTurn(source, target)
    await vi.waitFor(() => expect(release).toBeDefined())
    expect(instance.statusForSession(target.id)).toMatchObject({
      state: 'running',
      owner: { state: 'available' },
    })
    release?.()
    await vi.waitFor(() =>
      expect(instance.statusForSession(target.id)).toMatchObject({ state: 'completed' }),
    )
  })

  it('maps noop, failure, and external owner without inventing values', async () => {
    const noopTarget = agent()
    const noop = controller(() => ({ compactNow: async () => null }))
    noop.owner(noopTarget)
    noop.requestCompaction(noopTarget)
    expect(noop.statusForSession(noopTarget.id)).toMatchObject({
      state: 'pending',
      owner: { state: 'available' },
    })

    const externalTarget = agent({
      id: 'session-external',
      session: session({ id: 'session-external' }),
    })
    const external = controller(() => undefined, { takeover: true })
    external.owner(externalTarget)
    expect(external.statusForSession(externalTarget.id)).toMatchObject({
      owner: { state: 'declared-takeover' },
      state: 'idle',
    })

    const failedTarget = agent()
    const failed = controller(() => ({
      async compactNow() {
        throw Object.assign(new Error('x'), { code: 'summary' })
      },
    }))
    failed.owner(failedTarget)
    const source = eventSource()
    failed.attach(source as never)
    failed.requestCompaction(failedTarget)
    finishTurn(source, failedTarget)
    await vi.waitFor(() =>
      expect(failed.statusForSession(failedTarget.id)).toMatchObject({
        state: 'failed',
        reason: 'summary-failed',
      }),
    )
  })
})

describe('extractEventText', () => {
  it('reads plain text from user, assistant, and tool results only', () => {
    expect(extractEventText(textEvent(1, 'user/message', 'hello'))).toEqual({
      kind: 'message',
      role: 'user',
      text: 'hello',
    })
    expect(extractEventText(textEvent(2, 'assistant/message', 'answer'))).toMatchObject({
      kind: 'message',
      role: 'assistant',
    })
    expect(extractEventText(textEvent(3, 'tool/result', 'ok'))).toMatchObject({
      kind: 'tool-result',
      role: 'tool',
    })
    expect(
      extractEventText({
        seq: 4,
        type: 'developer/message',
        data: { message: { role: 'developer', content: [{ type: 'text', text: 'hidden' }] } },
      }),
    ).toBeUndefined()
    expect(
      extractEventText({
        seq: 5,
        type: 'system/message',
        data: { message: { role: 'system', content: [{ type: 'text', text: 'hidden' }] } },
      }),
    ).toBeUndefined()
  })

  it('excludes a native checkpoint payload wholesale', () => {
    const marker =
      '<dsh-openai-codex-compaction-4f5cf1b7-v1>{"encrypted_content":"opaque"}</dsh-openai-codex-compaction-4f5cf1b7-v1>'
    expect(extractEventText(textEvent(6, 'user/message', marker))).toBeUndefined()
    expect(extractEventText(textEvent(7, 'user/message', `summary text ${marker}`))).toBeUndefined()
  })
})

describe('CodexContextController recall', () => {
  it('reports no session instead of falling back to another source', async () => {
    const noSession = agent() as { session?: unknown }
    delete noSession.session
    expect(await controller(() => undefined).recall(noSession as never)).toEqual({
      ok: false,
      reason: 'no-session',
    })
  })

  it('reports history-unavailable without a read port or when it fails', async () => {
    expect(await controller(() => undefined).recall(agent())).toEqual({
      ok: false,
      reason: 'history-unavailable',
    })
    const failing = controller(() => undefined, {
      readHistory: async () => {
        throw new Error('observe refused')
      },
    })
    expect(await failing.recall(agent())).toEqual({ ok: false, reason: 'history-unavailable' })
    const missing = controller(() => undefined, { readHistory: async () => undefined })
    expect(await missing.recall(agent())).toEqual({ ok: false, reason: 'history-unavailable' })
  })

  it('defaults to a bounded window, bounded limits, and provenance seqs', async () => {
    const history = Array.from({ length: 10 }, (_, index) =>
      textEvent(4_990 + index, index % 2 === 0 ? 'user/message' : 'tool/result', `event ${index}`),
    )
    const page = await controller(() => undefined, { history, endSeq: 5_000 }).recall(agent())
    expect(page).toMatchObject({
      ok: true,
      fromSeq: 5_000 - RECALL_MAX_SCAN_EVENTS,
      toSeqExclusive: 5_000,
      scanned: 10,
      truncated: false,
    })
    if (!page.ok) throw new Error('expected a page')
    expect(page.items).toHaveLength(10)
    expect(page.items[0]).toMatchObject({ seq: 4_990, type: 'user/message', kind: 'message' })
    expect(page.items[1]).toMatchObject({ seq: 4_991, kind: 'tool-result' })
    expect(page.nextFromSeq).toBeUndefined()
  })

  it('passes the requested range and signal to the read-only port', async () => {
    const ranges: Array<{ fromSeq: number; toSeqExclusive: number }> = []
    const signal = new AbortController().signal
    const instance = controller(() => undefined, {
      readHistory: async (_target, range) => {
        ranges.push(range)
        return { events: [], endSeq: 10 }
      },
    })
    await instance.recall(agent(), { fromSeq: 2, toSeq: 7, signal })
    expect(ranges[0]).toEqual({ fromSeq: 2, toSeqExclusive: 7 })
  })

  it('honors the item limit, filter, and per-item truncation', async () => {
    const long = 'x'.repeat(RECALL_MAX_ITEM_CHARS + 100)
    const history = [
      textEvent(0, 'user/message', 'alpha'),
      textEvent(1, 'user/message', long),
      textEvent(2, 'user/message', 'beta'),
    ]
    const instance = controller(() => undefined, { history, endSeq: 3 })
    const page = await instance.recall(agent(), { limit: 1 })
    if (!page.ok) throw new Error('expected a page')
    expect(page.items).toHaveLength(1)
    expect(page.truncated).toBe(true)
    expect(page.nextFromSeq).toBe(1)

    const filtered = await instance.recall(agent(), { query: 'BET', limit: 5 })
    if (!filtered.ok) throw new Error('expected a page')
    expect(filtered.items.map((item) => item.text)).toEqual(['beta'])

    const truncatedItem = await instance.recall(agent(), { fromSeq: 1, limit: 5 })
    if (!truncatedItem.ok) throw new Error('expected a page')
    expect(truncatedItem.items[0]).toMatchObject({ seq: 1, truncated: true })
    expect(truncatedItem.items[0]?.text).toHaveLength(RECALL_MAX_ITEM_CHARS)
  })

  it('returns a bounded snippet around a late match instead of the head', async () => {
    const text = `${'a'.repeat(900)}needle${'b'.repeat(200)}`
    const history = [textEvent(0, 'user/message', text)]
    const page = await controller(() => undefined, { history, endSeq: 1 }).recall(agent(), {
      query: 'needle',
    })
    if (!page.ok) throw new Error('expected a page')
    expect(page.items).toHaveLength(1)
    const item = page.items[0]
    expect(item?.text).toContain('needle')
    expect(item?.truncated).toBe(true)
    expect(item?.charOffset).toBeGreaterThan(0)
    expect(item?.totalChars).toBe(text.length)
  })

  it('caps the total character budget and exposes a continuation seq', async () => {
    const chunk = 'y'.repeat(RECALL_MAX_ITEM_CHARS)
    const history = Array.from({ length: 100 }, (_, index) =>
      textEvent(index, 'user/message', chunk),
    )
    const page = await controller(() => undefined, { history, endSeq: 100 }).recall(agent(), {
      limit: 1_000,
    })
    if (!page.ok) throw new Error('expected a page')
    const total = page.items.reduce((sum, item) => sum + item.text.length, 0)
    expect(total).toBeLessThanOrEqual(RECALL_MAX_TOTAL_CHARS)
    expect(page.truncated).toBe(true)
    expect(page.nextFromSeq).toBeDefined()
    expect(page.items.length).toBeLessThanOrEqual(RECALL_MAX_LIMIT)
    expect(page.items.length).toBeGreaterThan(0)
  })
})

describe('recall defaults', () => {
  it('keeps the documented default and cap values', () => {
    expect(RECALL_DEFAULT_LIMIT).toBe(20)
    expect(RECALL_MAX_LIMIT).toBe(50)
    expect(RECALL_MAX_SCAN_EVENTS).toBe(2_000)
    expect(RECALL_MAX_TOTAL_CHARS).toBe(16 * 1_024)
  })
})



describe('CodexContextController request facts (task-17)', () => {
  function turnEnd(source: EventSourceStub, target: CodexContextAgent): void {
    source.emit(
      'session/event',
      { id: target.id },
      { seq: 6, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    )
  }

  it('captures the standalone core start only inside its compactNow window', async () => {
    const source = eventSource()
    const target = agent()
    let release: () => void = () => undefined
    let started: () => void = () => undefined
    const startedPromise = new Promise<void>(resolve => { started = resolve })
    const instance = controller(
      () => ({
        async compactNow() {
          source.emit('session/event', { id: target.id }, {
            seq: 7,
            type: 'compaction/start',
            data: { compactionId: 'compaction-a', turn: null },
          })
          started()
          await new Promise<void>(resolve => { release = resolve })
          return { compactionId: 'compaction-a' }
        },
      }),
      { idFactory: () => 'req-1' },
    )
    const off = instance.attach(source as never)
    try {
      expect(instance.requestCompaction(target).status).toBe('queued')
      turnEnd(source, target)
      source.emit('agent/status', { agent: target, status: 'idle' })
      await startedPromise

      expect(instance.requestsForSession(target.id)?.[0]).toMatchObject({
        requestId: 'req-1',
        phase: 'running',
        compactionId: 'compaction-a',
        queuedAt: expect.any(Number),
        startedAt: expect.any(Number),
      })
      // A captured start proves a real compaction: the read must not block on
      // the running request; its facts decide running vs terminal.
      expect(instance.settleForRead(target.id)).toBeUndefined()

      release()
      await vi.waitFor(() => {
        expect(instance.requestsForSession(target.id)?.[0]?.phase).toBe('completed')
      })
      expect(instance.requestsForSession(target.id)?.[0]).toMatchObject({
        phase: 'completed',
        compactionId: 'compaction-a',
        endedAt: expect.any(Number),
      })
      expect(instance.settleForRead(target.id)).toBeUndefined()
    } finally {
      off()
      await instance.dispose()
    }
  })

  it('awaits only a marker-less own call, then reports its no-event terminal', async () => {
    const source = eventSource()
    const target = agent()
    let release: () => void = () => undefined
    let started: () => void = () => undefined
    const startedPromise = new Promise<void>(resolve => { started = resolve })
    const instance = controller(
      () => ({
        async compactNow() {
          // No compaction/start: noop/busy/pre-call failures take this path.
          started()
          await new Promise<void>(resolve => { release = resolve })
          return null
        },
      }),
      { idFactory: () => 'req-1' },
    )
    const off = instance.attach(source as never)
    try {
      instance.requestCompaction(target)
      turnEnd(source, target)
      source.emit('agent/status', { agent: target, status: 'idle' })
      await startedPromise

      // Marker-less window: awaiting this request's own task is causal and
      // bounded, so the pending noop resolves before the read folds facts.
      const settle = instance.settleForRead(target.id)
      expect(settle).toBeInstanceOf(Promise)
      release()
      await settle

      expect(instance.requestsForSession(target.id)?.[0]).toMatchObject({ phase: 'noop' })
      expect(instance.settleForRead(target.id)).toBeUndefined()
    } finally {
      off()
      await instance.dispose()
    }
  })

  it('keeps a strictly captured id when its own call throws, letting the failed fact prove it', async () => {
    const source = eventSource()
    const target = agent()
    const instance = controller(
      () => ({
        async compactNow() {
          source.emit('session/event', { id: target.id }, {
            seq: 7,
            type: 'compaction/start',
            data: { compactionId: 'compaction-a', turn: null },
          })
          throw Object.assign(new Error('core summary failed'), { code: 'summary' })
        },
      }),
      { idFactory: () => 'req-1' },
    )
    const off = instance.attach(source as never)
    try {
      instance.requestCompaction(target)
      turnEnd(source, target)
      source.emit('agent/status', { agent: target, status: 'idle' })
      await vi.waitFor(() => {
        expect(instance.requestsForSession(target.id)?.[0]?.phase).toBe('failed')
      })

      const fact = instance.requestsForSession(target.id)?.[0]
      // A thrown own call keeps the captured id (factual link, not success) so
      // the same-id core failed fact can prove the terminal.
      expect(fact?.compactionId).toBe('compaction-a')
      expect(fact?.code).toBe('summary')
      expect(fact?.reason).toBe('summary-failed')
    } finally {
      off()
      await instance.dispose()
    }
  })

  it('never binds a start outside the window or one carrying another owner/command', async () => {
    const source = eventSource()
    const target = agent()
    const instance = controller(
      () => ({
        async compactNow() {
          // Another command's ownerless-looking start is rejected by its
          // sourceCommandId; a turn-owned start is rejected by its turn.
          source.emit('session/event', { id: target.id }, {
            seq: 8,
            type: 'compaction/start',
            data: { compactionId: 'foreign-1', turn: null, sourceCommandId: 'cmd-1' },
          })
          source.emit('session/event', { id: target.id }, {
            seq: 9,
            type: 'compaction/start',
            data: { compactionId: 'foreign-2', turn: 1 },
          })
          return { compactionId: 'foreign-1' }
        },
      }),
      { idFactory: () => 'req-1' },
    )
    const off = instance.attach(source as never)
    try {
      // A start emitted while the request is still queued is outside the window.
      source.emit('session/event', { id: target.id }, {
        seq: 5,
        type: 'compaction/start',
        data: { compactionId: 'early', turn: null },
      })
      instance.requestCompaction(target)
      turnEnd(source, target)
      source.emit('agent/status', { agent: target, status: 'idle' })
      await vi.waitFor(() => {
        expect(instance.requestsForSession(target.id)?.[0]?.phase).toBe('completed')
      })

      const fact = instance.requestsForSession(target.id)?.[0]
      expect(fact?.compactionId).toBeUndefined()
      expect(fact?.phase).toBe('completed')
    } finally {
      off()
      await instance.dispose()
    }
  })

  it('drops the association when the returned id disagrees with the captured one', async () => {
    const source = eventSource()
    const target = agent()
    const instance = controller(
      () => ({
        async compactNow() {
          source.emit('session/event', { id: target.id }, {
            seq: 7,
            type: 'compaction/start',
            data: { compactionId: 'captured-id', turn: null },
          })
          return { compactionId: 'returned-id' }
        },
      }),
      { idFactory: () => 'req-1' },
    )
    const off = instance.attach(source as never)
    try {
      instance.requestCompaction(target)
      turnEnd(source, target)
      source.emit('agent/status', { agent: target, status: 'idle' })
      await vi.waitFor(() => {
        expect(instance.requestsForSession(target.id)?.[0]?.phase).toBe('completed')
      })
      expect(instance.requestsForSession(target.id)?.[0]?.compactionId).toBeUndefined()
    } finally {
      off()
      await instance.dispose()
    }
  })

  it('keeps no-event terminals free of any checkpoint claim', async () => {
    const source = eventSource()
    const target = agent()
    const instance = controller(() => ({ compactNow: async () => null }), { idFactory: () => 'req-noop' })
    const off = instance.attach(source as never)
    try {
      instance.requestCompaction(target)
      turnEnd(source, target)
      source.emit('agent/status', { agent: target, status: 'idle' })
      await vi.waitFor(() => {
        expect(instance.requestsForSession(target.id)?.[0]?.phase).toBe('noop')
      })
      expect(instance.requestsForSession(target.id)?.[0]?.compactionId).toBeUndefined()
    } finally {
      off()
      await instance.dispose()
    }
  })

  it('drops an unsettled request when the Agent is disposed, and a resumed instance never reads it as running', async () => {
    const source = eventSource()
    const target = agent()
    let release: () => void = () => undefined
    const instance = controller(
      () => ({
        async compactNow() {
          await new Promise<void>(resolve => { release = resolve })
          return null
        },
      }),
      { idFactory: () => 'req-1' },
    )
    const off = instance.attach(source as never)
    try {
      instance.requestCompaction(target)
      turnEnd(source, target)
      source.emit('agent/status', { agent: target, status: 'idle' })
      await vi.waitFor(() => {
        expect(instance.requestsForSession(target.id)?.[0]?.phase).toBe('running')
      })

      source.emit('agent/disposed', { agent: target })

      expect(instance.requestsForSession(target.id)).toBeUndefined()
      const resumed = agent()
      source.emit('agent/status', { agent: resumed, status: 'idle' })
      expect(instance.requestsForSession(target.id)).toBeUndefined()
      expect(instance.statusForSession(target.id)?.state).not.toBe('running')

      // A late completion of the disposed instance must not land either.
      release()
      await Promise.resolve()
      await Promise.resolve()
      expect(instance.statusForSession(target.id)?.state).not.toBe('completed')
    } finally {
      off()
      await instance.dispose()
    }
  })
})