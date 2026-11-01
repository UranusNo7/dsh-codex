/**
 * Sanitized compaction diagnostics for the OpenAI Codex plugin.
 *
 * Three cooperating, deliberately small pieces:
 * - a pure session projection (`openaiCodex.compaction`) that folds committed
 *   `compaction/*`, replacement-checkpoint message, and `compaction/end` events
 *   into client-visible facts;
 * - a diagnostics store that records one fixed-reason decision per real
 *   compaction id and keeps it in the plugin's own `storageDomain` KV domain
 *   (memory only when that service is absent);
 * - a readonly Typert Remote (`codexCompaction/read`) that mirrors the official
 *   `SessionSkillCatalog` cold-read pattern: it validates Session visibility
 *   through `sessionQuery.observeSession` without resuming an Agent.
 *
 * Nothing here stores prompt text, opaque marker payloads, tokens, or raw error
 * text, and nothing decides success: success is only the core
 * `compaction/end` without error plus a replacement checkpoint carrying the
 * same real `compactionId`.
 *
 * @module dsh-codex/compaction-diagnostics
 */

import { z } from 'zod'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  TypertContribution,
  TypertServiceModel,
} from '@deepseek-ai/dsh-typert-registry'
import type { Context } from '@deepseek-ai/cordis'
import {
  COMPACTION_DIAGNOSTICS_VERSION,
  COMPACTION_PROJECTION_KEY,
  COMPACTION_PROJECTION_STATE_VERSION,
  COMPACTION_REMOTE_NAMESPACE,
} from './compaction-types.ts'
import type {
  CompactionDecision,
  CompactionDiagnostic,
  CompactionDiagnosticsSnapshot,
  CompactionLocalEstimate,
  CompactionProjectionFact,
  CompactionProjectionState,
  CompactionProjectionView,
  CompactionProviderUsage,
  CompactionReason,
  CompactionReadRequest,
  CompactionRequestFact,
  CompactionRequestStatus,
  CompactionSessionStatus,
} from './compaction-types.ts'
import { OPENAI_CODEX_NATIVE_MARKER_CLOSE, OPENAI_CODEX_NATIVE_MARKER_OPEN } from './responses.ts'

/** Plugin-owned storage domain holding per-compaction diagnostics metadata. */
export const COMPACTION_DOMAIN_NAME = 'dsh-codex-compaction'
/** Table of per-attempt records, keyed `"<sessionId>/<compactionId>"`. */
export const COMPACTION_DOMAIN_TABLE = 'attempts'
/** Domain layout version; bump only with an incompatible stored shape. */
export const COMPACTION_DOMAIN_VERSION = 1

/** One committed session event as consumed by the pure fold. */
export interface CompactionSessionEventLike {
  readonly type: string
  readonly seq: number
  /** Event commit time in epoch milliseconds, when the log records it. */
  readonly time?: number
  readonly data?: unknown
  readonly surfaceOp?: unknown
}

/** Fact draft: the wire fact plus the classification input it derives from. */
interface FactDraft extends CompactionProjectionFact {
  /** Whether `compaction/end` recorded an error; the error text is never kept. */
  readonly failed: boolean
}

/** Internal projection state: wire facts plus their closed status inputs. */
interface ProjectionCell {
  readonly v: typeof COMPACTION_DIAGNOSTICS_VERSION
  readonly facts: readonly FactDraft[]
  /** Latest status-relevant event seq (see the wire `activitySeq`). */
  readonly activitySeq: number
  /** Outstanding `codex_context` tool-call ids awaiting their result. */
  readonly contextCalls: readonly string[]
}

/** This plugin's own context tool: its call/result pair is a status signal. */
const OWN_CONTEXT_TOOL_NAME = 'codex_context'

/** One real request→compaction link reported by the Agent controller. */
interface RequestLink {
  readonly requestId: string
  readonly compactionId?: string | undefined
  readonly queuedAt?: number | undefined
}

/** Bound on remembered request links per session. */
const REQUEST_LINKS_LIMIT = 16

/** Read events without trusting their declared shape. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** A finite, non-negative safe integer, or undefined. */
function asSeq(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Whether `compaction/end` recorded an error. The real core records
 * `errorChain(error)`, i.e. a plain string; cancellation is therefore NOT
 * derivable here and an errored transaction stays `failed`. The readonly read
 * refines it to `cancelled` only from a real runtime/controller record sharing
 * the same compaction id.
 */
function failedEnd(data: Record<string, unknown>): boolean {
  return data['error'] !== undefined
}

/**
 * The core compaction-basic shrink gate, matched verbatim. Only this exact
 * generated sentence shape is mapped to a fixed reason.
 */
const CORE_SHRINK_GATE_ERROR = /^summary is not smaller than the shadowed content \(\d+ estimated framed tokens >= \d+\)$/

/**
 * Fixed reason for one recorded end error, or undefined when it is not a
 * failure the core emits in a known strict format. Only the core shrink gate is
 * recognised, verbatim; no substring guessing and no raw text retention.
 */
function failureReasonOf(data: Record<string, unknown>): CompactionReason | undefined {
  const error = data['error']
  if (typeof error !== 'string') return undefined
  return CORE_SHRINK_GATE_ERROR.test(error) ? 'not-smaller' : undefined
}

/** Read one finite non-negative usage number from a provider usage record. */
function usageNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Map the core-recorded `TokenUsage` of the summary request into the
 * diagnostics shape. The core fields (`inputTokens`, `outputTokens`,
 * `cacheReadTokens`, `cacheWriteTokens`, `totalTokens`) are read as recorded —
 * they are not the pi-ai message `Usage` keys. A missing usage object yields no
 * group rather than zeroed numbers.
 */
function summaryUsage(
  raw: unknown,
  at: number,
): CompactionProviderUsage | undefined {
  const usage = asRecord(raw)
  if (usage === undefined) return undefined
  const inputTokens = usageNumber(usage, 'inputTokens')
  const outputTokens = usageNumber(usage, 'outputTokens')
  const cacheReadTokens = usageNumber(usage, 'cacheReadTokens')
  const cacheWriteTokens = usageNumber(usage, 'cacheWriteTokens')
  const totalTokens = usageNumber(usage, 'totalTokens')
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined
  }
  return {
    ...inputTokens === undefined ? {} : { inputTokens },
    ...outputTokens === undefined ? {} : { outputTokens },
    ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
    ...cacheWriteTokens === undefined ? {} : { cacheWriteTokens },
    ...totalTokens === undefined ? {} : { totalTokens },
    source: 'summary-request',
    at,
  }
}

