/**
 * Shared, client-visible compaction diagnostics contract for the OpenAI Codex
 * plugin. This module is the single source of truth for the projection key,
 * the authorization-safe read namespace, and every shape exchanged between the
 * Host diagnostics, the readonly Remote, and the client UI.
 *
 * Invariants (do not weaken):
 * - A projection fact is folded from committed session events only. It never
 *   reads mutable Domain state and never infers from wall-clock proximity.
 * - Native selection is not success. Success is decided by the core
 *   `compaction/end` event plus a replacement checkpoint that carries the same
 *   real `compactionId`.
 * - Diagnostics metadata carries fixed reason codes and numeric facts only: no
 *   prompt text, no opaque marker payload, no token string, no raw error text.
 * - Local estimates and provider usage stay separate facts, each with its own
 *   source and timestamp.
 *
 * @module dsh-codex/compaction-types
 */

/** Projection unit key; also the client-visible wire key of the same value. */
export const COMPACTION_PROJECTION_KEY = 'openaiCodex.compaction'

/** Readonly Remote wire namespace mounted on the authenticated Gateway. */
export const COMPACTION_REMOTE_NAMESPACE = 'codexCompaction'

/** Wire/schema version of every shape in this module. */
export const COMPACTION_DIAGNOSTICS_VERSION = 1

/**
 * Projection state version; bumped when the fold's internal state shape
 * changes. A persisted row of another version is refolded from the log.
 */
export const COMPACTION_PROJECTION_STATE_VERSION = 2

/**
 * Fixed, sanitized reason codes.
 *
 * The first seven are *selection* decisions reported by the response runtime
 * before any summary exists; `selected-native` means only that the native
 * checkpoint was chosen for publication, never that compaction succeeded.
 * The remaining codes describe request/outcome facts reported by the Agent
 * compaction controller.
 */
export type CompactionReason =
  /** Native compaction is disabled in the effective preferences. */
  | 'native-disabled'
  /** No host token meter is composed, so no local estimate exists. */
  | 'no-estimator'
  /** The estimator produced no usable source budget for this call. */
  | 'no-source-budget'
  /** The native compaction request failed; the ordinary summary is used. */
  | 'native-request-failed'
  /** The native response carried no usable compaction item. */
  | 'invalid-response'
  /** The native checkpoint was not provably smaller than its source. */
  | 'not-smaller'
  /** The native checkpoint was selected for this call (not proof of success). */
  | 'selected-native'
  /** The compaction call was cancelled. */
  | 'aborted'
  /** The summary/commit stage failed. */
  | 'summary-failed'
  /** A request was refused or skipped because compaction was already busy. */
  | 'busy'
  /** A request completed without a needed compaction. */
  | 'noop'

/**
 * Facts about one compaction transaction, folded from `compaction/start`,
 * `compaction/summary`, the replacement checkpoint `user/message`, and
 * `compaction/end`.
 *
 * `status` is derived from those events only:
 * - `open`: started, no `compaction/end` yet.
 * - `native`: ended successfully and the checkpoint carries this plugin's
 *   native marker.
 * - `ordinary`: ended successfully and the checkpoint is an ordinary summary.
 * - `failed`: ended with an error. The real core records `errorChain(error)` as
 *   a plain string, so the projection never classifies cancellation from it.
 * - `cancelled`: the readonly read refined a `failed` fact using a real runtime
 *   record that aborted the same compaction id; never derived from error text.
 */
export interface CompactionProjectionFact {
  /** Real transaction identity minted by the core compaction engine. */
  readonly compactionId: string
  readonly status: 'open' | 'native' | 'ordinary' | 'failed' | 'cancelled'
  /** Seq of `compaction/start`. */
  readonly startSeq: number
  /** Seq of `compaction/summary`, when one was recorded. */
  readonly summarySeq: number | null
  /** Seq of the replacement checkpoint `user/message`, when committed. */
  readonly checkpointSeq: number | null
  /** Seq of `compaction/end`, when the transaction closed. */
  readonly endSeq: number | null
  /** Owning turn, when the transaction was opened inside one. */
  readonly turn: number | null
  /**
   * Fixed reason for a failed end, when the recorded failure is one the core
   * emits in a known strict format (currently only its shrink gate,
   * `not-smaller`). The raw error text is never kept; other failures report no
   * reason rather than a guess.
   */
  readonly failureReason?: CompactionReason | undefined
  /**
   * Facts recorded by `compaction/summary`: provider/model of the summary
   * request, the shadowed region size, and its provider usage. Absent until a
   * summary event was committed; this is the ordinary-summary usage group and
   * is never merged with the native request group.
   */
  readonly summary?: CompactionSummaryFacts | undefined
}

