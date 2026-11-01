/**
 * Dedicated Tool view for the `codex_context` call.
 *
 * Only `request_compaction` renders a compaction-request card. `status` and
 * `recall` keep their own useful result text and never masquerade as a
 * compaction ticket. A request card joins the exact `requestId` from this
 * call's own result against the authorized diagnostics snapshot; absent or
 * unreadable metadata stays accepted/unknown, never "completed".
 */

import { useEffect, useState } from 'react'
import type {
  CompactionDiagnosticsSnapshot,
  CompactionRequestStatus,
} from '../compaction-types.ts'
import {
  COMPACTION_PROJECTION_KEY,
  compactionReasonLabel,
  type CompactionDiagnosticsReader,
} from './CompactionStatus.tsx'

type Translate = (key: string, params?: Record<string, unknown>) => string

interface TextBlock {
  type?: unknown
  text?: unknown
}

interface CodexContextBlock {
  argsRaw?: string
  call?: { argsRaw?: string } | null
  content?: readonly unknown[]
  isError?: boolean
}

interface CodexContextToolViewProps {
  phase: 'preparing' | 'start' | 'result'
  callId: string
  block: CodexContextBlock
  sessionId: string
  t: Translate
  diagnostics: CompactionDiagnosticsReader
  useProjection?: (key: string) => unknown
  useSession?: (selector: (snapshot: {
    running: boolean
    pendingSubmissions: readonly unknown[]
    awaitingFirstTurn: boolean
  }) => unknown) => unknown
}

function requestOf(
  snapshot: CompactionDiagnosticsSnapshot | null | undefined,
  requestId: string | undefined
): CompactionRequestStatus | undefined {
  if (snapshot === null || snapshot === undefined || requestId === undefined) return undefined
  return snapshot.requests?.find(request => request.requestId === requestId)
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function parseJson(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  try {
    return recordOf(JSON.parse(value))
  } catch {
    return undefined
  }
}

function actionOf(block: CodexContextBlock): string | undefined {
  const action = parseJson(block.argsRaw ?? block.call?.argsRaw)?.['action']
  return typeof action === 'string' ? action : undefined
}

function outputOf(block: CodexContextBlock): Record<string, unknown> | undefined {
  for (const item of block.content ?? []) {
    const blockValue = recordOf(item)
    if (blockValue?.['type'] === 'text' && typeof blockValue['text'] === 'string') {
      const parsed = parseJson(blockValue['text'])
      if (parsed !== undefined) return parsed
    }
  }
  return undefined
}

function requestIdOf(output: Record<string, unknown> | undefined): string | undefined {
  const queued = recordOf(output?.['queued'])
  return typeof queued?.['requestId'] === 'string' ? queued.requestId : undefined
}

function requestState(status: CompactionRequestStatus): CompactionRequestStatus['phase'] {
  return status.phase
}

const OWNER_LABELS: Record<string, string> = {
  available: 'compactionOwnerAvailable',
  'declared-takeover': 'compactionOwnerDeclaredTakeover',
  conflict: 'compactionOwnerConflict',
  unavailable: 'compactionOwnerUnavailable',
  unknown: 'compactionOwnerUnknown',
}

const OUTCOME_LABELS: Record<string, string> = {
  completed: 'compactionOutcome_completed',
  'skipped-busy': 'compactionOutcome_skipped-busy',
  cancelled: 'compactionOutcome_cancelled',
  failed: 'compactionOutcome_failed',
  refused: 'compactionOutcome_refused',
}

const QUEUE_LABELS: Record<string, string> = {
  queued: 'codexContextStateQueued',
  running: 'codexContextStateRunning',
  idle: 'codexContextQueueEmpty',
  none: 'codexContextQueueEmpty',
  unknown: 'codexContextStateUnknown',
}

const REJECT_LABELS: Record<string, string> = {
  owner: 'codexContextRejectOwner',
  provider: 'codexContextRejectProvider',
  disposed: 'codexContextRejectDisposed',
  identity: 'codexContextRejectIdentity',
  'source-turn': 'codexContextRejectSourceTurn',
  'history-unavailable': 'codexContextRejectHistoryUnavailable',
  cooldown: 'codexContextRejectCooldown',
  'no-agent': 'codexContextRejectNoAgent',
  'no-session': 'codexContextRejectNoSession',
}

function fixedLabel(
  t: Translate,
  labels: Record<string, string>,
  value: unknown,
  fallback = 'codexContextStateUnknown'
): string {
  return typeof value === 'string' && labels[value] !== undefined
    ? t(labels[value]!)
    : t(fallback)
}

function rejectLabel(t: Translate, value: unknown): string {
  return fixedLabel(t, REJECT_LABELS, value, 'codexContextReasonUnknown')
}

function rejectRows(t: Translate, output: Record<string, unknown>): { label: string; value: string }[] {
  return [{ label: t('codexContextReason'), value: rejectLabel(t, output['reason']) }]
}

function row(label: string, value: string) {
  return (
    <div key={`${label}:${value}`} style={{ display: 'flex', gap: 8, font: 'inherit' }}>
      <span style={{ color: 'var(--dsw-alias-label-caption)' }}>{label}</span>
      <span style={{ color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  )
}

function card(title: string, rows: readonly { label: string; value: string }[]) {
  return (
    <div
      role="status"
      aria-label={title}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '4px 0',
        font: 'inherit',
        fontSize: '0.875em',
        color: 'var(--dsw-alias-label-secondary)',
      }}
    >
      <strong style={{ font: 'inherit', fontWeight: 500 }}>{title}</strong>
      {rows.map(item => row(item.label, item.value))}
    </div>
  )
}

function detailCard(title: string, rows: readonly { label: string; value: string }[]) {
  return (
    <div
      role="status"
      aria-label={title}
      style={{ display: 'flex', flexDirection: 'column', gap: 2, font: 'inherit' }}
    >
      <details style={{ font: 'inherit', color: 'var(--dsw-alias-label-secondary)' }}>
        <summary style={{ cursor: 'pointer', font: 'inherit' }}>{title}</summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 2 }}>
          {rows.map(item => row(item.label, item.value))}
        </div>
      </details>
    </div>
  )
}