/** Facts recorded by one committed `compaction/summary` event. */
function summaryFacts(data: Record<string, unknown>, at: number) {
  const provider = data['provider']
  const model = data['model']
  const shadowedTokenCount = asSeq(data['shadowedTokenCount'])
  const shadowedSeqs = data['shadowedSeqs']
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined
  if (shadowedTokenCount === undefined || !Array.isArray(shadowedSeqs)) return undefined
  const usage = summaryUsage(data['usage'], at)
  return {
    provider,
    model,
    shadowedTokenCount,
    shadowedSeqCount: shadowedSeqs.length,
    ...usage === undefined ? {} : { usage },
  }
}

/**
 * Whether one text block is exactly a complete plugin-native checkpoint: the
 * opening and closing delimiters around a JSON array containing a compaction
 * item. A truncated, prefixed, or merely quoted marker never counts, and the
 * payload is validated only — never decrypted or retained.
 */
function isNativeMarkerText(text: string): boolean {
  if (!text.startsWith(OPENAI_CODEX_NATIVE_MARKER_OPEN) || !text.endsWith(OPENAI_CODEX_NATIVE_MARKER_CLOSE)) {
    return false
  }
  const payload = text.slice(
    OPENAI_CODEX_NATIVE_MARKER_OPEN.length,
    text.length - OPENAI_CODEX_NATIVE_MARKER_CLOSE.length,
  )
  try {
    const parsed: unknown = JSON.parse(payload)
    return Array.isArray(parsed) && parsed.some(item => asRecord(item)?.['type'] === 'compaction')
  } catch {
    return false
  }
}

/** Whether a checkpoint/summary content array carries one complete native marker block. */
function nativeCheckpoint(message: unknown): boolean {
  const record = asRecord(message)
  const content = record?.['content']
  if (!Array.isArray(content)) return false
  for (const block of content) {
    const typed = asRecord(block)
    if (typed?.['type'] !== 'text' || typeof typed['text'] !== 'string') continue
    if (isNativeMarkerText(typed['text'])) return true
  }
  return false
}

/** Resolve the client-visible status of one fact from its folded inputs. */
function statusOf(fact: FactDraft): CompactionProjectionFact['status'] {
  if (fact.endSeq === null) return 'open'
  if (fact.failed) return 'failed'
  if (fact.checkpointSeq === null) return 'failed'
  return fact.status === 'native' ? 'native' : 'ordinary'
}

/** Produce the client-visible fact, dropping the internal classification input. */
function materialize(fact: FactDraft): CompactionProjectionFact {
  return {
    compactionId: fact.compactionId,
    status: statusOf(fact),
    startSeq: fact.startSeq,
    summarySeq: fact.summarySeq,
    checkpointSeq: fact.checkpointSeq,
    endSeq: fact.endSeq,
    turn: fact.turn,
    ...fact.summary === undefined ? {} : { summary: fact.summary },
    ...fact.failureReason === undefined ? {} : { failureReason: fact.failureReason },
  }
}

/** Initial projection state. */
export function initCompactionProjection(): ProjectionCell {
  return { v: COMPACTION_DIAGNOSTICS_VERSION, facts: [], activitySeq: 0, contextCalls: [] }
}

/** Client-visible view of one projection state. */
export function viewCompactionProjection(state: ProjectionCell): CompactionProjectionView {
  return {
    v: COMPACTION_DIAGNOSTICS_VERSION,
    facts: state.facts.map(materialize),
    activitySeq: state.activitySeq,
  }
}

/**
 * Pure fold of one committed event. Returns the same state object when the
 * event is irrelevant, so the projection registry's change detection stays
 * exact.
 */
export function applyCompactionEvent(state: ProjectionCell, event: CompactionSessionEventLike): ProjectionCell {
  const data = asRecord(event.data)
  if (data === undefined) return state
  if (event.type === 'compaction/start') {
    const compactionId = data['compactionId']
    if (typeof compactionId !== 'string' || compactionId.length === 0) return state
    const turn = data['turn']
    const fact: FactDraft = {
      compactionId,
      status: 'open',
      startSeq: event.seq,
      summarySeq: null,
      checkpointSeq: null,
      endSeq: null,
      turn: typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0 ? turn : null,
      failed: false,
    }
    return { ...state, facts: [...state.facts, fact], activitySeq: event.seq }
  }
  if (event.type === 'compaction/summary') {
    const compactionId = data['compactionId']
    if (typeof compactionId !== 'string') return state
    const next = updateFact(state, compactionId, fact => {
      if (fact.summarySeq !== null) return undefined
      // Real logs record `time`; a caller without a clock gets 0, which is
      // never used for ordering or correlation.
      const summary = summaryFacts(data, event.time ?? 0)
      return {
        ...fact,
        summarySeq: event.seq,
        ...summary === undefined ? {} : { summary },
      }
    })
    return next === state ? state : { ...next, activitySeq: event.seq }
  }
  if (event.type === 'compaction/end') {
    const compactionId = data['compactionId']
    if (typeof compactionId !== 'string') return state
    const failed = failedEnd(data)
    const failureReason = failed ? failureReasonOf(data) : undefined
    const next = updateFact(state, compactionId, fact => {
      if (fact.endSeq !== null) return undefined
      return {
        ...fact,
        endSeq: event.seq,
        failed,
        ...failureReason === undefined ? {} : { failureReason },
      }
    })
    return next === state ? state : { ...next, activitySeq: event.seq }
  }
  if (event.type === 'user/message') {
    // Only a replacement carrying the core checkpoint source identifies a
    // committed compaction checkpoint; its real id is the transaction id.
    const surfaceOp = asRecord(event.surfaceOp)
    if (surfaceOp?.['op'] !== 'replace') return state
    const source = asRecord(data['source'])
    if (source?.['kind'] !== 'compact-checkpoint') return state
    const compactionId = source['compactionId']
    if (typeof compactionId !== 'string') return state
    const native = nativeCheckpoint(data)
    const next = updateFact(state, compactionId, fact => {
      if (fact.checkpointSeq !== null) return undefined
      return {
        ...fact,
        checkpointSeq: event.seq,
        status: native ? 'native' : 'ordinary',
      }
    })
    return next === state ? state : { ...next, activitySeq: event.seq }
  }
  if (event.type === 'assistant/message') {
    // Track only this plugin's own tool calls; no text or arguments are kept.
    const message = asRecord(data['message'])
    const content = message?.['content']
    if (!Array.isArray(content)) return state
    const ids: string[] = []
    for (const block of content) {
      const typed = asRecord(block)
      if (typed?.['type'] !== 'tool-call' || typed['name'] !== OWN_CONTEXT_TOOL_NAME) continue
      const id = typed['id']
      if (typeof id !== 'string' || id.length === 0 || state.contextCalls.includes(id) || ids.includes(id)) continue
      ids.push(id)
    }
    if (ids.length === 0) return state
    return { ...state, contextCalls: [...state.contextCalls, ...ids], activitySeq: event.seq }
  }
  if (event.type === 'tool/result') {
    const message = asRecord(data['message'])
    const callId = asRecord(message?.['source'])?.['callId']
    if (typeof callId !== 'string' || !state.contextCalls.includes(callId)) return state
    return {
      ...state,
      contextCalls: state.contextCalls.filter(pending => pending !== callId),
      activitySeq: event.seq,
    }
  }
  return state
}

