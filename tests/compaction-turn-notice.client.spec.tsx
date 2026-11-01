// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallBlock, ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CompactionDiagnosticsSnapshot } from '../src/compaction-types.ts'
import { CompactionTurnNotice, compactionRequestIds, type CompactionTurnNoticeProps } from '../src/client/CompactionTurnNotice.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const queued = '压缩已排队，将在会话空闲后开始'
const running = '正在压缩上下文，后续消息将排队等待'
const t = (key: string) => (zh as Record<string, string>)[key] ?? key

function result(id: string, overrides: Partial<ToolResultNode> = {}): ToolResultNode {
  return {
    kind: 'tool-result', seq: 12, time: 100, callId: `call-${id}`, callTime: 90,
    call: { name: 'codex_context', argsRaw: '{"action":"request_compaction"}' },
    content: [{ type: 'text', text: JSON.stringify({ action: 'request_compaction', ok: true, queued: { requestId: id } }) }],
    isError: false, subCalls: [], ...overrides,
  }
}
function snapshot(requests: readonly Record<string, unknown>[]): CompactionDiagnosticsSnapshot {
  return {
    v: 1, persistent: true, facts: [], records: [], requests,
    session: { state: 'unknown', owner: { state: 'unknown', evidence: [] }, at: 1 },
  } as unknown as CompactionDiagnosticsSnapshot
}
class Source {
  value: readonly { root: ToolCallBlock }[] = []
  listeners = new Set<() => void>()
  getSnapshot() { return this.value }
  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  set(value: readonly { root: ToolCallBlock }[]) {
    this.value = value
    for (const listener of this.listeners) listener()
  }
}
function props(source: Source, read = vi.fn(async () => snapshot([]))): CompactionTurnNoticeProps {
  return {
    turn: { turn: 7 }, sessionId: 'session-a', t, diagnostics: { read },
    useChat: selector => selector({ nodes: {
      turnDataSource(turn, kind) {
        expect(turn).toBe(7)
        expect(kind).toBe('tool-call')
        return source
      },
    } }),
  }
}

describe('CompactionTurnNotice per-turn public source', () => {
  it('makes no RPC for an empty turn, then subscribes to its tool result publication', async () => {
    const source = new Source()
    const read = vi.fn(async () => snapshot([{ requestId: 'r1', phase: 'queued' }]))
    const view = render(<CompactionTurnNotice {...props(source, read)} />)
    expect(read).not.toHaveBeenCalled()
    expect(view.container.childElementCount).toBe(0)

    act(() => source.set([{ root: result('r1') }]))
    expect(await screen.findByText(queued)).toBeTruthy()
    expect(read).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').closest('details')).toBeNull()
    view.unmount()
    expect(source.listeners.size).toBe(0)
  })

  it('updates queued to running to terminal from real requestId snapshots, not another request', async () => {
    const source = new Source()
    source.set([{ root: result('r1') }])
    let activitySeq = 1
    let value = snapshot([{ requestId: 'r1', phase: 'queued' }])
    const read = vi.fn(async () => value)
    const current = () => ({ ...props(source, read), useProjection: () => ({ activitySeq }) })
    const view = render(<CompactionTurnNotice {...current()} />)
    await screen.findByText(queued)

    value = snapshot([{ requestId: 'r1', phase: 'running' }])
    activitySeq++
    view.rerender(<CompactionTurnNotice {...current()} />)
    await screen.findByText(running)
    expect(screen.getByRole('status').style.fontSize).toBe('0.875em')
    expect(screen.queryByText(/正在使用远程压缩/)).toBeNull()

    value = snapshot([
      { requestId: 'r1', phase: 'completed', result: 'native' },
      { requestId: 'other-turn-request', phase: 'running' },
    ])
    activitySeq++
    view.rerender(<CompactionTurnNotice {...current()} />)
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('extracts valid nested receipts, deduplicates them, and shows only one notice', async () => {
    const source = new Source()
    const root = result('parent', {
      call: { name: 'ptc', argsRaw: '{}' },
      subCalls: [result('r1'), result('r1'), result('r2')],
    })
    source.set([{ root }])
    expect(compactionRequestIds(source.value)).toEqual(['r1', 'r2'])
    const read = vi.fn(async () => snapshot([
      { requestId: 'r1', phase: 'running' }, { requestId: 'r2', phase: 'queued' },
    ]))
    render(<CompactionTurnNotice {...props(source, read)} />)
    await screen.findByText(running)
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('ignores non-request calls, errors, mismatched receipt actions and missing call heads', () => {
    const source = new Source()
    source.set([
      { root: result('status', { call: { name: 'codex_context', argsRaw: '{"action":"status"}' } }) },
      { root: result('error', { isError: true }) },
      { root: result('missing', { call: null }) },
      { root: result('wrong', { content: [{ type: 'text', text: '{"action":"status","ok":true,"queued":{"requestId":"wrong"}}' }] }) },
    ])
    const read = vi.fn(async () => snapshot([]))
    const view = render(<CompactionTurnNotice {...props(source, read)} />)
    expect(read).not.toHaveBeenCalled()
    expect(view.container.childElementCount).toBe(0)
  })

  it('does not reuse another turn source or session snapshot with the same request id', async () => {
    const first = new Source()
    first.set([{ root: result('r1') }])
    const second = new Source()
    let resolveB: ((value: CompactionDiagnosticsSnapshot) => void) | undefined
    const read = vi.fn((sessionId: string) => sessionId === 'session-a'
      ? Promise.resolve(snapshot([{ requestId: 'r1', phase: 'running' }]))
      : new Promise<CompactionDiagnosticsSnapshot>(resolve => { resolveB = resolve }))
    const a = { ...props(first), diagnostics: { read } }
    const view = render(<CompactionTurnNotice {...a} />)
    await screen.findByText(running)

    view.rerender(<CompactionTurnNotice {...a} turn={{ turn: 8 }} useChat={selector => selector({ nodes: { turnDataSource: () => second } })} />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)

    view.rerender(<CompactionTurnNotice {...a} sessionId="session-b" />)
    expect(screen.queryByRole('status')).toBeNull()
    await act(async () => resolveB?.(snapshot([{ requestId: 'r1', phase: 'queued' }])))
    await screen.findByText(queued)
  })

  it('ignores a late old-session response and safely hides a reader failure', async () => {
    const source = new Source()
    source.set([{ root: result('r1') }])
    let resolveA: ((value: CompactionDiagnosticsSnapshot) => void) | undefined
    const read = vi.fn((sessionId: string) => sessionId === 'session-a'
      ? new Promise<CompactionDiagnosticsSnapshot>(resolve => { resolveA = resolve })
      : Promise.reject(new Error('raw private remote failure')))
    const current = { ...props(source), diagnostics: { read } }
    const view = render(<CompactionTurnNotice {...current} />)
    view.rerender(<CompactionTurnNotice {...current} sessionId="session-b" />)
    await act(async () => resolveA?.(snapshot([{ requestId: 'r1', phase: 'running' }])))
    expect(screen.queryByRole('status')).toBeNull()
    expect(view.container.textContent).not.toContain('raw private')
  })
})
