/**
 * Client helpers for native-compaction diagnostics.
 *
 * The read-only Remote contribution and localized fact formatting live here;
 * presentation is the Tool view's or the history wrapper's responsibility.
 */

import {
  COMPACTION_PROJECTION_KEY,
  COMPACTION_REMOTE_NAMESPACE,
  COMPACTION_DIAGNOSTICS_VERSION,
  type CompactionDiagnostic,
  type CompactionDiagnosticsSnapshot,
  type CompactionProjectionFact,
  type CompactionProjectionView,
  type CompactionReason,
} from '../compaction-types.ts'

export { COMPACTION_PROJECTION_KEY, COMPACTION_REMOTE_NAMESPACE }

/** Structural Remote result returned by the mounted Gateway namespace. */
export type CompactionRemoteResult =
  | { readonly ok: true; readonly value: CompactionDiagnosticsSnapshot }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message?: string } }

/** Structural Remote face supplied by the mounted read-only contribution. */
export interface CompactionRemote {
  read(
    request: { sessionId: string },
    signal?: AbortSignal
  ): Promise<CompactionRemoteResult>
}

/** Read-only diagnostics source shared by the Tool view and history rows. */
export interface CompactionDiagnosticsReader {
  read(sessionId: string, signal?: AbortSignal): Promise<CompactionDiagnosticsSnapshot>
}

type Translate = (key: string, params?: Record<string, unknown>) => string

const REASON_KEYS: Record<CompactionReason, string> = {
  'native-disabled': 'compactionReasonNativeDisabled',
  'no-estimator': 'compactionReasonNoEstimator',
  'no-source-budget': 'compactionReasonNoSourceBudget',
  'native-request-failed': 'compactionReasonNativeRequestFailed',
  'invalid-response': 'compactionReasonInvalidResponse',
  'not-smaller': 'compactionReasonNotSmaller',
  'selected-native': 'compactionReasonSelectedNative',
  aborted: 'compactionReasonAborted',
  'summary-failed': 'compactionReasonSummaryFailed',
  busy: 'compactionReasonBusy',
  noop: 'compactionReasonNoop',
}

function timeLabel(at: number): string {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '—' : `${date.toISOString().slice(11, 19)} UTC`
}

/**
 * Human-readable fixed reason; unknown inputs stay generic.
 * @param t - plugin translator.
 * @param reason - sanitized reason code.
 * @returns localized reason.
 */
export function compactionReasonLabel(t: Translate, reason: CompactionReason | undefined): string {
  return reason === undefined ? t('compactionReasonUnknown') : t(REASON_KEYS[reason])
}

/**
 * Format one local estimate without mixing it into provider usage.
 * @param t - plugin translator.
 * @param estimate - local estimate.
 * @returns bounded detail line.
 */
export function compactionEstimateLine(
  t: Translate,
  estimate: CompactionDiagnostic['sourceEstimate'] | CompactionDiagnostic['markerEstimate']
): string | undefined {
  if (estimate === undefined) return undefined
  return `${String(estimate.tokens)} ${t('compactionTokens')} · ${timeLabel(estimate.at)}`
}

/**
 * Format provider usage separately from local estimates.
 * @param t - plugin translator.
 * @param usage - provider-reported usage.
 * @returns bounded detail line.
 */
export function compactionUsageLine(
  t: Translate,
  usage: CompactionDiagnostic['nativeUsage']
): string | undefined {
  if (usage === undefined) return undefined
  const parts = [
    usage.inputTokens === undefined ? null : `${t('compactionUsageInput')} ${String(usage.inputTokens)}`,
    usage.outputTokens === undefined ? null : `${t('compactionUsageOutput')} ${String(usage.outputTokens)}`,
    usage.cacheReadTokens === undefined ? null : `${t('compactionUsageCacheRead')} ${String(usage.cacheReadTokens)}`,
    usage.cacheWriteTokens === undefined ? null : `${t('compactionUsageCacheWrite')} ${String(usage.cacheWriteTokens)}`,
    usage.totalTokens === undefined ? null : `${t('compactionUsageTotal')} ${String(usage.totalTokens)}`,
  ].filter((part): part is string => part !== null)
  return `${parts.length === 0 ? '—' : parts.join(' · ')} · ${timeLabel(usage.at)}`
}