/** Replace one fact by real id, keeping the state reference when nothing changed. */
function updateFact(
  state: ProjectionCell,
  compactionId: string,
  update: (fact: FactDraft) => FactDraft | undefined,
): ProjectionCell {
  const index = state.facts.findIndex(fact => fact.compactionId === compactionId)
  if (index < 0) return state
  const current = state.facts[index]
  if (current === undefined) return state
  const next = update(current)
  if (next === undefined) return state
  const facts = [...state.facts]
  facts[index] = next
  return { ...state, facts }
}

/** Fold a whole observed event list, for cold reads that must not touch a Session. */
export function foldCompactionEvents(
  events: readonly CompactionSessionEventLike[],
): CompactionProjectionView {
  let state = initCompactionProjection()
  for (const event of events) state = applyCompactionEvent(state, event)
  return viewCompactionProjection(state)
}

/** Whether the given projection state has exactly one open compaction. */
export function openCompactionIdOfState(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null) return undefined
  const facts = (state as { facts?: unknown }).facts
  if (!Array.isArray(facts)) return undefined
  let open: string | undefined
  for (const fact of facts) {
    const record = asRecord(fact)
    if (record === undefined || record['endSeq'] !== null) continue
    const compactionId = record['compactionId']
    if (typeof compactionId !== 'string' || compactionId.length === 0) continue
    // Two unmatched starts cannot be attributed to one call; refusing beats guessing.
    if (open !== undefined) return undefined
    open = compactionId
  }
  return open
}

/** The fact of one session's currently open compaction, when exactly one exists. */
export function openCompactionId(
  view: CompactionProjectionView | undefined,
): string | undefined {
  if (view === undefined) return undefined
  let open: string | undefined
  for (const fact of view.facts) {
    if (fact.status !== 'open') continue
    // Two unmatched starts cannot be attributed to one call; refusing beats guessing.
    if (open !== undefined) return undefined
    open = fact.compactionId
  }
  return open
}

/** Zod schema of one provider usage group. */
const usageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  source: z.enum(['native-request', 'summary-request']),
  at: z.number(),
})

/** Zod schema of the core-recorded summary facts of one compaction. */
const summaryFactsSchema = z.object({
  provider: z.string(),
  model: z.string(),
  shadowedTokenCount: z.number(),
  shadowedSeqCount: z.number(),
  usage: usageSchema.optional(),
})

/** Zod schema of every fixed diagnostics reason code. */
const reasonSchema = z.enum([
  'native-disabled',
  'no-estimator',
  'no-source-budget',
  'native-request-failed',
  'invalid-response',
  'not-smaller',
  'selected-native',
  'aborted',
  'summary-failed',
  'busy',
  'noop',
])

/** Zod schema of one client-visible fact. */
const factSchema = z.object({
  compactionId: z.string(),
  status: z.enum(['open', 'native', 'ordinary', 'failed', 'cancelled']),
  startSeq: z.number(),
  summarySeq: z.number().nullable(),
  checkpointSeq: z.number().nullable(),
  endSeq: z.number().nullable(),
  turn: z.number().nullable(),
  summary: summaryFactsSchema.optional(),
  failureReason: reasonSchema.optional(),
})

/** Zod schema of the client-visible projection value. */
export const compactionProjectionViewSchema = z.object({
  v: z.literal(COMPACTION_DIAGNOSTICS_VERSION),
  facts: z.array(factSchema),
  activitySeq: z.number(),
})

/** Zod schema of the projection's internal state (wire facts plus classification). */
export const compactionProjectionStateSchema = z.object({
  v: z.literal(COMPACTION_DIAGNOSTICS_VERSION),
  facts: z.array(factSchema.extend({ failed: z.boolean() })),
  activitySeq: z.number(),
  contextCalls: z.array(z.string()),
})

/** Zod schema of one sanitized diagnostics record (RPC and storage shape). */
const diagnosticSchema = z.object({
  compactionId: z.string().nullable(),
  at: z.number(),
  decision: reasonSchema,
  sourceEstimate: z
    .object({
      tokens: z.number(),
      source: z.literal('source-text'),
      estimator: z.literal('host-token-meter'),
      at: z.number(),
    })
    .optional(),
  markerEstimate: z
    .object({
      tokens: z.number(),
      source: z.literal('marker'),
      estimator: z.literal('host-token-meter'),
      at: z.number(),
    })
    .optional(),
  nativeUsage: usageSchema.extend({ source: z.literal('native-request') }).optional(),
  requestId: z.string().optional(),
  queuedAt: z.number().optional(),
})

/** Zod schema of one persisted diagnostics record. */
const storedRecordSchema = diagnosticSchema.extend({
  v: z.literal(COMPACTION_DIAGNOSTICS_VERSION),
  compactionId: z.string(),
})

