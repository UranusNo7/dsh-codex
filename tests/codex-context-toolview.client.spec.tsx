// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CompactionDiagnosticsSnapshot } from '../src/compaction-types.ts'
import { CodexContextToolView } from '../src/client/CodexContextToolView.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

function translate(key: string, params?: Record<string, unknown>): string {
  const raw = (zh as Record<string, string>)[key] ?? key
  return params === undefined ? raw : raw.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name]))
}

const at = Date.UTC(2026, 10, 1, 8, 0, 0)

function snapshot(overrides: Record<string, unknown> = {}): CompactionDiagnosticsSnapshot {
  return {
    v: 1,
    persistent: true,
    facts: [],
    records: [],
    session: { state: 'unknown', owner: { state: 'unknown', evidence: [] }, at },
    ...overrides,
  } as unknown as CompactionDiagnosticsSnapshot
}

function resultBlock(
  args: Record<string, unknown>,
  output: Record<string, unknown> | undefined,
  options: { isError?: boolean } = {}
) {
  return {
    call: { argsRaw: JSON.stringify(args) },
    content: output === undefined ? [] : [{ type: 'text', text: JSON.stringify(output) }],
    ...(options.isError === undefined ? {} : { isError: options.isError }),
  }
}

function props(
  action: 'request_compaction' | 'status' | 'recall',
  output: Record<string, unknown> | undefined,
  options: {
    phase?: 'preparing' | 'start' | 'result'
    diagnostics?: { read: ReturnType<typeof vi.fn> }
    useProjection?: () => unknown
    useSession?: (selector: (value: {
      running: boolean
      pendingSubmissions: readonly unknown[]
      awaitingFirstTurn: boolean
    }) => unknown) => unknown
    block?: Record<string, unknown>
  } = {}
) {
  return {
    phase: options.phase ?? 'result',
    callId: 'call-1',
    block: options.block ?? resultBlock({ action }, output),
    sessionId: 'session-1',
    t: translate,
    diagnostics: options.diagnostics ?? { read: vi.fn(async () => snapshot()) },
    ...(options.useProjection === undefined ? {} : { useProjection: options.useProjection }),
    ...(options.useSession === undefined ? {} : { useSession: options.useSession }),
  }
}

