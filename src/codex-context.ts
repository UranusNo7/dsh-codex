/**
 * Codex context controller: owner facts, one queued native compaction request
 * per current Agent, and bounded recall from that Agent's own session log.
 *
 * This module never bypasses the composed services: compaction runs only
 * through the Agent-scoped `compaction` service, so a successful run replaces a
 * surface span exactly as that service decides. Nothing here writes session
 * events, provider routing, or any external declaration. A request is only
 * ever *accepted* while the tool call runs; compaction starts at the public
 * `agent/status` idle boundary, because `compactNow` requires an idle agent.
 */

import type {
  CompactionLocalEstimate,
  CompactionOutcomeStatus,
  CompactionOwnerStatus,
  CompactionProviderUsage,
  CompactionReason,
  CompactionRequestFact,
  CompactionSessionStatus,
} from './compaction-types.ts'

/** Provider whose agents may see the Codex context tool. */
export const CODEX_CONTEXT_PROVIDER = 'openai-codex'

/** Default number of recall items returned by one call. */
export const RECALL_DEFAULT_LIMIT = 20
/** Hard upper bound for one recall call. */
export const RECALL_MAX_LIMIT = 50
/** Maximum number of raw-log events scanned by one recall call. */
export const RECALL_MAX_SCAN_EVENTS = 2_000
/** Maximum total characters returned by one recall call. */
export const RECALL_MAX_TOTAL_CHARS = 16 * 1024
/** Maximum characters kept from one recall item. */
export const RECALL_MAX_ITEM_CHARS = 500
/** Minimum delay between two finished requests on one Agent. */
export const COMPACTION_COOLDOWN_MS = 60_000
/** Process-level takeover declaration published by bundle overlays. */
export const TAKEOVER_DECLARATION_KEY = '__BILI_DSH_COMPACTION_VERDICT__'
/** Persisted native-checkpoint marker starts: excluded wholesale from recall. */
const MARKER_PREFIX = '<dsh-openai-codex-compaction-4f5cf1b7-v1>'

/** One raw event as the session log exposes it (read-only). */
export interface CodexContextEvent {
  readonly seq: number
  readonly type: string
  readonly data?: unknown
}

/** The current Agent's own session: the only history source this module reads. */
export interface CodexContextSession {
  readonly id?: string
  readonly requestHeader?: () =>
    | { readonly config?: { readonly provider?: string } }
    | undefined
}

/** Range handed to the read-only history port; `toSeqExclusive` may be Infinity. */
export interface HistoryRange {
  readonly fromSeq: number
  readonly toSeqExclusive: number
}

/** One authorized observation result from the read-only history port. */
export interface HistoryPage {
  readonly events: readonly CodexContextEvent[]
  /** One past the last durable seq, used for bounded windows and continuation. */
  readonly endSeq: number
}

/**
 * Read-only history port supplied by the Host. The controller passes the
 * calling Agent (never a caller session id); the Host authorizes, observes,
 * filters, and disposes the underlying session observation.
 */
export type ReadHistory = (
  agent: CodexContextAgent,
  range: HistoryRange,
  signal?: AbortSignal,
) => Promise<HistoryPage | undefined>

/** Minimal structural Agent shape used here (never accepts a caller session id). */
export interface CodexContextAgent {
  readonly id: string
  readonly session?: CodexContextSession
  readonly options?: { readonly provider?: string }
}

/** The agent-scoped compaction service as resolved through the Agent composition. */
export interface CodexCompactionService {
  compactNow(agent: unknown, signal: AbortSignal): Promise<unknown>
}

export type CompactionOwnerState =
  | 'available'
  | 'declared-takeover'
  | 'conflict'
  | 'unavailable'

/** Factual owner verdict: what was observed, never an inference from installation. */
export interface CompactionOwner {
  readonly state: CompactionOwnerState
  readonly evidence: readonly string[]
  readonly provider?: string
}

/** Accepted request that runs once, after the current turn reaches idle. */
export interface QueuedCompactionTicket {
  readonly requestId: string
  readonly status: 'queued'
  readonly boundary: 'after-current-turn'
  readonly requestedAt: number
}

export type CompactionRequestResult =
  | { readonly status: 'queued'; readonly ticket: QueuedCompactionTicket }
  | { readonly status: 'already-queued'; readonly ticket: QueuedCompactionTicket }
  | {
      readonly status: 'refused'
      readonly reason: 'owner' | 'provider' | 'disposed' | 'identity' | 'source-turn'
      readonly owner: CompactionOwner
    }
  | { readonly status: 'cooldown'; readonly retryAt: number }

/** Provenance the tool supplies from its own execution context (never model args). */
export interface CompactionRequestOptions {
  /** Tool-call id that requested the compaction. */
  readonly callId?: string
}

/**
 * Public `turnBoundary` projection facts (registered by the agent loop).
 * `undefined` from the resolver means the capability is absent.
 */
export interface TurnBoundaryLike {
  /** Seq of the open turn's `turn/start`, or null between turns. */
  readonly openTurnStartSeq: number | null
  /** Turn number of the latest `turn/start`; 0 before the first turn. */
  readonly lastTurn: number
}

export type CompactionOutcomeState =
  | 'completed'
  | 'noop'
  | 'skipped-busy'
  | 'cancelled'
  | 'failed'
  | 'refused'