/** Strip the storage envelope and re-whitelist the record through {@link diagnosticSchema}. */
function parseStoredRecord(stored: z.infer<typeof storedRecordSchema>): CompactionDiagnostic | undefined {
  const { v: _v, ...record } = stored
  const parsed = diagnosticSchema.safeParse(record)
  return parsed.success ? parsed.data : undefined
}

/** The plugin's declared diagnostics domain. */
const compactionDomainSpec = {
  name: COMPACTION_DOMAIN_NAME,
  version: COMPACTION_DOMAIN_VERSION,
  layout: 'per-record' as const,
  tables: { [COMPACTION_DOMAIN_TABLE]: { valueSchema: storedRecordSchema } },
}

/** KV table face used by this module (structural: no storage package import). */
interface KvTableLike {
  get(key: string): unknown
  put(key: string, value: unknown): Promise<void>
  entries(): IterableIterator<[string, unknown]>
}

/** Opened domain face used by this module. */
interface StorageDomainHandleLike {
  table(name: string): KvTableLike
  close(): Promise<void>
}

/** Storage-domain facility face used by this module. */
interface StorageDomainFacilityLike {
  get(name: string): StorageDomainHandleLike | undefined
  open(spec: unknown): Promise<StorageDomainHandleLike>
}

/** Options of {@link CompactionDiagnostics}. */
export interface CompactionDiagnosticsOptions {
  /** Resolve the plugin's storage domain facility; absence means memory only. */
  readonly storage?: () => StorageDomainFacilityLike | undefined
  /** Resolve the real open compaction id of one live session, when exactly one exists. */
  readonly resolveCompactionId?: (sessionId: string) => string | undefined
  /** Clock override for tests. */
  readonly now?: () => number
}

/**
 * Records one sanitized decision per real compaction id and serves them back to
 * the readonly Remote. Never throws into the response path it observes.
 *
 * Storage lifecycle rules: only a domain this instance `open`ed is ever closed;
 * in-flight opens and writes are tracked so `dispose` settles them first; and
 * `persistent` reports durably usable metadata only, never an in-flight or
 * failed write.
 */
export class CompactionDiagnostics {
  private readonly memory = new Map<string, CompactionDiagnostic[]>()
  /** Bounded request→compaction links from the controller; never a record source. */
  private readonly requestLinks = new Map<string, Map<string, RequestLink>>()
  private readonly pending = new Set<Promise<unknown>>()
  private handle: StorageDomainHandleLike | undefined
  private tableValue: KvTableLike | undefined
  private domainReady = false
  private writeFailed = false
  private disposed = false

  constructor(private readonly options: CompactionDiagnosticsOptions = {}) {}

  /** Whether attempt records survive a restart (a usable storage domain). */
  get persistent(): boolean {
    return this.domainReady && !this.writeFailed
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /**
   * Record one decision. The real compaction id is resolved here; an
   * unresolvable call is kept in memory as unlinked and never persisted.
   */
  recordDecision(decision: CompactionDecision): void {
    if (this.disposed) return
    try {
      const sessionId = decision.sessionId
      if (sessionId === undefined || sessionId.length === 0) return
      const compactionId = decision.compactionId ?? this.options.resolveCompactionId?.(sessionId) ?? null
      const link = compactionId === null ? undefined : this.requestLinkFor(sessionId, compactionId)
      // Whitelist-clone before retention: the read RPC must only ever see the
      // fixed fields below, never whatever raw shape the runtime handed in.
      const parsed = diagnosticSchema.safeParse({
        compactionId,
        at: decision.at,
        decision: decision.reason,
        ...decision.sourceEstimate === undefined ? {} : { sourceEstimate: decision.sourceEstimate },
        ...decision.markerEstimate === undefined ? {} : { markerEstimate: decision.markerEstimate },
        ...decision.nativeUsage === undefined ? {} : { nativeUsage: decision.nativeUsage },
        ...link === undefined ? {} : { requestId: link.requestId },
        ...link?.queuedAt === undefined ? {} : { queuedAt: link.queuedAt },
      })
      if (!parsed.success) return
      const record = parsed.data
      const list = this.memory.get(sessionId) ?? []
      this.memory.set(sessionId, [...list, record])
      if (record.compactionId !== null) this.track(this.persist(sessionId, record))
    } catch {
      // Diagnostics must never disturb the response or business streams.
    }
  }

  /**
   * Remember a real request→compaction link from the Agent controller. It only
   * annotates an existing record for that compaction id; it never creates one,
   * so a queued request cannot fabricate an attempt.
   */
  linkRequest(
    sessionId: string,
    link: { requestId: string; compactionId?: string | undefined; queuedAt?: number | undefined },
  ): void {
    if (this.disposed || sessionId.length === 0 || link.requestId.length === 0) return
    try {
      const links = this.requestLinks.get(sessionId) ?? new Map<string, RequestLink>()
      const bound = new Map(links)
      bound.set(link.compactionId ?? `request:${link.requestId}`, link)
      while (bound.size > REQUEST_LINKS_LIMIT) {
        const oldest = bound.keys().next().value
        if (oldest === undefined) break
        bound.delete(oldest)
      }
      this.requestLinks.set(sessionId, bound)
      if (link.compactionId === undefined) return
      const list = this.memory.get(sessionId)
      if (list === undefined) return
      const index = list.findIndex(record => record.compactionId === link.compactionId)
      if (index < 0) return
      const current = list[index]
      if (current === undefined) return
      const annotated = diagnosticSchema.safeParse({
        ...current,
        requestId: link.requestId,
        ...link.queuedAt === undefined ? {} : { queuedAt: link.queuedAt },
      })
      if (!annotated.success) return
      const next = [...list]
      next[index] = annotated.data
      this.memory.set(sessionId, next)
      this.track(this.persist(sessionId, annotated.data))
    } catch {
      // Diagnostics must never disturb the request queue.
    }
  }

  /** The newest recorded link for one real compaction id, when known. */
  private requestLinkFor(sessionId: string, compactionId: string): RequestLink | undefined {
    return this.requestLinks.get(sessionId)?.get(compactionId)
  }

  /** Newest in-memory decision of one session, for the Agent-scoped status snapshot. */
  latest(sessionId: string): CompactionDiagnostic | undefined {
    return this.memory.get(sessionId)?.at(-1)
  }

  /** Wait for every in-flight open/write to settle; used before a read snapshot. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending])
    }
  }

  /** Records for one session, oldest first, persisted and in-memory merged. */
  async recordsFor(sessionId: string): Promise<readonly CompactionDiagnostic[]> {
    const stored = await this.load(sessionId)
    const merged = new Map<string, CompactionDiagnostic>()
    for (const record of stored) {
      if (record.compactionId === null) continue
      merged.set(record.compactionId, record)
    }
    for (const record of this.memory.get(sessionId) ?? []) {
      merged.set(record.compactionId ?? `unlinked:${record.at}`, record)
    }
    return [...merged.values()].sort((left, right) => left.at - right.at)
  }

  /** Settle in-flight work, then close only a domain this instance opened. */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.settled()
    const handle = this.handle
    this.handle = undefined
    this.tableValue = undefined
    this.domainReady = false
    if (handle === undefined) return
    try {
      await handle.close()
    } catch {
      // Disposal is best effort; the facility also closes on unmount.
    }
  }