function requestCard(
  t: Translate,
  output: Record<string, unknown>,
  status: CompactionRequestStatus | undefined,
  nativeSelected: boolean
): ReturnType<typeof card> {
  if (output['ok'] === false) {
    return card(t('codexContextRequestRejected'), rejectRows(t, output))
  }
  if (status === undefined) {
    return card(t('codexContextRequestAccepted'), [
      { label: t('codexContextState'), value: t('codexContextStateUnknown') },
    ])
  }
  const state = requestState(status)
  if (state === 'completed') {
    if (status.result === undefined) {
      return card(t('codexContextRequestAccepted'), [
        { label: t('codexContextState'), value: t('codexContextStateUnknown') },
      ])
    }
    return card(t('codexContextRequestCompleted'), [
      {
        label: t('codexContextState'),
        value: status.result === 'native'
          ? t('codexContextCompletedNative')
          : t('codexContextCompletedOrdinary'),
      },
      { label: t('codexContextDetailsInHistory'), value: t('codexContextDetailsInHistoryValue') },
    ])
  }
  if (state === 'failed' || state === 'cancelled') {
    const cancelled = state === 'cancelled'
    return card(cancelled ? t('codexContextRequestCancelled') : t('codexContextRequestFailed'), [
      ...(status.reason === undefined
        ? []
        : [{ label: t('codexContextReason'), value: compactionReasonLabel(t, status.reason) }]),
    ])
  }
  if (state === 'noop' || state === 'skipped-busy' || state === 'refused') {
    const key = state === 'noop'
      ? 'codexContextRequestNoop'
      : state === 'skipped-busy'
        ? 'codexContextRequestBusy'
        : 'codexContextRequestRefused'
    return card(t(key), [
      ...(status.reason === undefined
        ? []
        : [{ label: t('codexContextReason'), value: compactionReasonLabel(t, status.reason) }]),
    ])
  }
  if (state === 'queued') {
    return card(t('codexContextRequestQueuedNotice'), [
      { label: t('codexContextState'), value: t('codexContextStateQueued') },
    ])
  }
  if (state === 'running') {
    return card(
      nativeSelected ? t('codexContextRequestRunningRemote') : t('codexContextRequestRunningGeneric'),
      [{ label: t('codexContextState'), value: t('codexContextStateRunning') }]
    )
  }
  return card(t('codexContextRequestAccepted'), [
    { label: t('codexContextState'), value: t('codexContextStateUnknown') },
  ])
}

