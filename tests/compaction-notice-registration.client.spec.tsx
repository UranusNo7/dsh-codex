// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as Cordis from '@deepseek-ai/cordis'
import * as SlotCoreModule from '@deepseek-ai/dsh-client-ui-slots'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as JSXRuntime from 'react/jsx-runtime'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CompactionDiagnosticsSnapshot } from '../src/compaction-types.ts'
import type { CompactionDiagnosticsReader } from '../src/client/CompactionStatus.tsx'
import { CompactionTurnNotice, installCompactionTurnNotice } from '../src/client/CompactionTurnNotice.tsx'

const SLOT = 'conversation.chat.turnTail'
const NOTICE_ID = 'openai-codex-compaction-turn'
const contexts: Cordis.Context[] = []

/** Execute the published browser factory with the SAME real modules as Vitest. */
function rendererModule(): typeof import('@deepseek-ai/dsh-client-ui-renderer/client') {
  const modules: Record<string, unknown> = {
    react: React,
    'react-dom': ReactDOM,
    'react-dom/client': ReactDOMClient,
    'react/jsx-runtime': JSXRuntime,
    '@deepseek-ai/cordis': Cordis,
    '@deepseek-ai/dsh-client-ui-slots': SlotCoreModule,
  }
  let factory: ((require: (id: string) => unknown) => unknown) | undefined
  const file = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-client-ui-renderer/client')
  // The public /client artifact is ModuleLoader format, not an ESM export.
  // Only this trusted installed bundle runs; no global window loader is changed.
  new Function('window', readFileSync(file, 'utf8'))({
    __ModuleLoader__: {
      load(descriptor: { id: string; factory: NonNullable<typeof factory> }) {
        expect(descriptor.id).toBe('@deepseek-ai/dsh-client-ui-renderer')
        factory = descriptor.factory
      },
    },
  })
  if (factory === undefined) throw new Error('renderer did not publish its client factory')
  return factory(id => {
    if (!(id in modules)) throw new Error(`unexpected renderer dependency: ${id}`)
    return modules[id]
  }) as typeof import('@deepseek-ai/dsh-client-ui-renderer/client')
}

async function registryHarness() {
  const ctx = new Cordis.Context()
  contexts.push(ctx)
  const renderer = ctx.plugin(rendererModule())
  await renderer
  return { ctx, slots: ctx.get('slots') as SlotRegistry }
}

/** The real root entry owns this declaration, just as a shipped parent does. */
function declarationOwner(ctx: Cordis.Context, declare = true) {
  return ctx.plugin({
    name: 'compaction-notice-test-owner',
    inject: ['slots'],
    apply(scope: Cordis.Context) {
      // rc1's compile-time catalog predates this rc5 turn-tail key; the actual
      // SlotCore still validates its real keyed/list declaration and lifecycle.
      scope.slots.register({
        name: 'root',
        ...(declare ? { children: { [SLOT]: { kind: 'list', scope: 'session' } } } : {}),
      } as never, () => null)
    },
  })
}

function entries(slots: SlotRegistry) {
  return slots.entries(SLOT as never)
}

function diagnosticsReader(): CompactionDiagnosticsReader {
  return {
    read: vi.fn(async (): Promise<CompactionDiagnosticsSnapshot> => ({
      v: 1,
      persistent: false,
      facts: [],
      records: [],
      session: { state: 'unknown', owner: { state: 'unknown', evidence: [] }, at: 0 },
    })),
  }
}

function noticePlugin(ctx: Cordis.Context, reader: CompactionDiagnosticsReader) {
  return ctx.plugin({
    name: 'production-compaction-notice-test-client',
    inject: ['slots'],
    apply(scope: Cordis.Context) {
      // Pass the REAL Cordis-scoped service, never a copied-method facade.
      scope.effect(() => installCompactionTurnNotice(scope as never, reader, key => key))
    },
  })
}

afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  } finally {
    vi.restoreAllMocks()
  }
})

describe('real Cordis / SlotRegistry compaction notice registration', () => {
  it.each([true, false])('installs the production helper with declaration-first=%s and releases each lifetime', async declarationFirst => {
    const { ctx, slots } = await registryHarness()
    const reader = diagnosticsReader()
    let owner: ReturnType<typeof declarationOwner> | undefined
    if (declarationFirst) {
      owner = declarationOwner(ctx)
      await owner
    }
    const plugin = noticePlugin(ctx, reader)
    await plugin
    if (!declarationFirst) {
      expect(entries(slots)).toHaveLength(0)
      owner = declarationOwner(ctx)
      await owner
    }
    expect(entries(slots)).toHaveLength(1)
    expect(entries(slots)[0]?.component).toBe(CompactionTurnNotice)
    expect(entries(slots)[0]?.options).toMatchObject({ id: NOTICE_ID, order: 15 })
    expect(reader.read).not.toHaveBeenCalled() // registration never does business IO

    await owner?.dispose()
    expect(entries(slots)).toHaveLength(0)
    owner = declarationOwner(ctx)
    await owner
    expect(entries(slots)).toHaveLength(1) // one fresh declaration, not a duplicate

    await plugin.dispose()
    expect(entries(slots)).toHaveLength(0)
    expect(slots.entries('root')).toHaveLength(1) // caller unload preserves the host
    await owner.dispose()
    owner = declarationOwner(ctx)
    await owner
    expect(entries(slots)).toHaveLength(0) // unloaded waiting inject cannot revive
  })

  it('returns an idempotent disposer that cancels a pending declaration wait', async () => {
    const { ctx, slots } = await registryHarness()
    let dispose: (() => void) | undefined
    const plugin = ctx.plugin({
      inject: ['slots'],
      apply(scope: Cordis.Context) {
        dispose = installCompactionTurnNotice(scope as never, diagnosticsReader(), key => key)
      },
    })
    await plugin
    expect(dispose).toBeTypeOf('function')
    dispose?.()
    dispose?.()
    const owner = declarationOwner(ctx)
    await owner
    expect(entries(slots)).toHaveLength(0)
    expect(slots.entries('root')).toHaveLength(1)
    await plugin.dispose()
  })

  it('releases an active registration through the returned disposer without unloading its plugin', async () => {
    const { ctx, slots } = await registryHarness()
    const owner = declarationOwner(ctx)
    await owner
    let dispose: (() => void) | undefined
    const plugin = ctx.plugin({
      inject: ['slots'],
      apply(scope: Cordis.Context) {
        dispose = installCompactionTurnNotice(scope as never, diagnosticsReader(), key => key)
      },
    })
    await plugin
    expect(entries(slots)).toHaveLength(1)
    // Do NOT remove the declaration or unload the plugin: either would hide a
    // callback that forgot to return the active registration's disposer.
    dispose?.()
    dispose?.()
    expect(entries(slots)).toHaveLength(0)
    expect(slots.entries('root')).toHaveLength(1)
    await owner.dispose()
    const replacement = declarationOwner(ctx)
    await replacement
    expect(entries(slots)).toHaveLength(0)
    await plugin.dispose()
  })

  it.each([true, false])('fails closed on the real same-cell conflict with declaration-first=%s', async declarationFirst => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { ctx, slots } = await registryHarness()
    const reader = diagnosticsReader()
    const Stock = () => null
    let owner: ReturnType<typeof declarationOwner> | undefined
    // Register the host's waiting injector FIRST, so a late declaration gives
    // the host its cell before the optional plugin attempts the same priority.
    const stock = ctx.plugin({
      name: 'host-compaction-notice-cell',
      inject: ['slots'],
      apply(scope: Cordis.Context) {
        scope.slots.inject(SLOT as never, () => scope.slots.register({
          name: SLOT, id: NOTICE_ID, priority: 0,
        } as never, Stock))
      },
    })
    await stock
    if (declarationFirst) {
      owner = declarationOwner(ctx)
      await owner
    }
    const original = entries(slots)[0]
    const plugin = noticePlugin(ctx, reader)
    // A duplicate must NOT turn an optional client contribution into boot failure.
    await plugin
    if (!declarationFirst) {
      expect(warn).not.toHaveBeenCalled()
      owner = declarationOwner(ctx)
      await owner // late-declaration callback errors must also be contained
    }
    await Promise.resolve()
    expect(entries(slots)).toHaveLength(1)
    expect(entries(slots)[0]?.component).toBe(Stock)
    if (declarationFirst) expect(entries(slots)[0]).toBe(original)
    expect(warn).toHaveBeenCalledExactlyOnceWith('dsh-codex: optional compaction notice unavailable')
    expect(reader.read).not.toHaveBeenCalled()
    await plugin.dispose()
    expect(entries(slots)).toHaveLength(1) // conflicting host entry is untouched
    await owner?.dispose()
    expect(entries(slots)).toHaveLength(0)
    await stock.dispose()
  })

  it('reproduces the old bare-method failure on the actual scoped service proxy', async () => {
    const { ctx } = await registryHarness()
    const probe = ctx.plugin({
      name: 'compaction-notice-method-binding-probe',
      inject: ['slots'],
      apply(scope: Cordis.Context) {
        const inject = scope.slots.inject
        expect(() => inject('root', () => () => undefined)).toThrow(/ctx/)
        const copied = { inject: scope.slots.inject }
        expect(() => copied.inject('root', () => () => undefined)).toThrow(/effect/)
        // Closure forwarding preserves both the receiver and caller-fiber scope.
        const forward = (callback: () => () => void) => scope.slots.inject('root', callback)
        expect(typeof forward(() => () => undefined)).toBe('function')
      },
    })
    // Cordis apply is async: not awaiting would miss a broken boot registration.
    await probe
  })

  it('surfaces the broken registration when the Cordis plugin apply is awaited', async () => {
    const { ctx } = await registryHarness()
    const broken = ctx.plugin({
      name: 'compaction-notice-old-boot-negative-control',
      inject: ['slots'],
      apply(scope: Cordis.Context) {
        const inject = scope.slots.inject
        inject('root', () => () => undefined)
      },
    })
    await expect(broken).rejects.toThrow(/ctx/)
  })

  it('exposes the lost cleanup when a declaration callback returns no disposer', async () => {
    const { ctx, slots } = await registryHarness()
    const owner = declarationOwner(ctx)
    await owner
    let mutations = 0
    let unsubscribe: () => void = () => undefined
    const legacy = ctx.plugin({
      name: 'compaction-notice-missing-disposer-negative-control',
      inject: ['slots'],
      apply(scope: Cordis.Context) {
        const legacyCallback = () => {
          unsubscribe = scope.slots.subscribe('root', () => { mutations += 1 })
          scope.slots.register({ name: SLOT, id: NOTICE_ID } as never, () => null)
          // Deliberately wrong old form: neither registration nor listener
          // cleanup is returned to the declaration-lifetime effect.
        }
        scope.slots.inject(SLOT as never, legacyCallback as unknown as Parameters<SlotRegistry['inject']>[1])
      },
    })
    try {
      await legacy
      expect(entries(slots)).toHaveLength(1)
      await owner.dispose()
      await Promise.resolve()
      expect(entries(slots)).toHaveLength(0) // core cascade alone hides the leak
      const before = mutations
      const unrelated = declarationOwner(ctx, false)
      await unrelated
      await Promise.resolve()
      // Even with the declaration gone, the discarded listener is still live.
      expect(mutations).toBeGreaterThan(before)
      await unrelated.dispose()
    } finally {
      unsubscribe()
      await legacy.dispose()
    }
  })
})