/** Client-visible projection value (also the projection wire view). */
export interface CompactionProjectionView {
  readonly v: typeof COMPACTION_DIAGNOSTICS_VERSION
  readonly facts: readonly CompactionProjectionFact[]
  /**
   * Seq of the latest event that changed a status-relevant signal for this
   * session (compaction events, or one of this plugin's own `codex_context`
   * tool call/result pairs). The Chat surface can reuse a node for a tool
   * result, so clients must refresh on this value rather than on history
   * shape changes. Purely event-derived; it carries no tool text.
   */
  readonly activitySeq: number
}

/** Pure projection state folded over committed session events. */
export interface CompactionProjectionState {
  readonly v: typeof COMPACTION_DIAGNOSTICS_VERSION
  readonly facts: readonly CompactionProjectionFact[]
  /** See {@link CompactionProjectionView.activitySeq}. */
  readonly activitySeq: number
}

/** One local token estimate, produced by the host token meter. */
export interface CompactionLocalEstimate {
  readonly tokens: number
  /** Which text the estimate covers. */
  readonly source: 'source-text' | 'marker'
  readonly estimator: 'host-token-meter'
  readonly at: number
}

/**
 * One provider-reported usage group, never a local estimate.
 *
 * `inputTokens` carries the provider's non-cached input count and the cache
 * columns stay separate, matching the Harness pi-ai `Usage` shape. These are
 * request usage numbers, never a post-compaction context size.
 */
export interface CompactionProviderUsage {
  readonly inputTokens?: number | undefined
  readonly outputTokens?: number | undefined
  readonly cacheReadTokens?: number | undefined
  readonly cacheWriteTokens?: number | undefined
  readonly totalTokens?: number | undefined
  /** Which request produced the numbers; the two groups are never merged. */
  readonly source: 'native-request' | 'summary-request'
  readonly at: number
}

/** Facts recorded by the core summarizer for one compaction transaction. */
export interface CompactionSummaryFacts {
  /** Provider resolved for the summary request. */
  readonly provider: string
  /** Model id used for the summary request. */
  readonly model: string
  /** Core-estimated tokens of the shadowed surface region. */
  readonly shadowedTokenCount: number
  /** Number of shadowed surface nodes replaced by the checkpoint. */
  readonly shadowedSeqCount: number
  /** Provider usage of the summary request, when the core recorded it. */
  readonly usage?: CompactionProviderUsage | undefined
}

/** Sanitized diagnostics for one native-compaction attempt (no text, no tokens). */
export interface CompactionDiagnostic {
  /** Real compaction identity, or `null` when it could not be linked. */
  readonly compactionId: string | null
  readonly at: number
  /** The single sanitized decision this attempt produced. */
  readonly decision: CompactionReason
  /** Source-text estimate used as the conservative budget, when available. */
  readonly sourceEstimate?: CompactionLocalEstimate | undefined
  /** Marker-size estimate of the native checkpoint, when computed. */
  readonly markerEstimate?: CompactionLocalEstimate | undefined
  /** Native request usage reported by the provider, when available. */
  readonly nativeUsage?: CompactionProviderUsage | undefined
  /** Real controller request identity, when this record could be linked to one. */
  readonly requestId?: string | undefined
  /** Real acceptance time of that request; never restored from `at`. */
  readonly queuedAt?: number | undefined
}

/**
 * Read-only status of one session's compaction request path, merged from the
 * Agent compaction controller. Nothing is inferred from wall-clock proximity or
 * from installation alone: an absent port keeps `state` and `owner.state`
 * `unknown` instead of collapsing distinct causes into one value.
 */
export interface CompactionSessionStatus {
  /** Current request phase, or the last terminal phase when idle. */
  readonly state:
    | 'idle'
    | 'pending'
    | 'running'
    | 'completed'
    | 'cancelled'
    | 'skipped-busy'
    | 'noop'
    | 'failed'
    | 'unknown'
  /** Factual ownership verdict, with bounded evidence for the UI. */
  readonly owner: CompactionOwnerStatus
  readonly at: number
  /** Selection reason, only when the controller reports one from this vocabulary. */
  readonly reason?: CompactionReason | undefined
  /** Controller request identity, when one exists. */
  readonly requestId?: string | undefined
  /** Most recent terminal outcome of an accepted request. */
  readonly lastOutcome?: CompactionOutcomeStatus | undefined
}