function statusResult(t: Translate, output: Record<string, unknown>): ReturnType<typeof card> {
  if (output['ok'] === false) {
    return detailCard(t('codexContextStatusFailed'), rejectRows(t, output))
  }
  const owner = recordOf(output['owner'])
  const queued = recordOf(output['queued'])
  const outcome = recordOf(output['last_outcome'])
  const rows: { label: string; value: string }[] = []
  rows.push({
    label: t('codexContextOwner'),
    value: fixedLabel(t, OWNER_LABELS, owner?.['state']),
  })
  rows.push({
    label: t('codexContextQueue'),
    value: queued === undefined
      ? t('codexContextQueueEmpty')
      : fixedLabel(t, QUEUE_LABELS, queued['status'], 'codexContextStateUnknown'),
  })
  if (outcome !== undefined) {
    rows.push({
      label: t('codexContextLastOutcome'),
      value: fixedLabel(t, OUTCOME_LABELS, outcome['state'], 'codexContextStateUnknown'),
    })
  }
  return detailCard(t('codexContextStatusTitle'), rows)
}

function recallResult(t: Translate, output: Record<string, unknown>): ReturnType<typeof card> {
  if (output['ok'] === false) {
    return detailCard(t('codexContextRecallFailed'), rejectRows(t, output))
  }
  const recall = recordOf(output['recall'])
  const items = Array.isArray(recall?.['items']) ? recall.items : []
  const rows = [
    {
      label: t('codexContextRecallRange'),
      value: `${String(recall?.['fromSeq'] ?? '?')}–${String(recall?.['toSeqExclusive'] ?? '?')}`,
    },
    { label: t('codexContextRecallItems'), value: String(items.length) },
    {
      label: t('codexContextRecallTruncated'),
      value: recall?.['truncated'] === true ? t('codexContextYes') : t('codexContextNo'),
    },
  ]
  for (const item of items.slice(0, 3)) {
    const value = recordOf(item)
    if (value !== undefined && typeof value['text'] === 'string') {
      rows.push({ label: `#${String(value['seq'] ?? '?')}`, value: value['text'].slice(0, 200) })
    }
  }
  return detailCard(t('codexContextRecallTitle'), rows)
}

interface ScopedSnapshot {
  sessionId: string
  requestId: string
  value: CompactionDiagnosticsSnapshot | null
}

/**
 * Render one `codex_context` call by phase and its own action.
 * @param props - tool phase/block plus authorized diagnostics and session signals.
 * @returns the tool row; ordinary status/recall results stay their own cards.
 */
export function CodexContextToolView(props: CodexContextToolViewProps) {
  const action = actionOf(props.block)
  const output = outputOf(props.block)
  const requestId = action === 'request_compaction' ? requestIdOf(output) : undefined
  const [snapshotState, setSnapshotState] = useState<ScopedSnapshot | undefined>(undefined)
  const projection = props.useProjection?.(COMPACTION_PROJECTION_KEY) as
    | { activitySeq?: number }
    | undefined
  const sessionActivity = props.useSession?.(snapshotValue =>
    `${String(snapshotValue.running)}:${String(snapshotValue.pendingSubmissions.length)}`
  ) as string | undefined

  useEffect(() => {
    if (requestId === undefined) return
    const controller = new AbortController()
    const scope = { sessionId: props.sessionId, requestId }
    void props.diagnostics.read(props.sessionId, controller.signal).then(
      value => {
        if (!controller.signal.aborted) setSnapshotState({ ...scope, value })
      },
      () => {
        if (!controller.signal.aborted) setSnapshotState({ ...scope, value: null })
      }
    )
    return () => controller.abort()
  }, [props.diagnostics, props.sessionId, requestId, projection?.activitySeq, sessionActivity])

  const snapshot = snapshotState !== undefined &&
    snapshotState.sessionId === props.sessionId &&
    snapshotState.requestId === requestId
    ? snapshotState.value
    : undefined

  if (props.phase === 'preparing') {
    return card(props.t('codexContextPreparing'), [])
  }
  if (props.phase === 'start') {
    if (action === 'request_compaction') return card(props.t('codexContextRequestStarting'), [])
    if (action === 'status') return card(props.t('codexContextStatusLoading'), [])
    if (action === 'recall') return card(props.t('codexContextRecallLoading'), [])
    return card(props.t('codexContextPreparing'), [])
  }
  if (props.block.isError === true) {
    return card(props.t('codexContextToolFailed'), [])
  }
  if (output === undefined) {
    return card(props.t('codexContextNoResult'), [])
  }
  if (action === 'request_compaction') {
    const status = requestOf(snapshot, requestId)
    const nativeSelected = status?.compactionId !== undefined &&
      snapshot?.records.some(record => (
        record.compactionId === status.compactionId && record.decision === 'selected-native'
      )) === true
    return requestCard(props.t, output, status, nativeSelected)
  }
  if (action === 'status') return statusResult(props.t, output)
  if (action === 'recall') return recallResult(props.t, output)
  return card(props.t('codexContextPreparing'), [])
}

export { COMPACTION_PROJECTION_KEY }