describe('CodexContextToolView', () => {
  it('shows a neutral row while preparing', () => {
    render(createElement(CodexContextToolView, props('request_compaction', undefined, {
      phase: 'preparing',
      block: { argsRaw: '' },
    }) as never))

    expect(screen.getByText('Codex 上下文工具准备中…')).toBeTruthy()
    expect(screen.queryByText('压缩请求已受理')).toBeNull()
  })

  it('keeps status output as its own result, not a compaction request', () => {
    const output = {
      action: 'status',
      ok: true,
      owner: { state: 'available', evidence: [] },
      queued: { requestId: 'r1', status: 'queued' },
      last_outcome: { state: 'completed', requestId: 'r0', at },
    }
    render(createElement(CodexContextToolView, props('status', output) as never))

    expect(screen.getByText('Codex 压缩状态')).toBeTruthy()
    expect(screen.getByText('可用')).toBeTruthy()
    expect(screen.getByText('已排队（未开始）')).toBeTruthy()
    expect(screen.getByRole('status').querySelector('details')).not.toBeNull()
    expect(screen.queryByText('压缩请求已完成')).toBeNull()
  })

  it('shows useful bounded recall output without a request card', () => {
    const output = {
      action: 'recall',
      ok: true,
      recall: {
        fromSeq: 1,
        toSeqExclusive: 10,
        scanned: 9,
        truncated: false,
        items: [{ seq: 4, type: 'user/message', kind: 'message', text: 'hello' }],
      },
    }
    render(createElement(CodexContextToolView, props('recall', output) as never))

    expect(screen.getByText('Codex 有界历史')).toBeTruthy()
    expect(screen.getByText('1–10')).toBeTruthy()
    expect(screen.getByText('hello')).toBeTruthy()
    expect(screen.queryByText('压缩请求已完成')).toBeNull()
  })

  it('localizes a rejected request reason instead of passing raw codes', () => {
    render(createElement(CodexContextToolView, props('request_compaction', {
      action: 'request_compaction', ok: false, reason: 'cooldown',
    }) as never))

    expect(screen.getByText('压缩请求未受理')).toBeTruthy()
    expect(screen.getByText('压缩冷却中')).toBeTruthy()
    expect(screen.queryByText('cooldown')).toBeNull()
  })

  it('renders status and recall failures explicitly instead of empty success', () => {
    const status = render(createElement(CodexContextToolView, props('status', {
      action: 'status', ok: false, reason: 'history-unavailable',
    }) as never))
    expect(status.getByText('无法读取 Codex 压缩状态')).toBeTruthy()
    expect(status.getByText('有界历史不可用')).toBeTruthy()
    status.unmount()

    render(createElement(CodexContextToolView, props('recall', {
      action: 'recall', ok: false, reason: 'history-unavailable',
    }) as never))
    expect(screen.getByText('Codex 历史读取失败')).toBeTruthy()
    expect(screen.queryByText('0')).toBeNull()
  })

  it('renders a queued request as accepted, never success', () => {
    const output = {
      action: 'request_compaction',
      ok: true,
      queued: { requestId: 'req-1', status: 'queued', boundary: 'idle', requestedAt: at },
    }
    render(createElement(CodexContextToolView, props('request_compaction', output) as never))

    expect(screen.getByText('压缩请求已受理')).toBeTruthy()
    expect(screen.getByText('未知')).toBeTruthy()
    expect(screen.queryByText('压缩请求已完成')).toBeNull()
    expect(screen.queryByText('原生检查点已提交')).toBeNull()
  })

  it('isolates two requests by their own requestId', async () => {
    const diagnostics = {
      read: vi.fn(async () => snapshot({
        requests: [
          { requestId: 'req-1', phase: 'completed', result: 'native', queuedAt: at, endedAt: at },
          { requestId: 'req-2', phase: 'queued', queuedAt: at },
        ],
      })),
    }
    const first = props('request_compaction', {
      action: 'request_compaction', ok: true, queued: { requestId: 'req-1', status: 'queued', requestedAt: at },
    }, { diagnostics })
    const second = props('request_compaction', {
      action: 'request_compaction', ok: true, queued: { requestId: 'req-2', status: 'queued', requestedAt: at },
    }, { diagnostics })

    const firstView = render(createElement(CodexContextToolView, first as never))
    await firstView.findByText('压缩请求已完成')
    firstView.unmount()
    render(createElement(CodexContextToolView, second as never))
    expect(await screen.findByText('压缩已排队，将在会话空闲后开始')).toBeTruthy()
    expect(screen.getByText('已排队（未开始）')).toBeTruthy()
    expect(screen.queryByText('压缩请求已完成')).toBeNull()
  })

  it('stays accepted/unknown when metadata is unavailable or legacy', async () => {
    const diagnostics = { read: vi.fn(async () => { throw new Error('unavailable') }) }
    render(createElement(CodexContextToolView, props('request_compaction', {
      action: 'request_compaction', ok: true, queued: { requestId: 'old', status: 'queued', requestedAt: at },
    }, { diagnostics }) as never))

    expect(await screen.findByText('压缩请求已受理')).toBeTruthy()
    expect(screen.getByText('未知')).toBeTruthy()
    expect(screen.queryByText('压缩请求进行中')).toBeNull()
    expect(screen.queryByText('压缩请求已完成')).toBeNull()
  })

  it('shows a short completion confirmation and defers details to history', async () => {
    const diagnostics = {
      read: vi.fn(async () => snapshot({
        requests: [{ requestId: 'req-1', phase: 'completed', result: 'native', queuedAt: at, endedAt: at }],
      })),
    }
    render(createElement(CodexContextToolView, props('request_compaction', {
      action: 'request_compaction', ok: true, queued: { requestId: 'req-1', status: 'queued', requestedAt: at },
    }, { diagnostics }) as never))

    expect(await screen.findByText('压缩请求已完成')).toBeTruthy()
    expect(screen.getByText('原生检查点已提交')).toBeTruthy()
    expect(screen.getByText('见对话中的压缩记录')).toBeTruthy()
    expect(screen.queryByText(/host-token-meter/)).toBeNull()
  })

  it('renders request-specific failure, cancellation, noop, busy, and refusal results', async () => {
    const states = [
      ['failed', '压缩请求失败'],
      ['cancelled', '压缩请求已取消'],
      ['noop', '无需压缩'],
      ['skipped-busy', '压缩忙碌，已跳过'],
      ['refused', '压缩请求被拒绝'],
    ] as const
    for (const [state, label] of states) {
      const diagnostics = {
        read: vi.fn(async () => snapshot({
          requests: [{ requestId: 'req-1', phase: state, queuedAt: at }],
        })),
      }
      const view = render(createElement(CodexContextToolView, props('request_compaction', {
        action: 'request_compaction', ok: true, queued: { requestId: 'req-1', status: 'queued', requestedAt: at },
      }, { diagnostics }) as never))
      await view.findByText(label)
      expect(view.queryByText('压缩请求已完成')).toBeNull()
      view.unmount()
    }
  })

  it('does not let a stale running controller state override a completed fact', async () => {
    const diagnostics = {
      read: vi.fn(async () => snapshot({
        session: { state: 'running', owner: { state: 'available', evidence: [] }, at },
        requests: [{ requestId: 'req-1', phase: 'completed', result: 'ordinary', queuedAt: at, endedAt: at }],
      })),
    }
    render(createElement(CodexContextToolView, props('request_compaction', {
      action: 'request_compaction', ok: true, queued: { requestId: 'req-1', status: 'queued', requestedAt: at },
    }, { diagnostics }) as never))

    expect(await screen.findByText('压缩请求已完成')).toBeTruthy()
    expect(screen.getByText('普通摘要已提交')).toBeTruthy()
    expect(screen.queryByText('正在压缩上下文，后续消息将排队等待')).toBeNull()
  })

  it('uses remote wording only when a same-compactionId native selection record exists', async () => {
    const output = {
      action: 'request_compaction', ok: true, queued: { requestId: 'req-1', status: 'queued', requestedAt: at },
    }
    const diagnostics = {
      read: vi.fn(async () => snapshot({
        requests: [{ requestId: 'req-1', phase: 'running', compactionId: 'cmp-1', queuedAt: at }],
        records: [{ compactionId: 'cmp-1', at, decision: 'selected-native' }],
      })),
    }
    render(createElement(CodexContextToolView, props('request_compaction', output, { diagnostics }) as never))

    expect(await screen.findByText('正在使用远程压缩，后续消息将排队等待')).toBeTruthy()
    expect(screen.getByText('运行中')).toBeTruthy()
  })

  it('refreshes on activitySeq/session changes but not polling', async () => {
    let activitySeq = 1
    let running = true
    const diagnostics = {
      read: vi.fn(async () => snapshot({
        requests: [{ requestId: 'req-1', phase: running ? 'running' : 'completed', result: running ? undefined : 'native', queuedAt: at }],
      })),
    }
    const useProjection = () => ({ v: 1, facts: [], activitySeq })
    const useSession = (selector: (value: {
      running: boolean
      pendingSubmissions: readonly unknown[]
      awaitingFirstTurn: boolean
    }) => unknown) => selector({ running, pendingSubmissions: [], awaitingFirstTurn: false })
    const { rerender } = render(createElement(CodexContextToolView, props('request_compaction', {
      action: 'request_compaction', ok: true, queued: { requestId: 'req-1', status: 'queued', requestedAt: at },
    }, { diagnostics, useProjection, useSession }) as never))
    await screen.findByText('正在压缩上下文，后续消息将排队等待')
    const card = screen.getByRole('status')
    expect(card.style.fontSize).toBe('0.875em')
    expect(card.querySelector('strong')?.style.fontSize).toBe('inherit')
    expect(screen.getByText('运行中').parentElement?.style.fontSize).toBe('inherit')

    running = false
    activitySeq = 2
    rerender(createElement(CodexContextToolView, props('request_compaction', {
      action: 'request_compaction', ok: true, queued: { requestId: 'req-1', status: 'queued', requestedAt: at },
    }, { diagnostics, useProjection, useSession }) as never))

    await waitFor(() => expect(diagnostics.read).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('压缩请求已完成')).toBeTruthy()
  })

  it('never shows session A data on the first frame after switching to session B', async () => {
    let resolveB: ((value: CompactionDiagnosticsSnapshot) => void) | undefined
    const diagnostics = {
      read: vi.fn((sessionId: string) => {
        if (sessionId === 'session-1') {
          return Promise.resolve(snapshot({
            requests: [{ requestId: 'req-1', phase: 'completed', result: 'native', queuedAt: at, endedAt: at }],
          }))
        }
        return new Promise<CompactionDiagnosticsSnapshot>(resolve => {
          resolveB = resolve
        })
      }),
    }
    const output = {
      action: 'request_compaction', ok: true, queued: { requestId: 'req-1', status: 'queued', requestedAt: at },
    }
    const { rerender } = render(createElement(CodexContextToolView, props('request_compaction', output, { diagnostics }) as never))
    await screen.findByText('压缩请求已完成')

    rerender(createElement(CodexContextToolView, {
      ...props('request_compaction', output, { diagnostics }),
      sessionId: 'session-2',
    } as never))
    expect(screen.queryByText('压缩请求已完成')).toBeNull()
    expect(screen.getByText('压缩请求已受理')).toBeTruthy()

    resolveB?.(snapshot({
      requests: [{ requestId: 'req-1', phase: 'completed', result: 'ordinary', queuedAt: at, endedAt: at }],
    }))
    expect(await screen.findByText('压缩请求已完成')).toBeTruthy()
  })

  it('never lets a late session A resolution overwrite session B', async () => {
    let resolveA: ((value: CompactionDiagnosticsSnapshot) => void) | undefined
    let resolveB: ((value: CompactionDiagnosticsSnapshot) => void) | undefined
    const diagnostics = {
      read: vi.fn((sessionId: string) => {
        return new Promise<CompactionDiagnosticsSnapshot>(resolve => {
          if (sessionId === 'session-1') resolveA = resolve
          else resolveB = resolve
        })
      }),
    }
    const output = {
      action: 'request_compaction', ok: true, queued: { requestId: 'req-1', status: 'queued', requestedAt: at },
    }
    const { rerender } = render(createElement(CodexContextToolView, props('request_compaction', output, { diagnostics }) as never))
    rerender(createElement(CodexContextToolView, {
      ...props('request_compaction', output, { diagnostics }),
      sessionId: 'session-2',
    } as never))

    resolveA?.(snapshot({
      requests: [{ requestId: 'req-1', phase: 'completed', result: 'native', queuedAt: at, endedAt: at }],
    }))
    expect(screen.queryByText('压缩请求已完成')).toBeNull()
    expect(screen.getByText('压缩请求已受理')).toBeTruthy()

    resolveB?.(snapshot({
      requests: [{ requestId: 'req-1', phase: 'completed', result: 'ordinary', queuedAt: at, endedAt: at }],
    }))
    expect(await screen.findByText('压缩请求已完成')).toBeTruthy()
    expect(screen.getByText('普通摘要已提交')).toBeTruthy()
  })

  it('aborts the session read on unmount and never renders late data', async () => {
    const signals: AbortSignal[] = []
    const diagnostics = {
      read: vi.fn((_sessionId: string, signal?: AbortSignal) => {
        signals.push(signal as AbortSignal)
        return new Promise<CompactionDiagnosticsSnapshot>(() => undefined)
      }),
    }
    const { rerender, unmount } = render(createElement(CodexContextToolView, props('request_compaction', {
      action: 'request_compaction', ok: true, queued: { requestId: 'req-1', status: 'queued', requestedAt: at },
    }, { diagnostics }) as never))
    rerender(createElement(CodexContextToolView, {
      ...props('request_compaction', {
        action: 'request_compaction', ok: true, queued: { requestId: 'req-1', status: 'queued', requestedAt: at },
      }, { diagnostics }),
      sessionId: 'session-2',
    } as never))
    await waitFor(() => expect(signals[0]?.aborted).toBe(true))
    unmount()
    expect(signals.at(-1)?.aborted).toBe(true)
  })
})
