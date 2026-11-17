// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import * as Cordis from '@deepseek-ai/cordis'
import * as Slots from '@deepseek-ai/dsh-client-ui-slots'
import * as Zod from 'zod'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as JSXRuntime from 'react/jsx-runtime'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { act, cleanup, render, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as CodexClient from '../src/client/index.tsx'
import type { CompactionDiagnosticsSnapshot, CompactionRequestState } from '../src/compaction-types.ts'
import {
  createCompactionDiagnosticsReader,
  createCompactionRemoteContribution,
  type CompactionDiagnosticsReader,
  type CompactionRemote,
} from '../src/client/CompactionStatus.tsx'
import { zh } from '../src/client/locales.ts'

const contexts: Cordis.Context[] = []
const require = createRequire(import.meta.url)
const OLD_INJECT = ['slots', 'locale', 'sessions', 'remote', 'remote.session']
const modules: Record<string, unknown> = {
  '@deepseek-ai/cordis': Cordis,
  '@deepseek-ai/dsh-client-ui-slots': Slots,
  zod: Zod,
  react: React,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOMClient,
  'react/jsx-runtime': JSXRuntime,
}

/** Load the published browser export, not rc.3's distinct Node ESM entry. */
function clientModule<T>(name: string, resolver: typeof require = require): T {
  const manifestFile = resolver.resolve(`${name}/package.json`)
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
    exports: Record<string, string | { browser?: string; default?: string }>
  }
  const client = manifest.exports['./client']
  const entry = typeof client === 'string' ? client : client?.browser ?? client?.default
  if (entry === undefined) throw new Error(`no published browser client for ${name}`)
  const file = resolve(dirname(manifestFile), entry)
  let factory: ((require: (id: string) => unknown) => unknown) | undefined
  new Function('window', readFileSync(file, 'utf8'))({
    __ModuleLoader__: { load(descriptor: { factory: NonNullable<typeof factory> }) { factory = descriptor.factory } },
  })
  if (factory === undefined) throw new Error('client bundle did not publish a factory')
  return factory(id => {
    if (!(id in modules)) throw new Error(`unexpected client dependency: ${id}`)
    return modules[id]
  }) as T
}

function snapshot(phase: CompactionRequestState = 'queued'): CompactionDiagnosticsSnapshot {
  return {
    v: 1,
    persistent: false,
    facts: [],
    records: [],
    session: { state: 'unknown', owner: { state: 'unknown', evidence: [] }, at: 0 },
    requests: [
      { requestId: 'request-current', phase, ...(phase === 'completed' ? { result: 'native' as const, compactionId: 'compaction-current' } : {}) },
      { requestId: 'request-other', phase: 'completed', result: 'native', compactionId: 'compaction-other' },
    ],
  }
}

type FixtureResult =
  | { ok: true; value: CompactionDiagnosticsSnapshot }
  | { ok: false; error: { code: string; message: string } }