  private track(promise: Promise<unknown>): void {
    const settled = promise.then(() => undefined, () => undefined)
    this.pending.add(settled)
    void settled.then(() => {
      this.pending.delete(settled)
    })
  }

  private async load(sessionId: string): Promise<readonly CompactionDiagnostic[]> {
    const table = await this.table()
    if (table === undefined || this.disposed) return []
    const prefix = `${sessionId}/`
    const records: CompactionDiagnostic[] = []
    try {
      for (const [key, value] of table.entries()) {
        if (!key.startsWith(prefix)) continue
        const parsed = storedRecordSchema.safeParse(value)
        if (!parsed.success) continue
        const record = parseStoredRecord(parsed.data)
        if (record !== undefined) records.push(record)
      }
    } catch {
      return []
    }
    return records
  }

  private async persist(sessionId: string, record: CompactionDiagnostic): Promise<void> {
    if (record.compactionId === null || this.disposed) return
    const table = await this.table()
    if (table === undefined || this.disposed) return
    try {
      await table.put(`${sessionId}/${record.compactionId}`, {
        v: COMPACTION_DIAGNOSTICS_VERSION,
        ...record,
      })
      if (!this.disposed) this.writeFailed = false
    } catch {
      this.writeFailed = true
    }
  }

  private table(): Promise<KvTableLike | undefined> {
    if (this.disposed) return Promise.resolve(undefined)
    if (this.tableValue !== undefined) return Promise.resolve(this.tableValue)
    const facility = this.options.storage?.()
    if (facility === undefined) return Promise.resolve(undefined)
    const opening = this.openTable(facility)
    this.track(opening)
    return opening
  }

  private async openTable(facility: StorageDomainFacilityLike): Promise<KvTableLike | undefined> {
    try {
      // Only a domain this instance opens is owned here. An already-open name
      // stays memory-only: its owner is the public API caller, not this plugin.
      const handle = await facility.open(compactionDomainSpec)
      if (this.disposed) {
        await handle.close()
        return undefined
      }
      this.handle = handle
      const table = handle.table(COMPACTION_DOMAIN_TABLE)
      this.tableValue = table
      this.domainReady = true
      return table
    } catch {
      // A missing, already-open, or unusable storage domain leaves diagnostics
      // in memory only, and the snapshot reports `persistent: false`.
      this.domainReady = false
      return undefined
    }
  }
}

/** Session visibility port: the official cold-read observation. */
interface SessionQueryLike {
  observeSession(
    sessionId: string,
    options?: { signal?: AbortSignal; projectionMode?: 'all' | 'none' },
  ): Promise<SessionObservationLike>
}

/** One observation lease; disposed after the events are captured. */
interface SessionObservationLike {
  readonly events?: readonly CompactionSessionEventLike[]
  [Symbol.dispose]?: () => void
}

/** Options of {@link CompactionRemoteService}. */
export interface CompactionRemoteOptions {
  readonly diagnostics: CompactionDiagnostics
  /** Controller-provided session status; absent stays `unknown`. */
  readonly sessionStatus?: ((sessionId: string) => CompactionSessionStatus | undefined) | undefined
  /** Controller request facts; absent means the client shows `unknown`. */
  readonly requests?: ((sessionId: string) => readonly CompactionRequestFact[] | undefined) | undefined
  /** Causal settle window of the session's own maintenance, or undefined. */
  readonly settleRequests?: ((sessionId: string, signal?: AbortSignal) => Promise<void> | undefined) | undefined
  readonly now?: () => number
}

/**
 * Readonly Remote backing `ctx.remote.codexCompaction` without activating a
 * cold Agent: the same authenticated Gateway and Session visibility boundary as
 * the official skill catalog.
 */
export class CompactionRemote extends TypertRemoteService {
  private readonly diagnostics: CompactionDiagnostics
  private readonly sessionStatus: (sessionId: string) => CompactionSessionStatus | undefined
  private readonly requests: (sessionId: string) => readonly CompactionRequestFact[] | undefined
  private readonly settleRequests: (sessionId: string, signal?: AbortSignal) => Promise<void> | undefined
  private readonly now: () => number

  constructor(ctx: Context, options: CompactionRemoteOptions) {
    super(ctx, 'compactionDiagnostics', { namespace: COMPACTION_REMOTE_NAMESPACE })
    this.diagnostics = options.diagnostics
    this.sessionStatus = options.sessionStatus ?? (() => undefined)
    this.requests = options.requests ?? (() => undefined)
    this.settleRequests = options.settleRequests ?? (() => undefined)
    this.now = options.now ?? Date.now
  }

  /**
   * Read one session's compaction facts and diagnostics.
   * @param request - the addressed Session identity.
   * @param signal - caller lifetime of the Remote transport.
   * @returns facts folded from committed events, attempt records, and status.
   * @throws RemoteError when the Session is not visible or cannot be inspected.
   */
  async read(request: CompactionReadRequest, signal?: AbortSignal): Promise<CompactionDiagnosticsSnapshot> {
    return readCompactionSnapshot({
      sessionQuery: () => sessionQueryOf(this.ctx),
      diagnostics: this.diagnostics,
      sessionStatus: this.sessionStatus,
      requests: this.requests,
      settleRequests: this.settleRequests,
      now: this.now,
    }, request, signal)
  }
}