/**
 * Pick the diagnostic fact for one Chat checkpoint by real event seq only.
 * @param snapshot - Host diagnostics response.
 * @param checkpointSeq - replacement checkpoint sequence.
 * @param summarySeq - compaction summary sequence.
 * @returns matching fact, if any.
 */
export function compactionFactFor(
  snapshot: CompactionDiagnosticsSnapshot | undefined,
  checkpointSeq: number | null,
  summarySeq: number | null
): CompactionProjectionFact | undefined {
  if (snapshot === undefined) return undefined
  return snapshot.facts.find(fact => (
    (checkpointSeq !== null && fact.checkpointSeq === checkpointSeq) ||
    (summarySeq !== null && fact.summarySeq === summarySeq)
  ))
}

/**
 * Pick a fact from the pure projection when the metadata read is unavailable.
 * @param view - projection value.
 * @param checkpointSeq - replacement checkpoint sequence.
 * @param summarySeq - compaction summary sequence.
 * @returns matching fact, if any.
 */
export function projectionFactFor(
  view: CompactionProjectionView | undefined,
  checkpointSeq: number | null,
  summarySeq: number | null
): CompactionProjectionFact | undefined {
  if (view === undefined) return undefined
  return view.facts.find(fact => (
    (checkpointSeq !== null && fact.checkpointSeq === checkpointSeq) ||
    (summarySeq !== null && fact.summarySeq === summarySeq)
  ))
}

/** Structural descriptor contribution consumed by the public `$mount`. */
export interface CompactionRemoteContribution {
  package: string
  descriptors: readonly Record<string, unknown>[]
}

function parseReadRequest(value: unknown): { sessionId: string } {
  const request = value as { sessionId?: unknown } | undefined
  if (request === undefined || typeof request.sessionId !== 'string' || request.sessionId.length === 0) {
    throw new Error('codexCompaction.read requires a sessionId')
  }
  return { sessionId: request.sessionId }
}

function parseSnapshot(value: unknown): CompactionDiagnosticsSnapshot {
  const snapshot = value as Partial<CompactionDiagnosticsSnapshot> | undefined
  if (snapshot === undefined || snapshot.v !== COMPACTION_DIAGNOSTICS_VERSION) {
    throw new Error('codexCompaction.read returned an unsupported snapshot')
  }
  if (!Array.isArray(snapshot.facts) || !Array.isArray(snapshot.records)) {
    throw new Error('codexCompaction.read returned malformed facts or records')
  }
  if (snapshot.session === undefined || !Array.isArray(snapshot.session.owner.evidence)) {
    throw new Error('codexCompaction.read returned malformed session status')
  }
  return snapshot as CompactionDiagnosticsSnapshot
}

/**
 * Build the read-only Remote contribution mounted by the client half.
 *
 * The descriptor carries no Host implementation and no session capability;
 * authorization is the Gateway/profile + `sessionQuery.observeSession` path.
 * @returns contribution handed to `ctx.remote.$mount`.
 */
export function createCompactionRemoteContribution(): CompactionRemoteContribution {
  return {
    package: 'dsh-codex-client',
    descriptors: [{
      id: 'dsh-codex-client#codexCompaction/read',
      service: 'compactionDiagnostics',
      namespace: COMPACTION_REMOTE_NAMESPACE,
      method: 'read',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        wire: 'request',
        source: 'json',
        codec: {
          mode: 'strict',
          typeSymbol: 'dsh-codex#CompactionReadRequest',
          create: () => ({ parse: parseReadRequest }),
        },
      }],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-codex#CompactionDiagnosticsSnapshot',
        create: () => ({ parse: parseSnapshot }),
      },
    }],
  }
}

/**
 * Resolve the mounted diagnostics namespace lazily, so slot registration never
 * waits for the asynchronous client mount.
 * @param remote - getter for the mounted namespace.
 * @param ready - optional mount completion signal.
 * @returns a reader that fails closed while the namespace is unavailable.
 */
export function createCompactionDiagnosticsReader(
  remote: () => CompactionRemote | undefined,
  ready?: Promise<boolean>
): CompactionDiagnosticsReader {
  return {
    async read(sessionId, signal) {
      if (ready !== undefined && !(await ready)) {
        throw new Error('compaction diagnostics are unavailable')
      }
      const namespace = remote()
      if (namespace === undefined) throw new Error('compaction diagnostics are unavailable')
      const result = await namespace.read({ sessionId }, signal)
      if (!result.ok) throw new Error(result.error.code)
      return result.value
    },
  }
}