async function harness() {
  const ctx = new Cordis.Context()
  contexts.push(ctx)
  // Physical transport is replaced ONLY at the Connection's documented hook.
  // No sockets, server, profile, credentials, or user-session requests are used.
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('external network forbidden by this test'))
  const rpc = vi.fn(async (_prefix: string, _endpoint: string, _payload: unknown, _signal?: AbortSignal): Promise<FixtureResult> => ({
    ok: true as const,
    value: snapshot(),
  }))
  const gatewayRequire = createRequire(require.resolve('@deepseek-ai/dsh-api-gateway/package.json'))
  const connection = clientModule<{ installConnection(ctx: Cordis.Context, options: unknown): void }>(
    '@deepseek-ai/dsh-client-connection', gatewayRequire
  )
  // The real Gateway normally waits for the boot roster before starting its
  // generation loop. Leave that gate closed: unary in-memory RPC needs no loop.
  ctx.provide('loader', { await: () => new Promise<void>(() => undefined) })
  await ctx.plugin({ apply(scope: Cordis.Context) {
    connection.installConnection(scope, { transport: { ownsHost: true, rpc: {
      call: rpc,
      open: () => ({ async *[Symbol.asyncIterator]() {} }),
    } } })
  } })
  await ctx.plugin(clientModule<typeof import('@deepseek-ai/dsh-typert-registry/client')>('@deepseek-ai/dsh-typert-registry'))
  await ctx.plugin(clientModule<typeof import('@deepseek-ai/dsh-api-gateway/client')>('@deepseek-ai/dsh-api-gateway'))
  await ctx.plugin(clientModule<typeof import('@deepseek-ai/dsh-client-ui-renderer/client')>('@deepseek-ai/dsh-client-ui-renderer'))
  // Only unrelated UI-domain dependencies are small boundary fixtures.
  ctx.provide('locale', {
    register: () => () => undefined,
    bind: () => (key: string) => (zh as Record<string, string>)[key] ?? key,
  })
  ctx.provide('sessions', { binding: () => undefined })
  class SessionNamespace extends Cordis.Service {
    constructor(scope: Cordis.Context) { super(scope, 'remote.session') }
  }
  const sessionNamespace = new SessionNamespace(ctx)
  await ctx.plugin({ inject: ['slots'], apply(scope: Cordis.Context) {
    scope.slots.register({ name: 'root', children: {
      'settings.section': { kind: 'list', scope: 'root' },
      'tool.call.toolview': { kind: 'keyed', scope: 'session' },
      'conversation.chat.node': { kind: 'keyed', scope: 'session' },
      'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
    } } as never, () => null)
  } })
  return { ctx, rpc, slots: ctx.get('slots') as SlotRegistry, sessionNamespace }
}

function toolEntry(slots: SlotRegistry) {
  const entry = slots.entries('tool.call.toolview').find(entry => entry.options.key === 'codex_context')
  if (entry === undefined || typeof entry.inject !== 'function') throw new Error('production tool registration missing')
  const injected = (entry.inject as (sessionId: string) => {
    sessionId: string
    diagnostics: CompactionDiagnosticsReader
    t: (key: string) => string
  })('probe-session')
  return { entry, injected }
}

function toolProps(injected: ReturnType<typeof toolEntry>['injected'], activitySeq = 1) {
  return {
    ...injected,
    phase: 'result',
    callId: 'call-current',
    block: {
      call: { argsRaw: JSON.stringify({ action: 'request_compaction' }) },
      content: [{ type: 'text', text: JSON.stringify({ action: 'request_compaction', ok: true, queued: { requestId: 'request-current', status: 'queued' } }) }],
    },
    useProjection: () => ({ activitySeq }),
  }
}

function noticeEntry(slots: SlotRegistry) {
  const entry = slots.entries('conversation.chat.turnTail' as never)
    .find(entry => entry.options.id === 'openai-codex-compaction-turn')
  if (entry === undefined || typeof entry.inject !== 'function') throw new Error('production notice registration missing')
  const injected = (entry.inject as (sessionId: string) => ReturnType<typeof toolEntry>['injected'])('probe-session')
  return { entry, injected }
}

function noticeProps(injected: ReturnType<typeof toolEntry>['injected'], activitySeq: number) {
  const tools = [{ root: {
    ...toolProps(injected).block,
    kind: 'tool-result',
    call: { name: 'codex_context', argsRaw: JSON.stringify({ action: 'request_compaction' }) },
    subCalls: [],
  } }]
  const source = { getSnapshot: () => tools, subscribe: () => () => undefined }
  const chat = { nodes: { turnDataSource: () => source } }
  return {
    ...injected,
    turn: { turn: 1 },
    useChat: (selector: (value: typeof chat) => unknown) => selector(chat),
    useProjection: () => ({ activitySeq }),
  }
}

afterEach(async () => {
  cleanup()
  try {
    for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  } finally {
    vi.restoreAllMocks()
  }
})