/** Package identity of the Host-side Typert contribution. */
export const COMPACTION_TYPERT_PACKAGE = 'dsh-codex'
/** Stable generated identity of the readonly invocation. */
export const COMPACTION_TYPERT_INVOCATION_ID = 'dsh-codex#codexCompaction/read'
/** Strict wire schema keys contributed with the invocation. */
export const COMPACTION_REQUEST_SCHEMA_NAME = 'CodexCompactionReadRequest'
/** Strict result schema key contributed with the invocation. */
export const COMPACTION_RESULT_SCHEMA_NAME = 'CodexCompactionDiagnosticsSnapshot'

/** Zod schema of the Remote request. */
export const compactionReadRequestSchema = z.object({ sessionId: z.string().min(1) })

/** Zod schema of the Remote result, matching {@link CompactionDiagnosticsSnapshot}. */
export const compactionDiagnosticsSnapshotSchema = z.object({
  v: z.literal(COMPACTION_DIAGNOSTICS_VERSION),
  persistent: z.boolean(),
  facts: z.array(factSchema),
  records: z.array(diagnosticSchema),
  session: z.object({
    state: z.enum([
      'idle',
      'pending',
      'running',
      'completed',
      'cancelled',
      'skipped-busy',
      'noop',
      'failed',
      'unknown',
    ]),
    owner: z.object({
      state: z.enum(['available', 'declared-takeover', 'conflict', 'unavailable', 'unknown']),
      evidence: z.array(z.string()),
      provider: z.string().optional(),
    }),
    at: z.number(),
    reason: z
      .enum([
        'native-disabled',
        'no-estimator',
        'no-source-budget',
        'native-request-failed',
        'invalid-response',
        'not-smaller',
        'selected-native',
        'aborted',
        'summary-failed',
        'busy',
        'noop',
      ])
      .optional(),
    requestId: z.string().optional(),
    lastOutcome: z
      .object({
        state: z.enum(['completed', 'skipped-busy', 'cancelled', 'failed', 'refused']),
        at: z.number(),
        requestId: z.string(),
        code: z.string().optional(),
      })
      .optional(),
  }),
  requests: z
    .array(
      z.object({
        requestId: z.string(),
        phase: z.enum([
          'queued',
          'running',
          'completed',
          'cancelled',
          'failed',
          'skipped-busy',
          'refused',
          'noop',
          'unknown',
        ]),
        queuedAt: z.number().optional(),
        startedAt: z.number().optional(),
        endedAt: z.number().optional(),
        compactionId: z.string().optional(),
        reason: reasonSchema.optional(),
        code: z.string().optional(),
        result: z.enum(['native', 'ordinary']).optional(),
        checkpointSeq: z.number().optional(),
        summarySeq: z.number().optional(),
      }),
    )
    .optional(),
})

/**
 * The explicit, decorator-free Host contribution: one strict readonly
 * invocation registered through the public `ctx.typert.register` contract.
 * The Gateway resolves it as a strict local definition and still validates the
 * `typertRemote` service binding at dispatch.
 */
export function compactionRemoteContribution() {
  const codec = (name: string, create: () => { parse(value: unknown): unknown }) => ({
    mode: 'strict' as const,
    typeSymbol: `${COMPACTION_TYPERT_PACKAGE}#${name}`,
    create,
  })
  // A minimal, honest public service model for the one exported method. It is
  // not a generated package model: it lists exactly what this plugin exposes so
  // the live Inspect surface can name the service and its method.
  const serviceModel = {
    key: 'compactionDiagnostics',
    exportName: 'compactionDiagnostics',
    description: 'Readonly per-session OpenAI Codex compaction diagnostics.',
    tags: [],
    members: [
      {
        kind: 'method',
        name: 'read',
        signature: 'read(request: CompactionReadRequest, signal?: AbortSignal): Promise<CompactionDiagnosticsSnapshot>',
        summary: 'Read one session\'s compaction facts, attempt records, and controller status.',
      },
    ],
    types: [
      {
        name: 'CompactionReadRequest',
        declaration: 'interface CompactionReadRequest { readonly sessionId: string }',
      },
      {
        name: 'CompactionDiagnosticsSnapshot',
        declaration: 'interface CompactionDiagnosticsSnapshot { readonly v: 1; readonly persistent: boolean; readonly facts: readonly CompactionProjectionFact[]; readonly records: readonly CompactionDiagnostic[]; readonly session: CompactionSessionStatus }',
      },
    ],
  } satisfies TypertServiceModel
  return {
    package: COMPACTION_TYPERT_PACKAGE,
    face: 'host' as const,
    // No generated reflection model is available for a hand-declared
    // invocation, but the public contract requires a real package model.
    model: { services: [serviceModel], events: [], objects: [] },
    schemas: [
      { name: COMPACTION_REQUEST_SCHEMA_NAME, create: () => compactionReadRequestSchema },
      { name: COMPACTION_RESULT_SCHEMA_NAME, create: () => compactionDiagnosticsSnapshotSchema },
    ],
    invocations: [
      {
        id: COMPACTION_TYPERT_INVOCATION_ID,
        service: 'compactionDiagnostics',
        namespace: COMPACTION_REMOTE_NAMESPACE,
        method: 'read',
        invocation: { kind: 'direct' as const },
        parameters: [
          {
            name: 'request',
            wire: 'request',
            source: 'json' as const,
            codec: codec(COMPACTION_REQUEST_SCHEMA_NAME, () => compactionReadRequestSchema),
          },
        ],
        cancellation: { parameter: 'signal' as const },
        result: codec(COMPACTION_RESULT_SCHEMA_NAME, () => compactionDiagnosticsSnapshotSchema),
      },
    ],
  } satisfies TypertContribution
}

/** Host Typert registry face used here (structural: public `register` contract). */
interface TypertRegistryLike {
  register(contribution: unknown): () => Promise<void>
}

/** Ports of {@link readCompactionSnapshot}. */
export interface CompactionReadPorts {
  readonly sessionQuery: () => SessionQueryLike
  readonly diagnostics: CompactionDiagnostics
  readonly sessionStatus?: ((sessionId: string) => CompactionSessionStatus | undefined) | undefined
  /** Controller request facts for the session, bounded; absent when unknown. */
  readonly requests?: ((sessionId: string) => readonly CompactionRequestFact[] | undefined) | undefined
  /**
   * Await the session's own maintenance, but only inside the causal settle
   * window (idle reported, `compactNow` not settled yet). Returning undefined
   * means nothing is settling and the read proceeds immediately.
   */
  readonly settleRequests?: ((sessionId: string, signal?: AbortSignal) => Promise<void> | undefined) | undefined
  readonly now?: () => number
}