/**
 * Factual ownership verdict reused from the Agent compaction controller's four
 * states plus `unknown`: what was observed, never an inference from the mere
 * presence of a compaction service.
 */
export interface CompactionOwnerStatus {
  readonly state: 'available' | 'declared-takeover' | 'conflict' | 'unavailable' | 'unknown'
  /** Short, bounded observations backing the verdict (`[]` when unknown). */
  readonly evidence: readonly string[]
  /** Owning provider, when the evidence names one. */
  readonly provider?: string | undefined
}

/** Terminal outcome of one accepted compaction request (no raw error text). */
export interface CompactionOutcomeStatus {
  readonly state: 'completed' | 'skipped-busy' | 'cancelled' | 'failed' | 'refused'
  readonly at: number
  readonly requestId: string
  /** Controller's fixed failure class, never the error message. */
  readonly code?: string | undefined
}

/** Phase vocabulary of one compaction request; never by itself proof of success. */
export type CompactionRequestState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'skipped-busy'
  | 'refused'
  | 'noop'
  | 'unknown'

/**
 * Controller-owned phase facts for one accepted request. It never claims a
 * successful compaction: `compactionId` exists only when the controller captured
 * the exact core `compaction/start` inside this request's own `compactNow` call
 * window and the returned result agreed with it.
 */
export interface CompactionRequestFact {
  readonly requestId: string
  readonly phase: CompactionRequestState
  /** Real acceptance time; omitted when unknown (never restored from `at`). */
  readonly queuedAt?: number | undefined
  readonly startedAt?: number | undefined
  readonly endedAt?: number | undefined
  readonly compactionId?: string | undefined
  /** Fixed reason code from this plugin's vocabulary. */
  readonly reason?: CompactionReason | undefined
  /** Controller's fixed failure class; never a raw error message/name/code. */
  readonly code?: string | undefined
}

/**
 * Read-only status of one request as returned by the readonly Remote. Terminal
 * facts are proven against the same-compactionId core facts, never against
 * `lastOutcome` or wall-clock proximity.
 */
export interface CompactionRequestStatus extends CompactionRequestFact {
  /** Present only when a same-compactionId fact proves the replacement. */
  readonly result?: 'native' | 'ordinary' | undefined
  readonly checkpointSeq?: number | undefined
  readonly summarySeq?: number | undefined
}

/** Arguments of the readonly Remote `read` method. */
export interface CompactionReadRequest {
  readonly sessionId: string
}

/** Readonly Remote response for one session. */
export interface CompactionDiagnosticsSnapshot {
  readonly v: typeof COMPACTION_DIAGNOSTICS_VERSION
  /**
   * Whether diagnostics metadata for this session survives a restart. `false`
   * means the plugin's storage domain is not composed: the projection facts
   * below are still authoritative, the attempt records may be empty.
   */
  readonly persistent: boolean
  /** Pure projection facts, folded from committed events. */
  readonly facts: readonly CompactionProjectionFact[]
  /** Attempt diagnostics joined by `compactionId`; `null` ids are unlinked. */
  readonly records: readonly CompactionDiagnostic[]
  /** Controller status, `unknown` when no controller is composed. */
  readonly session: CompactionSessionStatus
  /**
   * Bounded per-request status for this session, joined to the facts above by a
   * real `compactionId`. Absent when no request facts exist (old plugin build or
   * a restarted session): clients then show `unknown`, never a guessed match.
   */
  readonly requests?: readonly CompactionRequestStatus[] | undefined
}

/**
 * One sanitized decision reported by the response runtime for a compaction
 * call, before any summary exists. The receiver links it to a real
 * `compactionId`; the runtime never guesses one.
 */
export interface CompactionDecision {
  /** Session whose compaction stream produced the decision. */
  readonly sessionId?: string | undefined
  /**
   * Real compaction id when the reporter holds one (the Agent controller does);
   * otherwise the diagnostics receiver resolves it from the open projection
   * fact. Never guessed from timing or a summary hash.
   */
  readonly compactionId?: string | undefined
  /** The fixed selection reason; `selected-native` is not proof of success. */
  readonly reason: CompactionReason
  readonly at: number
  /** Conservative source budget used for this call, when one existed. */
  readonly sourceEstimate?: CompactionLocalEstimate | undefined
  /** Marker-size estimate of the native checkpoint, when one was computed. */
  readonly markerEstimate?: CompactionLocalEstimate | undefined
  /** Provider usage of the native compaction request, when it completed. */
  readonly nativeUsage?: CompactionProviderUsage | undefined
}