describe('real client Gateway mounting in the product Cordis scope', () => {
  it('reproduces the old scope mount failure before any carrier request', async () => {
    const { ctx, rpc } = await harness()
    const probe = ctx.plugin({ inject: OLD_INJECT, async apply(scope: Cordis.Context) {
      const mount = scope.remote.$mount
      await expect(mount.call(scope.remote, createCompactionRemoteContribution() as never))
        .rejects.toThrow('cannot get property "typert" without inject')
    } })
    await probe
    expect(rpc).not.toHaveBeenCalled()
    expect(ctx.get('remote.codexCompaction')).toBeUndefined()
  })

  it('independently reproduces namespace access failure after a successful mount', async () => {
    const { ctx, rpc } = await harness()
    const probe = ctx.plugin({ inject: [...OLD_INJECT, 'typert'], async apply(scope: Cordis.Context) {
      const dispose = await scope.remote.$mount(createCompactionRemoteContribution() as never)
      try {
        const reader = createCompactionDiagnosticsReader(
          () => (scope.remote as unknown as { codexCompaction: CompactionRemote }).codexCompaction,
          Promise.resolve(true),
        )
        await expect(reader.read('probe-session')).rejects.toThrow('cannot get property "remote.codexCompaction" without inject')
      } finally { await dispose() }
    } })
    await probe
    expect(rpc).not.toHaveBeenCalled()
  })

  it('mounts from the actual product apply and reads through its registered tool reader', async () => {
    const { ctx, rpc, slots } = await harness()
    const product = ctx.plugin(CodexClient)
    await product
    const { injected } = toolEntry(slots)
    // Regression was RED on the old product scope: its mount catch hid the
    // missing injection and the actual reader rejected as unavailable.
    await expect(injected.diagnostics.read('probe-session')).resolves.toMatchObject({
      requests: [{ requestId: 'request-current', phase: 'queued' }, { requestId: 'request-other' }],
    })
    expect(rpc).toHaveBeenCalledExactlyOnceWith('/api', 'codexCompaction/read', { args: { request: { sessionId: 'probe-session' } } }, expect.any(AbortSignal))
  })

  it('shows synthetic queued/running states through the mounted reader and removes the exact completed notice', async () => {
    // This proves client mounting/rendering, NOT a real compaction execution.
    // Actual maintenance hold/release is covered by the real driver spec.
    const { ctx, rpc, slots } = await harness()
    await ctx.plugin(CodexClient)
    const { entry, injected } = noticeEntry(slots)
    const Component = entry.component as React.ComponentType<Record<string, unknown>>
    const view = render(React.createElement(Component, noticeProps(injected, 1)))
    const ui = within(view.container)
    expect(await ui.findByText(zh.codexContextRequestQueuedNotice)).toBeTruthy()
    // request-other is already completed: it must not complete this notice.
    expect(ui.getByRole('status')).toBeTruthy()

    rpc.mockResolvedValue({ ok: true, value: snapshot('running') })
    view.rerender(React.createElement(Component, noticeProps(injected, 2)))
    expect(await ui.findByText(zh.codexContextRequestRunningGeneric)).toBeTruthy()
    await act(async () => { await Promise.resolve() })
    expect(ui.getByText(zh.codexContextRequestRunningGeneric)).toBeTruthy()

    rpc.mockResolvedValue({ ok: true, value: snapshot('completed') })
    view.rerender(React.createElement(Component, noticeProps(injected, 3)))
    await waitFor(() => expect(ui.queryByRole('status')).toBeNull())
    expect(rpc).toHaveBeenCalledTimes(3) // explicit source changes, not polling
    for (const [prefix, endpoint, payload] of rpc.mock.calls) {
      expect([prefix, endpoint, payload]).toEqual(['/api', 'codexCompaction/read', { args: { request: { sessionId: 'probe-session' } } }])
    }
  })

  it('never applies another request outcome to the actual registered tool card', async () => {
    const { ctx, rpc, slots } = await harness()
    const value = snapshot()
    rpc.mockResolvedValue({ ok: true, value: { ...value, requests: value.requests?.filter(request => request.requestId === 'request-other') ?? [] } })
    await ctx.plugin(CodexClient)
    const { entry, injected } = toolEntry(slots)
    const view = render(React.createElement(entry.component as React.ComponentType<Record<string, unknown>>, toolProps(injected)))
    const ui = within(view.container)
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1))
    await act(async () => { await Promise.resolve() })
    expect(ui.getByText(zh.codexContextRequestAccepted)).toBeTruthy()
    expect(ui.queryByText(zh.codexContextRequestCompleted)).toBeNull()
    expect(ui.queryByText(zh.codexContextRequestRunningGeneric)).toBeNull()
  })

  it('does not apply a late previous-session response to the newly scoped card', async () => {
    const { ctx, rpc, slots } = await harness()
    let release: ((result: FixtureResult) => void) | undefined
    const oldResponse = new Promise<FixtureResult>(resolve => { release = resolve })
    rpc.mockImplementation(async (_prefix, _endpoint, payload) => {
      const id = (payload as { args: { request: { sessionId: string } } }).args.request.sessionId
      return id === 'probe-session' ? oldResponse : { ok: true, value: snapshot('queued') }
    })
    await ctx.plugin(CodexClient)
    const { entry, injected } = toolEntry(slots)
    const Component = entry.component as React.ComponentType<Record<string, unknown>>
    const view = render(React.createElement(Component, toolProps(injected)))
    try {
      await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1))
      view.rerender(React.createElement(Component, toolProps({ ...injected, sessionId: 'new-probe-session' })))
      const ui = within(view.container)
      expect(await ui.findByText(zh.codexContextRequestQueuedNotice)).toBeTruthy()
      await act(async () => { release?.({ ok: true, value: snapshot('completed') }) })
      expect(ui.queryByText(zh.codexContextRequestCompleted)).toBeNull()
      expect(ui.getByText(zh.codexContextRequestQueuedNotice)).toBeTruthy()
      expect(rpc.mock.calls[0]?.[3]?.aborted).toBe(true)
      expect(rpc).toHaveBeenCalledTimes(2)
    } finally {
      release?.({ ok: true, value: snapshot('completed') })
    }
  })

  it('withdraws its mounted namespace and entries without touching the host session namespace', async () => {
    const { ctx, rpc, slots } = await harness()
    const product = ctx.plugin(CodexClient)
    await product
    await toolEntry(slots).injected.diagnostics.read('probe-session')
    const namespace = ctx.get('remote.codexCompaction') as CompactionRemote
    const retainedRead = namespace.read
    expect(slots.entries('settings.section')).toHaveLength(2)
    expect(slots.entries('tool.call.toolview').some(entry => entry.options.key === 'imagegen')).toBe(true)
    await product.dispose()
    expect(ctx.get('remote.codexCompaction')).toBeUndefined()
    expect(ctx.get('remote.session')).toBeDefined()
    expect(slots.entries('root')).toHaveLength(1)
    expect(slots.entries('settings.section')).toHaveLength(0)
    expect(slots.entries('tool.call.toolview')).toHaveLength(0)
    await expect(retainedRead({ sessionId: 'probe-session' })).resolves.toMatchObject({ ok: false })
    expect(rpc).toHaveBeenCalledTimes(1) // withdrawn capability never reaches carrier
  })

  it('keeps unrelated product entries alive when the optional Host capability is unavailable', async () => {
    const { ctx, rpc, slots } = await harness()
    rpc.mockResolvedValue({ ok: false, error: { code: 'gateway/internal', message: 'synthetic unavailable Host capability' } })
    await ctx.plugin(CodexClient)
    const { injected } = toolEntry(slots)
    await expect(injected.diagnostics.read('probe-session')).rejects.toThrow('gateway/internal')
    expect(slots.entries('settings.section')).toHaveLength(2)
    expect(slots.entries('tool.call.toolview').some(entry => entry.options.key === 'imagegen')).toBe(true)
    expect(ctx.get('remote.session')).toBeDefined()
  })
})