/** One authorized, disposed observation of the addressed session's events. */
async function observeEvents(
  ports: CompactionReadPorts,
  sessionId: string,
  signal: AbortSignal | undefined,
): Promise<readonly CompactionSessionEventLike[]> {
  try {
    const observation = await ports.sessionQuery().observeSession(sessionId, {
      ...signal === undefined ? {} : { signal },
      projectionMode: 'none',
    })
    try {
      return observation.events ?? []
    } finally {
      observation[Symbol.dispose]?.()
    }
  } catch (error: unknown) {
    throw readFailure(sessionId, error)
  }
}

/**
 * The exact body of the readonly Remote, kept callable without a Cordis/Gateway
 * harness. Order is load-bearing: authorize and dispose one observation, await
 * the session's causal settle window, and only then take a fresh observation
 * (when waiting actually happened) before folding facts and request status. A
 * read therefore never folds a pre-completion snapshot and never blocks on a
 * long-running compaction or another session.
 * @param ports - visibility, diagnostics, request, and status ports.
 * @param request - addressed Session identity.
 * @param signal - caller lifetime of the transport.
 * @returns the session-scoped diagnostics snapshot.
 * @throws RemoteError when the argument or the observation is refused.
 */
export async function readCompactionSnapshot(
  ports: CompactionReadPorts,
  request: CompactionReadRequest,
  signal?: AbortSignal,
): Promise<CompactionDiagnosticsSnapshot> {
  const sessionId = readSessionId(request)
  let events = await observeEvents(ports, sessionId, signal)
  const settling = ports.settleRequests?.(sessionId, signal)
  if (settling !== undefined) {
    await settling
    // Fresh snapshot after the settle: the completion checkpoint/end committed
    // during the idle window must be part of the facts this read returns.
    events = await observeEvents(ports, sessionId, signal)
  }
  const facts = compactionProjectionViewSchema.parse(foldCompactionEvents(events)).facts
  await ports.diagnostics.settled()
  const records = await ports.diagnostics.recordsFor(sessionId)
  const refined = refineCancelledFacts(facts, records)
  // Restart recovery: persisted records with a verified request link are the
  // only durable request evidence. Live controller facts win for the same
  // request id; records without a link stay absent (unknown for the client).
  const requestFacts = mergeRequestFacts(
    recoveredRequestFacts(records),
    ports.requests?.(sessionId) ?? [],
  )
  return {
    v: COMPACTION_DIAGNOSTICS_VERSION,
    persistent: ports.diagnostics.persistent,
    facts: refined,
    records,
    session: ports.sessionStatus?.(sessionId) ?? {
      state: 'unknown',
      owner: { state: 'unknown', evidence: [] },
      at: ports.now?.() ?? Date.now(),
    },
    ...requestFacts.length === 0
      ? {}
      : { requests: mergeRequestStatuses(refined, requestFacts) },
  }
}

/** Bound on restored/live request facts returned by one read. */
const READ_REQUEST_FACTS_LIMIT = 16

/**
 * Recover request facts from persisted attempt records that carry a verified
 * request link. Phase and outcome stay unclaimed: {@link mergeRequestStatuses}
 * derives them from the matching core facts only, and an absent `queuedAt`
 * stays absent rather than being restored from an unrelated timestamp.
 */
export function recoveredRequestFacts(
  records: readonly CompactionDiagnostic[],
): readonly CompactionRequestFact[] {
  const recovered: CompactionRequestFact[] = []
  for (const record of records) {
    if (record.requestId === undefined || record.compactionId === null) continue
    recovered.push({
      requestId: record.requestId,
      phase: 'unknown',
      compactionId: record.compactionId,
      ...record.queuedAt === undefined ? {} : { queuedAt: record.queuedAt },
    })
  }
  return recovered.slice(-READ_REQUEST_FACTS_LIMIT)
}

/** Merge recovered and live request facts (live wins), bounded to the newest. */
export function mergeRequestFacts(
  recovered: readonly CompactionRequestFact[],
  live: readonly CompactionRequestFact[],
): readonly CompactionRequestFact[] {
  const merged = new Map<string, CompactionRequestFact>()
  for (const fact of recovered) merged.set(fact.requestId, fact)
  for (const fact of live) merged.set(fact.requestId, fact)
  return [...merged.values()].slice(-READ_REQUEST_FACTS_LIMIT)
}

/**
 * Join controller/recovered request facts with same-compactionId core facts. A
 * terminal fact always wins over a lagging controller phase; a `completed`
 * claim without such a fact downgrades to `unknown` instead of asserting
 * success. Callers pass the cancellation-refined facts.
 */
export function mergeRequestStatuses(
  facts: readonly CompactionProjectionFact[],
  requests: readonly CompactionRequestFact[],
): readonly CompactionRequestStatus[] {
  const byId = new Map<string, CompactionProjectionFact>()
  for (const fact of facts) byId.set(fact.compactionId, fact)
  return requests.map(request => {
    const fact = request.compactionId === undefined ? undefined : byId.get(request.compactionId)
    if (fact === undefined) {
      return { ...request, phase: request.phase === 'completed' ? 'unknown' : request.phase }
    }
    if (fact.endSeq === null) {
      // An open fact proves only that the transaction never closed, not that a
      // process is still executing it. Only a live controller phase may claim
      // `queued`/`running`; a recovered `unknown` stays unknown and a controller
      // terminal phase is preserved. `completed` without an end is unproven.
      const phase =
        request.phase === 'queued' || request.phase === 'running'
          ? request.phase
          : request.phase === 'completed'
            ? ('unknown' as const)
            : request.phase
      return { ...request, phase }
    }
    const proved = fact.status === 'native' || fact.status === 'ordinary'
    const phase = proved
      ? 'completed' as const
      : fact.status === 'failed'
        ? 'failed' as const
        : 'cancelled' as const
    return {
      ...request,
      phase,
      ...(proved ? { result: fact.status } : {}),
      ...fact.checkpointSeq === null ? {} : { checkpointSeq: fact.checkpointSeq },
      ...fact.summarySeq === null ? {} : { summarySeq: fact.summarySeq },
    }
  })
}

