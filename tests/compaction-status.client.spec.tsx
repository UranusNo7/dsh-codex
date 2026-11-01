// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  compactionEstimateLine,
  compactionFactFor,
  compactionReasonLabel,
  compactionUsageLine,
  createCompactionDiagnosticsReader,
  createCompactionRemoteContribution,
} from '../src/client/CompactionStatus.tsx'
import type { CompactionDiagnosticsSnapshot } from '../src/compaction-types.ts'
import { zh } from '../src/client/locales.ts'

function translate(key: string, params?: Record<string, unknown>): string {
  const raw = (zh as Record<string, string>)[key] ?? key
  return params === undefined ? raw : raw.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name]))
}

const at = Date.UTC(2026, 10, 1, 8, 0, 0)

describe('compaction client helpers', () => {
  it('localizes fixed reasons and keeps unknown reasons explicit', () => {
    expect(compactionReasonLabel(translate, 'native-request-failed')).toBe('原生请求失败')
    expect(compactionReasonLabel(translate, undefined)).toBe('原因未记录')
  })

  it('formats local estimates and provider usage without raw source enums', () => {
    expect(compactionEstimateLine(translate, {
      tokens: 500, source: 'source-text', estimator: 'host-token-meter', at,
    })).toBe('500 tokens · 08:00:00 UTC')
    const usage = compactionUsageLine(translate, {
      inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1, totalTokens: 17,
      source: 'native-request', at,
    })
    expect(usage).toContain('输入 10')
    expect(usage).toContain('输出 4')
    expect(usage).toContain('缓存读取 2')
    expect(usage).toContain('缓存写入 1')
    expect(usage).toContain('总计 17')
    expect(usage).not.toContain('native-request')
    expect(usage).not.toContain('in ')
    expect(usage).not.toContain('out ')
  })

  it('joins facts by exact checkpoint or summary sequence only', () => {
    const snapshot = {
      facts: [{
        compactionId: 'cmp-1',
        status: 'ordinary',
        startSeq: 1,
        summarySeq: 2,
        checkpointSeq: 3,
        endSeq: 4,
        turn: 1,
      }],
    } as unknown as CompactionDiagnosticsSnapshot
    expect(compactionFactFor(snapshot, 3, null)?.compactionId).toBe('cmp-1')
    expect(compactionFactFor(snapshot, null, 2)?.compactionId).toBe('cmp-1')
    expect(compactionFactFor(snapshot, 9, null)).toBeUndefined()
  })

  it('unwraps the generated RemoteResult branch instead of treating it as a snapshot', async () => {
    const value = {
      v: 1,
      persistent: true,
      facts: [],
      records: [],
      session: { state: 'unknown', owner: { state: 'unknown', evidence: [] }, at },
    } as unknown as CompactionDiagnosticsSnapshot
    const reader = createCompactionDiagnosticsReader(
      () => ({ read: async () => ({ ok: true, value }) }),
      Promise.resolve(true)
    )
    await expect(reader.read('s1')).resolves.toBe(value)
  })

  it('fails safely on the RemoteResult error branch without exposing its message', async () => {
    const reader = createCompactionDiagnosticsReader(
      () => ({
        read: async () => ({
          ok: false as const,
          error: { code: 'gateway/internal', message: 'raw Host error' },
        }),
      }),
      Promise.resolve(true)
    )
    await expect(reader.read('s1')).rejects.toThrow('gateway/internal')
    await expect(reader.read('s1')).rejects.not.toThrow('raw Host error')
  })

  it('builds the exact read-only Remote descriptor', () => {
    const contribution = createCompactionRemoteContribution()
    expect(contribution.package).toBe('dsh-codex-client')
    expect(contribution.descriptors[0]).toMatchObject({
      service: 'compactionDiagnostics',
      namespace: 'codexCompaction',
      method: 'read',
      invocation: { kind: 'direct' },
      cancellation: { parameter: 'signal' },
    })
  })
})
