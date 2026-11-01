/** Optional, turn-local compaction notice outside collapsed tool groups. */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CompactionDiagnosticsSnapshot } from '../compaction-types.ts'
import { COMPACTION_PROJECTION_KEY, type CompactionDiagnosticsReader } from './CompactionStatus.tsx'

type Translate = (key: string, params?: Record<string, unknown>) => string
type Dispose = () => void
interface ToolData { readonly root: ToolCallBlock }
interface ToolSource {
  getSnapshot(): readonly ToolData[]
  subscribe(listener: () => void): Dispose
}
interface ChatSnapshot {
  nodes: { turnDataSource(turn: number, kind: 'tool-call'): ToolSource }
}
export interface CompactionTurnNoticeProps {
  sessionId: string
  turn: { turn: number }
  t: Translate
  diagnostics: CompactionDiagnosticsReader
  useChat?: <Value>(selector: (chat: ChatSnapshot) => Value) => Value
  useProjection?: (key: string) => unknown
  useSession?: (selector: (session: { running: boolean; pendingSubmissions: readonly unknown[] }) => string) => string
}
const EMPTY_TOOLS: readonly ToolData[] = []
const EMPTY_SOURCE: ToolSource = {
  getSnapshot: () => EMPTY_TOOLS,
  subscribe: () => () => undefined,
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
function json(text: string): Record<string, unknown> | undefined {
  try { return object(JSON.parse(text)) } catch { return undefined }
}

/** Read only settled request receipts from this turn's assembled root/subcalls. */
export function compactionRequestIds(tools: readonly ToolData[]): readonly string[] {
  const ids = new Set<string>()
  const visit = (block: ToolCallBlock): void => {
    if ('kind' in block && block.kind === 'tool-result' && !block.isError &&
      block.call?.name === 'codex_context' && json(block.call.argsRaw)?.['action'] === 'request_compaction') {
      for (const content of block.content) {
        if (content.type !== 'text') continue
        const result = json(content.text)
        if (result?.['action'] !== 'request_compaction' || result['ok'] !== true) continue
        const id = object(result['queued'])?.['requestId']
        if (typeof id === 'string' && id.length > 0) ids.add(id)
      }
    }
    for (const child of block.subCalls) visit(child)
  }
  for (const tool of tools) visit(tool.root)
  return [...ids]
}

/** Show exactly one temporary notice for real queued/running requests of this turn. */
export function CompactionTurnNotice(props: CompactionTurnNoticeProps) {
  const source = props.useChat?.(chat => chat.nodes.turnDataSource(props.turn.turn, 'tool-call')) ?? EMPTY_SOURCE
  const subscribe = useCallback((listener: () => void) => source.subscribe(listener), [source])
  const getSnapshot = useCallback(() => source.getSnapshot(), [source])
  const tools = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const idsKey = JSON.stringify(compactionRequestIds(tools))
  const scope = JSON.stringify([props.sessionId, props.turn.turn, idsKey])
  const [loaded, setLoaded] = useState<{ scope: string; value: CompactionDiagnosticsSnapshot | null }>()
  const projection = props.useProjection?.(COMPACTION_PROJECTION_KEY) as { activitySeq?: number } | undefined
  const activity = props.useSession?.(session => `${session.running}:${session.pendingSubmissions.length}`)
  useEffect(() => {
    const ids = JSON.parse(idsKey) as string[]
    if (ids.length === 0) return
    const controller = new AbortController()
    void props.diagnostics.read(props.sessionId, controller.signal).then(
      value => { if (!controller.signal.aborted) setLoaded({ scope, value }) },
      () => { if (!controller.signal.aborted) setLoaded({ scope, value: null }) }
    )
    return () => controller.abort()
  }, [props.diagnostics, props.sessionId, scope, idsKey, projection?.activitySeq, activity])
  const snapshot = loaded?.scope === scope ? loaded.value : null
  const ids = JSON.parse(idsKey) as string[]
  const active = snapshot?.requests?.find(request => ids.includes(request.requestId) &&
    (request.phase === 'queued' || request.phase === 'running'))
  if (active === undefined) return null
  const text = props.t(active.phase === 'queued'
    ? 'codexContextRequestQueuedNotice'
    : 'codexContextRequestRunningGeneric')
  return <div role="status" style={{ padding: '4px 0', fontSize: '0.875em', color: 'var(--dsw-alias-label-secondary)' }}>{text}</div>
}

/** Public registry face; runtime owns the slot declaration and component standards. */
export interface CompactionNoticeContext {
  slots: {
    inject(name: string, callback: () => Dispose): Dispose
    register(options: {
      name: string; id: string; order: number
      inject(sessionId: string): { sessionId: string; t: Translate; diagnostics: CompactionDiagnosticsReader }
    }, component: typeof CompactionTurnNotice): Dispose
  }
}

/** Install with member-call receivers and declaration-owned disposal; optional failures fail closed. */
export function installCompactionTurnNotice(
  ctx: CompactionNoticeContext,
  reader: CompactionDiagnosticsReader,
  t: Translate
): Dispose {
  const unavailable = (): Dispose => {
    console.warn('dsh-codex: optional compaction notice unavailable')
    return () => undefined
  }
  try {
    return ctx.slots.inject('conversation.chat.turnTail', () => {
      try {
        return ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'openai-codex-compaction-turn',
          order: 15,
          inject: sessionId => ({ sessionId, t, diagnostics: reader }),
        }, CompactionTurnNotice)
      } catch { return unavailable() }
    })
  } catch { return unavailable() }
}