/**
 * Refine `failed` to `cancelled` only when a real runtime record for the same
 * compaction id recorded an abort. The pure projection never derives
 * cancellation from the core error string.
 */
function refineCancelledFacts(
  facts: readonly CompactionProjectionFact[],
  records: readonly CompactionDiagnostic[],
): readonly CompactionProjectionFact[] {
  const aborted = new Set(
    records
      .filter(record => record.decision === 'aborted' && record.compactionId !== null)
      .map(record => record.compactionId),
  )
  if (aborted.size === 0) return facts
  return facts.map(fact =>
    fact.status === 'failed' && aborted.has(fact.compactionId)
      ? { ...fact, status: 'cancelled' as const }
      : fact,
  )
}

/** Validate the Remote argument shape without trusting the wire. */
function readSessionId(request: CompactionReadRequest): string {
  const value = recordOf(request)?.['sessionId']
  if (typeof value !== 'string' || value.length === 0) {
    throw new RemoteError('gateway/bad-request', 'codexCompaction/read requires a sessionId', {})
  }
  return value
}

/** Local record narrowing helper. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Map an observation failure to the Remote error taxonomy. */
function readFailure(sessionId: string, error: unknown): RemoteError {
  const code = recordOf(error)?.['code']
  if (code === 'SESSION_QUERY_ABORTED') {
    return new RemoteError('gateway/cancelled', `session "${sessionId}" observation was cancelled`, {})
  }
  if (code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
    // The visible Session set is the authorization boundary here; an unknown id
    // is reported as a generic internal failure rather than leaking existence.
    return new RemoteError('gateway/internal', `session "${sessionId}" is not visible`, {})
  }
  return new RemoteError('gateway/internal', `session "${sessionId}" could not be inspected`, {})
}

/** Read the host session-query service through the Context, without a package import. */
function sessionQueryOf(ctx: Context): SessionQueryLike {
  const service = (ctx as unknown as { get(key: string): unknown }).get('sessionQuery')
  if (service === undefined) throw new RemoteError('gateway/internal', 'session query service is not composed', {})
  return service as SessionQueryLike
}

/** Options of {@link installCompactionDiagnostics}. */
export interface CompactionDiagnosticsInstall {
  /** Resolve the real open compaction id of one live session. */
  readonly resolveCompactionId?: (sessionId: string) => string | undefined
  /** Controller-provided session status, merged into the readonly read. */
  readonly sessionStatus?: ((sessionId: string) => CompactionSessionStatus | undefined) | undefined
  /** Controller request facts, joined to facts by real compactionId. */
  readonly requests?: ((sessionId: string) => readonly CompactionRequestFact[] | undefined) | undefined
  /** Causal settle window of the session's own maintenance. */
  readonly settleRequests?: ((sessionId: string, signal?: AbortSignal) => Promise<void> | undefined) | undefined
}

/**
 * Register the projection and the readonly Remote, and return the diagnostics
 * recorder the response runtime reports decisions to.
 * @param ctx - host context of the plugin.
 * @param install - optional identity/status ports from the Agent controller.
 * @returns the recorder plus its disposer.
 */
export function installCompactionDiagnostics(
  ctx: Context,
  install: CompactionDiagnosticsInstall = {},
): { diagnostics: CompactionDiagnostics; dispose: () => Promise<void> } {
  const diagnostics = new CompactionDiagnostics({
    storage: () => (ctx as unknown as { get(key: string): unknown }).get('storageDomain') as StorageDomainFacilityLike | undefined,
    ...install.resolveCompactionId === undefined ? {} : { resolveCompactionId: install.resolveCompactionId },
  })
  ctx.inject(['sessionProjections'], projectionCtx => {
    projectionCtx.effect(
      () => (projectionCtx as unknown as { sessionProjections: ProjectionRegistryLike }).sessionProjections.register({
        key: COMPACTION_PROJECTION_KEY,
        stateVersion: COMPACTION_PROJECTION_STATE_VERSION,
        stateSchema: compactionProjectionStateSchema,
        init: () => initCompactionProjection(),
        apply: (state: ProjectionCell, event: CompactionSessionEventLike) => applyCompactionEvent(state, event),
        wire: {
          viewSchema: compactionProjectionViewSchema,
          view: (state: ProjectionCell) => viewCompactionProjection(state),
        },
      }),
      'dsh-openai-codex: compaction projection',
    )
  })
  ctx.inject(['sessionQuery', 'typert'], remoteCtx => {
    const context = remoteCtx as unknown as {
      plugin: (plugin: unknown, config?: unknown) => unknown
      effect: (
        callback: () => (() => void | Promise<void>),
        label: string,
      ) => unknown
      typert: TypertRegistryLike
    }
    context.plugin(CompactionRemote, {
      diagnostics,
      ...install.sessionStatus === undefined ? {} : { sessionStatus: install.sessionStatus },
      ...install.requests === undefined ? {} : { requests: install.requests },
      ...install.settleRequests === undefined ? {} : { settleRequests: install.settleRequests },
    })
    // A duplicated package face (for example this plugin mounted by more than
    // one preset in the same Host) is rejected by the registry; the read stays
    // unavailable there instead of failing the plugin mount. The registry
    // disposer is async, so Cordis awaits the withdrawal on unmount.
    context.effect(
      () => {
        try {
          return context.typert.register(compactionRemoteContribution())
        } catch {
          return async () => undefined
        }
      },
      'dsh-openai-codex: compaction remote contribution',
    )
  })
  return { diagnostics, dispose: () => diagnostics.dispose() }
}

/** Projection registry face used by this module (structural: no package import). */
interface ProjectionRegistryLike {
  register(definition: {
    key: string
    stateVersion: number
    stateSchema: unknown
    init: (header: unknown, inheritedEventCount: number) => ProjectionCell
    apply: (state: ProjectionCell, event: CompactionSessionEventLike) => ProjectionCell
    wire: {
      viewSchema: unknown
      view: (state: ProjectionCell) => CompactionProjectionView
    }
  }): () => void
}

/** Re-exported for callers that only hold the projection state type. */
export type { CompactionProjectionState, CompactionProjectionFact }