/** Fixed failure vocabulary: raw provider/core error text never leaves here. */
export type CompactionFailureReason =
  | 'busy'
  | 'cancelled'
  | 'summary'
  | 'commit'
  | 'changed'
  | 'persistence'
  | 'noop'
  | 'unknown'

const FAILURE_REASONS: readonly CompactionFailureReason[] = [
  'busy',
  'cancelled',
  'summary',
  'commit',
  'changed',
  'persistence',
  'noop',
  'unknown',
]

/** Result of one boundary execution, recorded as a fact (never as success). */
export interface CompactionOutcome {
  readonly state: CompactionOutcomeState
  readonly requestId: string
  readonly at: number
  readonly reason?: CompactionFailureReason | CompactionOwnerState
}

/** Observable phase of one accepted request, for read-only diagnostics. */
export type CompactionRequestPhase =
  | 'queued'
  | 'started'
  | 'completed'
  | 'noop'
  | 'skipped-busy'
  | 'cancelled'
  | 'failed'
  | 'refused'

/** One diagnostics record; the controller never projects or persists it. */
export interface CompactionRequestChange {
  readonly requestId: string
  readonly phase: CompactionRequestPhase
  readonly at: number
  readonly compactionId?: string
  readonly reason?: string
}

/** Optional read-only facts merged from a diagnostics provider. */
export interface CodexContextDiagnostics {
  readonly localEstimate?: CompactionLocalEstimate
  readonly providerUsage?: CompactionProviderUsage
}

/** Read-only snapshot returned by `status`. */
export interface CodexContextSnapshot {
  readonly owner: CompactionOwner
  readonly queued?: QueuedCompactionTicket
  readonly lastOutcome?: CompactionOutcome
  readonly localEstimate?: CompactionLocalEstimate
  readonly providerUsage?: CompactionProviderUsage
}

export interface RecallQuery {
  readonly fromSeq?: number
  readonly toSeq?: number
  readonly query?: string
  readonly limit?: number
  /** Caller lifetime forwarded to the read-only history port. */
  readonly signal?: AbortSignal
}

export interface RecallItem {
  readonly seq: number
  readonly type: string
  readonly kind: 'message' | 'tool-result'
  readonly role?: string
  readonly text: string
  readonly truncated?: boolean
  /** Character offset of `text` inside the whole event text, when truncated. */
  readonly charOffset?: number
  /** Whole event text length, when known. */
  readonly totalChars?: number
}

export type RecallResult =
  | {
      readonly ok: true
      readonly fromSeq: number
      readonly toSeqExclusive: number
      readonly scanned: number
      readonly items: readonly RecallItem[]
      readonly truncated: boolean
      readonly nextFromSeq?: number
    }
  | { readonly ok: false; readonly reason: 'no-session' | 'identity' | 'history-unavailable' }

/** Events consumed by {@link CodexContextController.attach}. */
export interface CodexContextEventSource {
  on(
    event: 'agent/status',
    listener: (payload: { readonly agent: CodexContextAgent; readonly status: string }) => void,
  ): () => void
  on(
    event: 'agent/disposed',
    listener: (payload: { readonly agent: CodexContextAgent }) => void,
  ): () => void
  /**
   * Post-commit session event feed, used only to observe the accepted turn's
   * own `turn/end`; no history cache is built from it.
   */
  on(
    event: 'session/event',
    listener: (session: { readonly id: string }, event: CodexContextEvent) => void,
  ): () => void
}

export interface CodexContextControllerOptions {
  /** Resolve the compaction service in the Agent's own composition. */
  readonly resolveCompaction: (
    agent: CodexContextAgent,
  ) => CodexCompactionService | undefined
  /** Whether an external bundle declared a takeover for this process. */
  readonly takeoverDeclared: () => boolean
  /** Optional read-only diagnostics provider (facts already measured elsewhere). */
  readonly diagnostics?: (agent: CodexContextAgent) => CodexContextDiagnostics | undefined
  /** Optional read-only phase notification for a diagnostics owner. */
  readonly onRequestChange?: (
    sessionId: string,
    change: CompactionRequestChange,
  ) => void
  /** Clock override for tests. */
  readonly now?: () => number
  /** Cooldown override for tests. */
  readonly cooldownMs?: number
  /** Unique request-id factory; defaults to a random UUID per request. */
  readonly idFactory?: () => string
  /**
   * Resolve the accepted turn from the public host `turnBoundary` projection.
   * `undefined` means the capability is absent; the request is then refused
   * instead of guessing a turn.
   */
  readonly resolveSourceTurn?: (agent: CodexContextAgent) => TurnBoundaryLike | undefined
  /**
   * Authorized read-only history port (Host-owned session observation). The
   * controller never receives or uses a caller session id itself.
   */
  readonly readHistory?: ReadHistory
}

interface AcceptedEntry {
  readonly ticket: QueuedCompactionTicket
  readonly controller: AbortController
  readonly agent: CodexContextAgent
  readonly generation: number
  /** Turn the request was accepted in; undefined when it could not be proven. */
  readonly sourceTurn: number | undefined
  /** Tool-call identity that requested the compaction. */
  readonly callId: string | undefined
  /** Durable turn/end kind observed for `sourceTurn` through the event feed. */
  observedTurnEnd: string | undefined
  /** Open only while this request's own `compactNow` call may emit its start. */
  capture: { active: boolean; compactionId?: string } | undefined
}

/** Bound on retained request facts per session; the oldest entries drop first. */
const REQUEST_FACTS_LIMIT = 16

/** Fixed controller classes permitted to cross into the request DTO. */
const REQUEST_CODES: readonly string[] = [
  'busy',
  'cancelled',
  'summary',
  'commit',
  'changed',
  'persistence',
  'noop',
]

/** One fixed controller class, or undefined for anything else. */
function requestCode(code: string | undefined): string | undefined {
  return code !== undefined && REQUEST_CODES.includes(code) ? code : undefined
}

/** Map one terminal outcome state onto the request phase vocabulary. */
function requestPhaseOf(state: CompactionOutcomeState): CompactionRequestFact['phase'] {
  switch (state) {
    case 'completed':
      return 'completed'
    case 'noop':
      return 'noop'
    case 'skipped-busy':
      return 'skipped-busy'
    case 'cancelled':
      return 'cancelled'
    case 'failed':
      return 'failed'
    case 'refused':
      return 'refused'
  }
}

/** Provider of one Agent: routed header first, configured option second. */
export function agentProvider(agent: CodexContextAgent): string | undefined {
  const routed = agent.session?.requestHeader?.()?.config?.provider
  if (typeof routed === 'string' && routed !== '') return routed
  const configured = agent.options?.provider
  return typeof configured === 'string' && configured !== '' ? configured : undefined
}

/** Whether an overlay declared that it owns compaction in this process. */
export function takeoverDeclared(
  host: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): boolean {
  return host[TAKEOVER_DECLARATION_KEY] === 'active'
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    const candidate = record(block)
    if (candidate === undefined) continue
    if (candidate['type'] !== 'text') continue
    const text = candidate['text']
    if (typeof text === 'string' && text !== '') parts.push(text)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

interface ExtractedText {
  readonly kind: 'message' | 'tool-result'
  readonly role?: string
  readonly text: string
}

function messageText(value: unknown, kind: 'message' | 'tool-result'): ExtractedText | undefined {
  const message = record(value)
  if (message === undefined) return undefined
  const text = contentText(message['content'])
  if (text === undefined) return undefined
  // A native checkpoint message carries an opaque payload; exclude it wholesale.
  if (text.includes(MARKER_PREFIX)) return undefined
  const role = message['role']
  return {
    kind,
    text,
    ...(typeof role === 'string' ? { role } : {}),
  }
}

/**
 * Extract only plain text from one durable event. Opaque payloads, native
 * checkpoint markers, and hidden system/developer prompts are never surfaced.
 * @param event - one raw session-log event.
 * @returns the text-bearing projection, or undefined when the event has none.
 */
export function extractEventText(event: CodexContextEvent): ExtractedText | undefined {
  const data = record(event.data)
  if (data === undefined) return undefined
  switch (event.type) {
    case 'user/message':
      return messageText(data, 'message')
    case 'tool/result':
      return messageText(data['message'], 'tool-result')
    case 'assistant/message':
      return messageText(data['message'], 'message')
    default:
      return undefined
  }
}

/** Map one thrown failure onto the fixed reason vocabulary. */
function failureReason(error: unknown): CompactionFailureReason {
  const code = record(error)?.['code']
  return typeof code === 'string' && (FAILURE_REASONS as readonly string[]).includes(code)
    ? (code as CompactionFailureReason)
    : 'unknown'
}

/** Sanitized diagnostics reason for one finished outcome (no raw codes). */
function diagnosticsReason(outcome: CompactionOutcome): CompactionReason | undefined {
  if (outcome.state === 'noop') return 'noop'
  if (outcome.state === 'cancelled') return 'aborted'
  switch (outcome.reason) {
    case 'busy':
      return 'busy'
    case 'cancelled':
      return 'aborted'
    case 'summary':
      return 'summary-failed'
    default:
      return undefined
  }
}

/** Best-effort id from a compaction result; never synthesized. */
function resultCompactionId(result: unknown): string | undefined {
  const id = record(result)?.['compactionId']
  return typeof id === 'string' ? id : undefined
}

/** Turn number of the projection's open turn: `lastTurn` while one is open. */
function turnFromBoundary(boundary: TurnBoundaryLike): number | undefined {
  if (boundary.openTurnStartSeq === null) return undefined
  return boundary.lastTurn > 0 ? boundary.lastTurn : undefined
}

/** Turn-end reason kind of one durable `turn/end` event (`completed`, `aborted`, …). */
function turnEndKind(data: unknown): string | undefined {
  const reason = record(record(data)?.['reason'])?.['kind']
  return typeof reason === 'string' ? reason : undefined
}

/** Bounded snippet around the first match; the whole head when no needle. */
function recallSnippet(
  text: string,
  needle: string | undefined,
): { readonly text: string; readonly charOffset: number; readonly totalChars: number; readonly truncated: boolean } {
  if (needle === undefined) {
    return {
      text: text.length > RECALL_MAX_ITEM_CHARS ? text.slice(0, RECALL_MAX_ITEM_CHARS) : text,
      charOffset: 0,
      totalChars: text.length,
      truncated: text.length > RECALL_MAX_ITEM_CHARS,
    }
  }
  const index = text.toLowerCase().indexOf(needle)
  if (index < 0) return { text: '', charOffset: 0, totalChars: text.length, truncated: false }
  const offset = Math.max(0, index - Math.floor(RECALL_MAX_ITEM_CHARS / 2))
  const snippet = text.slice(offset, offset + RECALL_MAX_ITEM_CHARS)
  return {
    text: snippet,
    charOffset: offset,
    totalChars: text.length,
    truncated: offset > 0 || offset + snippet.length < text.length,
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)))
}

/** Owner facts, one queued request per Agent, and bounded current-session recall. */
export class CodexContextController {
  private readonly queuedBySession = new Map<string, AcceptedEntry>()
  private readonly runningBySession = new Map<string, AcceptedEntry>()
  private readonly inflight = new Set<Promise<void>>()
  private readonly outcomes = new Map<string, CompactionOutcome>()
  private readonly finishedAt = new Map<string, number>()
  private readonly agentsBySession = new Map<string, CodexContextAgent>()
  private readonly generation = new Map<string, number>()
  /** Bounded per-session request phase facts; no success claim lives here. */
  private readonly requestFacts = new Map<string, Map<string, CompactionRequestFact>>()
  /** In-flight maintenance per session, used only inside the settle window. */
  private readonly runningTask = new Map<string, Promise<void>>()
  private readonly now: () => number
  private readonly cooldownMs: number
  private readonly idFactory: () => string
  private disposed = false

  constructor(private readonly options: CodexContextControllerOptions) {
    this.now = options.now ?? (() => Date.now())
    this.cooldownMs = options.cooldownMs ?? COMPACTION_COOLDOWN_MS
    this.idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID())
  }

  /** Observed owner facts for one Agent, in the Agent's own composition. */
  owner(agent: CodexContextAgent): CompactionOwner {
    this.remember(agent)
    const provider = agentProvider(agent)
    const evidence: string[] = []
    const service = this.options.resolveCompaction(agent)
    const declared = this.options.takeoverDeclared() === true
    if (service === undefined) {
      evidence.push('no-agent-scoped-compaction-service')
      if (declared) {
        evidence.push('external-takeover-declaration-active')
        return {
          state: 'declared-takeover',
          evidence,
          ...(provider === undefined ? {} : { provider }),
        }
      }
      return {
        state: 'unavailable',
        evidence,
        ...(provider === undefined ? {} : { provider }),
      }
    }
    evidence.push('agent-scoped-compaction-service-present')
    if (declared) {
      evidence.push('external-takeover-declaration-conflicts-with-service')
      return {
        state: 'conflict',
        evidence,
        ...(provider === undefined ? {} : { provider }),
      }
    }
    return {
      state: 'available',
      evidence,
      ...(provider === undefined ? {} : { provider }),
    }
  }

  /** Facts only: no accepted request is reported as a completed compaction. */
  snapshot(agent: CodexContextAgent): CodexContextSnapshot {
    const queued = this.pending(agent)
    const outcome = this.lastOutcome(agent)
    const diagnostics = this.options.diagnostics?.(agent)
    return {
      owner: this.owner(agent),
      ...(queued === undefined ? {} : { queued }),
      ...(outcome === undefined ? {} : { lastOutcome: outcome }),
      ...(diagnostics?.localEstimate === undefined
        ? {}
        : { localEstimate: diagnostics.localEstimate }),
      ...(diagnostics?.providerUsage === undefined
        ? {}
        : { providerUsage: diagnostics.providerUsage }),
    }
  }

  /** The accepted ticket for this exact Agent instance, if any. */
  pending(agent: CodexContextAgent): QueuedCompactionTicket | undefined {
    const queued = this.queuedBySession.get(agent.id)
    if (queued !== undefined && queued.agent === agent) return queued.ticket
    const running = this.runningBySession.get(agent.id)
    if (running !== undefined && running.agent === agent) return running.ticket
    return undefined
  }

  /** Ticket for a session id, regardless of Agent instance (read-only status). */
  private sessionTicket(sessionId: string): QueuedCompactionTicket | undefined {
    return (
      this.queuedBySession.get(sessionId)?.ticket ?? this.runningBySession.get(sessionId)?.ticket
    )
  }

  /** The last boundary outcome for this Agent, if any. */
  lastOutcome(agent: CodexContextAgent): CompactionOutcome | undefined {
    return this.outcomes.get(agent.id)
  }

  /**
   * Read-only status for one session id, for a diagnostics read RPC.
   * @param sessionId - the session whose controller state is asked about.
   * @returns sanitized status, or undefined when this controller knows nothing.
   */
  statusForSession(sessionId: string): CompactionSessionStatus | undefined {
    if (this.disposed) return undefined
    const agent = this.agentsBySession.get(sessionId)
    const ticket = this.sessionTicket(sessionId)
    const outcome = this.outcomes.get(sessionId)
    if (agent === undefined && ticket === undefined && outcome === undefined) return undefined
    const owner: CompactionOwnerStatus =
      agent === undefined ? { state: 'unknown', evidence: [] } : this.owner(agent)
    const at = ticket?.requestedAt ?? outcome?.at ?? this.now()
    const lastOutcome: CompactionOutcomeStatus | undefined =
      outcome === undefined || outcome.state === 'noop'
        ? undefined
        : {
            state: outcome.state,
            at: outcome.at,
            requestId: outcome.requestId,
            ...(outcome.reason === undefined ? {} : { code: outcome.reason }),
          }
    if (this.runningBySession.has(sessionId)) {
      return {
        state: 'running',
        owner,
        at,
        ...(ticket === undefined ? {} : { requestId: ticket.requestId }),
        ...(lastOutcome === undefined ? {} : { lastOutcome }),
      }
    }
    if (this.queuedBySession.has(sessionId)) {
      return {
        state: 'pending',
        owner,
        at,
        ...(ticket === undefined ? {} : { requestId: ticket.requestId }),
        ...(lastOutcome === undefined ? {} : { lastOutcome }),
      }
    }
    if (outcome === undefined) return { state: 'idle', owner, at }
    const reason = diagnosticsReason(outcome)
    return {
      state:
        outcome.state === 'completed'
          ? 'completed'
          : outcome.state === 'noop'
            ? 'noop'
            : outcome.state === 'cancelled'
              ? 'cancelled'
              : outcome.state === 'skipped-busy'
                ? 'skipped-busy'
                : 'failed',
      owner,
      at: outcome.at,
      ...(reason === undefined ? {} : { reason }),
      requestId: outcome.requestId,
      ...(lastOutcome === undefined ? {} : { lastOutcome }),
    }
  }

  /**
   * Read-only, bounded request facts for one session.
   * @param sessionId - the session whose accepted requests are asked about.
   * @returns newest-last facts, or undefined when this controller has none.
   */
  requestsForSession(sessionId: string): readonly CompactionRequestFact[] | undefined {
    if (this.disposed) return undefined
    const facts = this.requestFacts.get(sessionId)
    if (facts === undefined || facts.size === 0) return undefined
    return [...facts.values()]
  }

  /** Store one bounded request fact, replacing the oldest past the limit. */
  private recordRequest(sessionId: string, fact: CompactionRequestFact): void {
    const facts = this.requestFacts.get(sessionId) ?? new Map<string, CompactionRequestFact>()
    // A Map keeps insertion order; re-setting an existing key keeps its slot.
    facts.set(fact.requestId, fact)
    while (facts.size > REQUEST_FACTS_LIMIT) {
      const oldest = facts.keys().next().value
      if (oldest === undefined) break
      facts.delete(oldest)
    }
    this.requestFacts.set(sessionId, facts)
  }

  /** Merge one partial update into an existing request fact. */
  private patchRequest(
    sessionId: string,
    requestId: string,
    patch: Partial<Omit<CompactionRequestFact, 'requestId'>>,
  ): void {
    const current = this.requestFacts.get(sessionId)?.get(requestId)
    this.recordRequest(sessionId, {
      ...(current ?? { requestId, phase: 'unknown' as const }),
      requestId,
      ...patch,
    })
  }

  /** Drop a captured compaction id whose returned identity did not agree. */
  private dropRequestCompactionId(sessionId: string, requestId: string): void {
    const current = this.requestFacts.get(sessionId)?.get(requestId)
    if (current?.compactionId === undefined) return
    const { compactionId: _dropped, ...rest } = current
    this.recordRequest(sessionId, { ...rest, requestId })
  }

  /**
   * Accept one boundary compaction request. This never starts compaction: the
   * ticket is consumed by {@link attach}'s idle handler.
   * @param agent - the calling Agent; its own id keys the pending request.
   * @returns the queued ticket or a factual refusal.
   */
  requestCompaction(
    agent: CodexContextAgent,
    options: CompactionRequestOptions = {},
  ): CompactionRequestResult {
    this.remember(agent)
    const owner = this.owner(agent)
    if (this.disposed) return { status: 'refused', reason: 'disposed', owner }
    if (!this.identityMatches(agent)) return { status: 'refused', reason: 'identity', owner }
    if (agentProvider(agent) !== CODEX_CONTEXT_PROVIDER) {
      return { status: 'refused', reason: 'provider', owner }
    }
    if (owner.state !== 'available') return { status: 'refused', reason: 'owner', owner }
    // A different Agent instance for this session id owns the session now;
    // drop the old instance's bookkeeping so its late completion cannot land.
    const queuedEntry = this.queuedBySession.get(agent.id)
    const runningEntry = this.runningBySession.get(agent.id)
    if (
      (queuedEntry !== undefined && queuedEntry.agent !== agent) ||
      (runningEntry !== undefined && runningEntry.agent !== agent)
    ) {
      this.abandon(agent.id)
      this.remember(agent)
    }
    const existing = this.sessionTicket(agent.id)
    if (existing !== undefined) return { status: 'already-queued', ticket: existing }
    const finished = this.finishedAt.get(agent.id)
    if (finished !== undefined && this.now() - finished < this.cooldownMs) {
      return { status: 'cooldown', retryAt: finished + this.cooldownMs }
    }
    // The public turnBoundary projection is the only accepted source turn.
    // A ticket whose source turn cannot be proven is refused at acceptance
    // rather than accepted and refused later; no log scan is used.
    const boundary = this.options.resolveSourceTurn?.(agent)
    const sourceTurn = boundary === undefined ? undefined : turnFromBoundary(boundary)
    if (sourceTurn === undefined) {
      return { status: 'refused', reason: 'source-turn', owner }
    }
    const ticket: QueuedCompactionTicket = {
      requestId: this.idFactory(),
      status: 'queued',
      boundary: 'after-current-turn',
      requestedAt: this.now(),
    }
    // Provenance comes from the projection and the calling tool execution,
    // never from model arguments.
    this.queuedBySession.set(agent.id, {
      ticket,
      controller: new AbortController(),
      agent,
      generation: this.generation.get(agent.id) ?? 0,
      sourceTurn,
      callId: options.callId,
      observedTurnEnd: undefined,
      capture: undefined,
    })
    this.recordRequest(agent.id, {
      requestId: ticket.requestId,
      phase: 'queued',
      queuedAt: ticket.requestedAt,
    })
    this.emit(agent.id, { requestId: ticket.requestId, phase: 'queued', at: ticket.requestedAt })
    return { status: 'queued', ticket }
  }
  /**
   * Read bounded plain-text history through the Host's read-only history port.
   * The controller never receives or uses a caller session id.
   * @param agent - the calling Agent.
   * @param query - optional bounded range and filters.
   * @returns a bounded page with its own seq provenance, or an explicit reason.
   */
  async recall(agent: CodexContextAgent, query: RecallQuery = {}): Promise<RecallResult> {
    this.remember(agent)
    if (!this.identityMatches(agent)) return { ok: false, reason: 'identity' }
    if (agent.session === undefined) return { ok: false, reason: 'no-session' }
    const readHistory = this.options.readHistory
    if (readHistory === undefined) return { ok: false, reason: 'history-unavailable' }
    const requestedFrom =
      query.fromSeq !== undefined && Number.isFinite(query.fromSeq)
        ? Math.max(0, Math.trunc(query.fromSeq))
        : 0
    const requestedTo =
      query.toSeq !== undefined && Number.isFinite(query.toSeq)
        ? Math.max(requestedFrom, Math.trunc(query.toSeq))
        : Number.POSITIVE_INFINITY
    let page: HistoryPage | undefined
    try {
      page = await readHistory(
        agent,
        { fromSeq: requestedFrom, toSeqExclusive: requestedTo },
        query.signal,
      )
    } catch {
      return { ok: false, reason: 'history-unavailable' }
    }
    if (page === undefined) return { ok: false, reason: 'history-unavailable' }
    const end =
      typeof page.endSeq === 'number' && Number.isFinite(page.endSeq)
        ? Math.max(0, Math.trunc(page.endSeq))
        : 0
    const from =
      query.fromSeq !== undefined && Number.isFinite(query.fromSeq)
        ? Math.max(0, Math.trunc(query.fromSeq))
        : Math.max(0, end - RECALL_MAX_SCAN_EVENTS)
    const to = Math.min(
      query.toSeq !== undefined && Number.isFinite(query.toSeq) ? Math.max(from, Math.trunc(query.toSeq)) : end,
      from + RECALL_MAX_SCAN_EVENTS,
      end,
    )
    const limit = clamp(query.limit ?? RECALL_DEFAULT_LIMIT, 1, RECALL_MAX_LIMIT)
    const needle = query.query?.toLowerCase()
    const events = page.events.filter((event) => event.seq >= from && event.seq < to)

    const items: RecallItem[] = []
    let scanned = 0
    let characters = 0
    let truncated = false
    let continuation: number | undefined = to < end ? to : undefined

    for (const event of events) {
      scanned += 1
      const extracted = extractEventText(event)
      if (extracted === undefined) continue
      if (needle !== undefined && !extracted.text.toLowerCase().includes(needle)) continue
      const snippet = recallSnippet(extracted.text, needle)
      if (characters + snippet.text.length > RECALL_MAX_TOTAL_CHARS) {
        truncated = true
        continuation = event.seq
        break
      }
      characters += snippet.text.length
      items.push({
        seq: event.seq,
        type: event.type,
        kind: extracted.kind,
        ...(extracted.role === undefined ? {} : { role: extracted.role }),
        text: snippet.text,
        ...(snippet.truncated ? { truncated: true } : {}),
        ...(snippet.charOffset === 0 ? {} : { charOffset: snippet.charOffset }),
        ...(snippet.truncated ? { totalChars: snippet.totalChars } : {}),
      })
      if (items.length >= limit) {
        truncated = true
        continuation = event.seq + 1
        break
      }
    }

    return {
      ok: true,
      fromSeq: from,
      toSeqExclusive: to,
      scanned,
      items,
      truncated,
      ...(continuation === undefined ? {} : { nextFromSeq: continuation }),
    }
  }

  /**
   * Consume accepted tickets at the public idle boundary.
   * @param source - the Host event source carrying `agent/status`/`agent/disposed`.
   * @returns the listener disposer.
   */
  attach(source: CodexContextEventSource): () => void {
    const offStatus = source.on('agent/status', ({ agent, status }) => {
      this.adopt(agent)
      if (status !== 'idle') return
      this.startIdle(agent)
    })
    const offDisposed = source.on('agent/disposed', ({ agent }) => {
      this.abandon(agent.id)
    })
    // Lifecycle observation for this ticket only: remember its own turn/end.
    const offTurnEnd = source.on('session/event', (session, event) => {
      if (event.type === 'compaction/start') {
        this.captureCompactionStart(session.id, event)
        return
      }
      if (event.type !== 'turn/end') return
      const entry = this.queuedBySession.get(session.id)
      if (entry === undefined) return
      if (record(event.data)?.['turn'] !== entry.sourceTurn) return
      entry.observedTurnEnd = turnEndKind(event.data)
    })
    return () => {
      offStatus()
      offDisposed()
      offTurnEnd()
    }
  }

  /**
   * Capture the core `compaction/start` of this request's own `compactNow`
   * call only: same Agent instance and generation, inside the open call window,
   * ownerless (`turn === null`) and without a source command id.
   */
  private captureCompactionStart(sessionId: string, event: CodexContextEvent): void {
    const entry = this.runningBySession.get(sessionId)
    if (entry === undefined || entry.capture?.active !== true) return
    if (entry.capture.compactionId !== undefined) return
    if (this.agentsBySession.get(sessionId) !== entry.agent) return
    if ((this.generation.get(sessionId) ?? 0) !== entry.generation) return
    const data = record(event.data)
    if (data === undefined) return
    const compactionId = data['compactionId']
    if (typeof compactionId !== 'string' || compactionId.length === 0) return
    // Only the standalone call this controller issued: no turn owner, no
    // source command identity to inherit from another command.
    if (data['turn'] !== null && data['turn'] !== undefined) return
    if (data['sourceCommandId'] !== undefined) return
    entry.capture.compactionId = compactionId
    this.patchRequest(sessionId, entry.ticket.requestId, {
      phase: 'running',
      compactionId,
      ...(entry.ticket.requestedAt === undefined ? {} : { queuedAt: entry.ticket.requestedAt }),
    })
  }

  /**
   * Await this session's own maintenance only while its marker evidence is
   * absent. The real core appends `compaction/start` synchronously before its
   * first await whenever there is a span to compact, so:
   * - a captured start means a real compaction: never block (the read's facts
   *   decide running vs terminal);
   * - no captured start inside our own active call window means the only
   *   terminals are noop/busy/pre-call failure, which emit no event, so waiting
   *   is bounded by this request's own task.
   * Outside the window, for another generation, or for an aborted caller the
   * result is immediate. No timer and no polling are involved.
   * @param sessionId - the session whose request may be settling.
   * @param signal - caller lifetime; an aborted caller does not wait.
   * @returns the request's own maintenance promise inside the window, else undefined.
   */
  settleForRead(sessionId: string, signal?: AbortSignal): Promise<void> | undefined {
    if (this.disposed || signal?.aborted === true) return undefined
    const entry = this.runningBySession.get(sessionId)
    if (entry === undefined) return undefined
    if ((this.generation.get(sessionId) ?? 0) !== entry.generation) return undefined
    if (entry.capture?.compactionId !== undefined) return undefined
    return entry.capture?.active === true ? this.runningTask.get(sessionId) : undefined
  }

  /**
   * Abort every accepted request and wait for the running maintenance to
   * settle; no background promise survives this call.
   * @returns completion after every in-flight task settled.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const entry of this.queuedBySession.values()) entry.controller.abort()
    for (const entry of this.runningBySession.values()) entry.controller.abort()
    this.queuedBySession.clear()
    await Promise.allSettled([...this.inflight])
    this.runningBySession.clear()
  }

  /** One session may only address its own log. */
  private identityMatches(agent: CodexContextAgent): boolean {
    const sessionId = agent.session?.id
    return sessionId === undefined || sessionId === agent.id
  }

  /** Track the live Agent object so the read-only status can resolve its owner. */
  private remember(agent: CodexContextAgent): void {
    this.agentsBySession.set(agent.id, agent)
  }

  /**
   * Adopt the Agent instance reported by a Host event. A different object for
   * the same session id is a new instance (resume after dispose), so the old
   * instance's state is dropped and its late completion cannot land.
   */
  private adopt(agent: CodexContextAgent): void {
    const current = this.agentsBySession.get(agent.id)
    if (current === undefined || current === agent) {
      this.remember(agent)
      return
    }
    this.abandon(agent.id)
    this.remember(agent)
  }

  /** Start one idle task and track it so unload can abort and await it. */
  private startIdle(agent: CodexContextAgent): void {
    if (this.disposed) return
    const entry = this.queuedBySession.get(agent.id)
    if (entry === undefined) return
    if ((this.generation.get(agent.id) ?? 0) !== entry.generation) {
      this.queuedBySession.delete(agent.id)
      return
    }
    // Move before any await so one idle boundary cannot re-enter.
    this.queuedBySession.delete(agent.id)
    this.runningBySession.set(agent.id, entry)
    const task = this.runIdle(entry)
    this.inflight.add(task)
    this.runningTask.set(agent.id, task)
    void task.finally(() => {
      this.inflight.delete(task)
      if (this.runningTask.get(agent.id) === task) this.runningTask.delete(agent.id)
      if (this.runningBySession.get(agent.id) === entry) {
        this.runningBySession.delete(agent.id)
      }
    })
  }

  /** Drop every per-session observation for an Agent that no longer exists. */
  private abandon(sessionId: string): void {
    this.queuedBySession.get(sessionId)?.controller.abort()
    this.queuedBySession.delete(sessionId)
    this.runningBySession.get(sessionId)?.controller.abort()
    this.runningBySession.delete(sessionId)
    this.runningTask.delete(sessionId)
    this.outcomes.delete(sessionId)
    this.finishedAt.delete(sessionId)
    this.agentsBySession.delete(sessionId)
    // A disposed instance's unsettled requests can never complete: drop those
    // facts so a resumed Agent for the same session id cannot read them as
    // running. Terminal facts stay (already proven and closed).
    this.dropUnsettledRequests(sessionId)
    this.generation.set(sessionId, (this.generation.get(sessionId) ?? 0) + 1)
  }

  /** Drop queued/running request facts of one session; terminal facts stay. */
  private dropUnsettledRequests(sessionId: string): void {
    const facts = this.requestFacts.get(sessionId)
    if (facts === undefined) return
    for (const [requestId, fact] of facts) {
      if (fact.phase === 'queued' || fact.phase === 'running') facts.delete(requestId)
    }
    if (facts.size === 0) this.requestFacts.delete(sessionId)
  }

  private finish(
    agent: CodexContextAgent,
    entry: AcceptedEntry,
    outcome: CompactionOutcome,
    reason?: string,
    compactionId?: string,
    dropCaptured = false,
  ): void {
    // A stale instance (disposed/re-resumed under the same session id) or a
    // stale entry must never overwrite the current owner's state.
    if ((this.generation.get(agent.id) ?? 0) !== entry.generation) return
    if (this.agentsBySession.get(agent.id) !== agent) return
    this.outcomes.set(agent.id, outcome)
    this.finishedAt.set(agent.id, outcome.at)
    // Only an unverifiable successful result drops the captured identity. A
    // thrown/failed own call keeps it, so the same-id core failed fact can prove
    // the terminal; that is a factual link, never a success claim.
    if (dropCaptured) this.dropRequestCompactionId(agent.id, outcome.requestId)
    // Terminal request fact. Fixed vocabulary only; the raw failure text never
    // crosses this boundary.
    this.patchRequest(agent.id, outcome.requestId, {
      phase: requestPhaseOf(outcome.state),
      endedAt: outcome.at,
      ...(diagnosticsReason(outcome) === undefined ? {} : { reason: diagnosticsReason(outcome) }),
      ...(requestCode(reason) === undefined ? {} : { code: requestCode(reason) }),
      ...(compactionId === undefined ? {} : { compactionId }),
    })
    this.emit(agent.id, {
      requestId: outcome.requestId,
      phase: outcome.state,
      at: outcome.at,
      ...(reason === undefined ? {} : { reason }),
      ...(compactionId === undefined ? {} : { compactionId }),
    })
  }

  private emit(sessionId: string, change: CompactionRequestChange): void {
    const notify = this.options.onRequestChange
    if (notify === undefined) return
    try {
      notify(sessionId, change)
    } catch {
      // A diagnostics sink must never break the request queue.
    }
  }

  /** Decide the accepted turn's fate from the observed event feed only. */
  private sourceTurnState(entry: AcceptedEntry): 'completed' | 'cancelled' | 'unknown' {
    if (entry.observedTurnEnd === undefined) return 'unknown'
    return entry.observedTurnEnd === 'completed' ? 'completed' : 'cancelled'
  }

  private async runIdle(entry: AcceptedEntry): Promise<void> {
    const agent = entry.agent
    const requestId = entry.ticket.requestId
    try {
      // The request belongs to the turn it was accepted in. A cancelled or
      // unverifiable source turn must not run compaction at the later idle.
      const sourceTurn = this.sourceTurnState(entry)
      if (sourceTurn !== 'completed') {
        const at = this.now()
        if (sourceTurn === 'cancelled') {
          this.finish(agent, entry, { state: 'cancelled', requestId, at }, 'cancelled')
        } else {
          this.finish(agent, entry, { state: 'refused', requestId, at, reason: 'unknown' }, 'unknown')
        }
        return
      }
      const owner = this.owner(agent)
      const service = this.options.resolveCompaction(agent)
      if (owner.state !== 'available' || service === undefined) {
        this.finish(agent, entry, { state: 'refused', requestId, at: this.now() }, owner.state)
        return
      }
      this.emit(agent.id, { requestId, phase: 'started', at: this.now() })
      this.patchRequest(agent.id, requestId, {
        phase: 'running',
        startedAt: this.now(),
        ...(entry.ticket.requestedAt === undefined ? {} : { queuedAt: entry.ticket.requestedAt }),
      })
      // Capture window: only a core start committed inside this call may bind.
      entry.capture = { active: true }
      let result: unknown
      try {
        result = await service.compactNow(agent, entry.controller.signal)
      } finally {
        entry.capture = { active: false, ...(entry.capture?.compactionId === undefined ? {} : { compactionId: entry.capture.compactionId }) }
      }
      const captured = entry.capture.compactionId
      const returned = result === null || result === undefined ? undefined : resultCompactionId(result)
      // The returned identity must agree with the one captured in this window;
      // otherwise an unverifiable success drops the association (unknown).
      const compactionId = returned !== undefined && returned === captured ? returned : undefined
      const mismatch = captured !== undefined && returned !== captured
      const at = this.now()
      if (entry.controller.signal.aborted) {
        this.finish(agent, entry, { state: 'cancelled', requestId, at }, 'cancelled')
        return
      }
      if (result === null) {
        // Nothing was compacted; a captured start would be contradictory, so
        // that association is dropped rather than carried as a success.
        this.finish(agent, entry, { state: 'noop', requestId, at }, 'no-op', undefined, mismatch)
        return
      }
      this.finish(
        agent,
        entry,
        { state: 'completed', requestId, at },
        undefined,
        compactionId,
        mismatch,
      )
    } catch (error) {
      const at = this.now()
      const reason = failureReason(error)
      if (entry.controller.signal.aborted || reason === 'cancelled') {
        this.finish(agent, entry, { state: 'cancelled', requestId, at }, 'cancelled')
        return
      }
      if (reason === 'busy') {
        this.finish(agent, entry, { state: 'skipped-busy', requestId, at, reason }, reason)
        return
      }
      this.finish(agent, entry, { state: 'failed', requestId, at, reason }, reason)
    }
  }
}
