// @vitest-environment jsdom

import { createElement, memo } from 'react'
import type { ComponentType, ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  installNativeCompactionPresentation,
  isNativeCompactionSummary,
  projectNativeCompactionNode,
} from '../src/client/NativeCompactionPresentation.tsx'

const MARKER_OPEN = '<dsh-openai-codex-compaction-4f5cf1b7-v1>'
const MARKER_CLOSE = '</dsh-openai-codex-compaction-4f5cf1b7-v1>'
const LABEL = '已使用Codex远程压缩'

function nativeMarker(extra = ''): string {
  const output = [
    { role: 'user', content: [{ type: 'input_text', text: 'keep' }] },
    { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque' },
  ]
  return `${MARKER_OPEN}${extra}${JSON.stringify(output)}${MARKER_CLOSE}`
}

interface StoredEntryLike {
  component: unknown
  options?: { key?: string; priority?: number; locale?: string }
  inject?: unknown
  children?: unknown
  store?: unknown
  locale?: string
}

type Translate = (key: string, params?: Record<string, unknown>) => string

interface RegisteredEntry {
  options: Record<string, unknown>
  component: (props: Record<string, unknown>) => ReactNode
  dispose(): void
}

/** Minimal public-Slot service used to exercise the facade behavior. */
class FakeSlots {
  rawEntries: StoredEntryLike[] = []
  readonly registered: RegisteredEntry[] = []
  readonly injections: Array<() => void> = []
  private readonly listeners = new Set<() => void>()

  inject(_key: string, callback: () => () => void): () => void {
    return callback()
  }

  register(
    options: Record<string, unknown>,
    component: (props: Record<string, unknown>) => ReactNode
  ): () => void {
    const entry: StoredEntryLike = {
      component,
      options: options as NonNullable<StoredEntryLike['options']>,
      ...(typeof options['locale'] === 'string' ? { locale: options['locale'] } : {}),
    }
    this.rawEntries.push(entry)
    const registered: RegisteredEntry = {
      options,
      component,
      dispose: () => {
        const index = this.rawEntries.indexOf(entry)
        if (index >= 0) this.rawEntries.splice(index, 1)
        this.emit()
      },
    }
    this.registered.push(registered)
    this.emit()
    return registered.dispose
  }

  entries(key: string): readonly StoredEntryLike[] {
    return this.rawEntries
  }

  entriesOfSlot(_key: string): readonly StoredEntryLike[] {
    const winners = new Map<string, StoredEntryLike>()
    const sorted = [...this.rawEntries].sort((left, right) => (
      (left.options?.priority ?? 0) - (right.options?.priority ?? 0)
    ))
    for (const entry of sorted) {
      const cell = entry.options?.key ?? ''
      if (!winners.has(cell)) winners.set(cell, entry)
    }
    return [...winners.values()]
  }

  subscribe(_key: string, listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  addStock(stock: StoredEntryLike): void {
    this.rawEntries.push(stock)
    this.emit()
  }

  emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

function install(fake: FakeSlots, label: string | (() => string)): () => void {
  return installNativeCompactionPresentation(fake as never, label)
}

function wrapperFor(fake: FakeSlots, key: string): RegisteredEntry {
  const wrapper = fake.registered.find(entry => entry.options['key'] === key)
  if (wrapper === undefined) throw new Error(`no wrapper for ${key}`)
  return wrapper
}

function renderWrapper(
  wrapper: RegisteredEntry,
  props: Record<string, unknown>
): string {
  return renderToStaticMarkup(createElement(wrapper.component, props))
}

describe('native compaction summary recognition', () => {
  it('accepts only a complete valid v1 marker carrying a compaction item', () => {
    expect(isNativeCompactionSummary(nativeMarker())).toBe(true)
    expect(isNativeCompactionSummary(`\n  ${nativeMarker()}  \n`)).toBe(true)

    expect(isNativeCompactionSummary('ordinary Harness summary')).toBe(false)
    expect(isNativeCompactionSummary(undefined)).toBe(false)
    expect(isNativeCompactionSummary(42)).toBe(false)
    expect(isNativeCompactionSummary(`${MARKER_OPEN}{"broken"`)).toBe(false)
    expect(isNativeCompactionSummary(`${MARKER_OPEN}[]${MARKER_CLOSE}`)).toBe(false)
    expect(isNativeCompactionSummary(
      `${MARKER_OPEN}[{"type":"message"}]${MARKER_CLOSE}`
    )).toBe(false)
    expect(isNativeCompactionSummary(
      `prefix ${nativeMarker()} suffix`
    )).toBe(false)
    expect(isNativeCompactionSummary(
      `${nativeMarker()}${nativeMarker()}`
    )).toBe(false)
  })
})

describe('native compaction node projection', () => {
  const marker = nativeMarker()

  it('projects automatic compaction data and keeps every other reference', () => {
    const data = { seq: 7, summary: marker, shadowedItemCount: 3 }
    const node = { kind: 'compaction', seq: 7, data }
    const projected = projectNativeCompactionNode(node, 'compaction', LABEL) as {
      data: Record<string, unknown>
    }

    expect(projected).not.toBe(node)
    expect(projected.data).not.toBe(data)
    expect(projected.data['summary']).toBe(LABEL)
    expect(projected.data['shadowedItemCount']).toBe(3)
    expect((projected as Record<string, unknown>)['seq']).toBe(7)
    expect(data.summary).toBe(marker)
  })

  it('projects the manual compaction item and preserves the command payload', () => {
    const command = { seq: 5, command: 'compact' }
    const compaction = { seq: 6, summary: marker, shadowedItemCount: 2 }
    const data = { command, compaction }
    const node = { kind: 'manual-compaction', data }
    const projected = projectNativeCompactionNode(node, 'manual-compaction', LABEL) as {
      data: { command: unknown; compaction: Record<string, unknown> }
    }

    expect(projected.data).not.toBe(data)
    expect(projected.data.command).toBe(command)
    expect(projected.data.compaction).not.toBe(compaction)
    expect(projected.data.compaction['summary']).toBe(LABEL)
    expect(compaction.summary).toBe(marker)
  })

  it('returns ordinary and malformed nodes unchanged', () => {
    const ordinary = { kind: 'compaction', data: { summary: 'ordinary summary' } }
    expect(projectNativeCompactionNode(ordinary, 'compaction', LABEL)).toBe(ordinary)

    const malformed = { kind: 'compaction', data: { summary: `${MARKER_OPEN}{}` } }
    expect(projectNativeCompactionNode(malformed, 'compaction', LABEL)).toBe(malformed)

    const manualNull = { kind: 'manual-compaction', data: { command: {}, compaction: null } }
    expect(projectNativeCompactionNode(manualNull, 'manual-compaction', LABEL)).toBe(manualNull)
  })
})

describe('native compaction presentation registration', () => {
  it('shadows both stock cells, delegates memo components, and localizes only titles', () => {
    const autoSeen: Array<Record<string, unknown>> = []
    const manualSeen: Array<Record<string, unknown>> = []
    const AutoStock = memo((props: Record<string, unknown>) => {
      autoSeen.push(props)
      const t = props['t'] as Translate | undefined
      const node = props['node'] as { data: { summary?: unknown } }
      return createElement('div', { 'data-stock': 'auto' },
        `${t?.( 'message.compaction') ?? ''}|${String(node.data.summary ?? '')}`)
    })
    const ManualStock = memo((props: Record<string, unknown>) => {
      manualSeen.push(props)
      const t = props['t'] as Translate | undefined
      const node = props['node'] as { data: { compaction: { summary?: unknown } } }
      return createElement('div', { 'data-stock': 'manual' },
        `${t?.('message.compaction.commandTitle') ?? ''}|${String(node.data.compaction.summary ?? '')}`)
    })
    const fake = new FakeSlots()
    fake.rawEntries.push(
      { component: AutoStock, options: { key: 'compaction' }, locale: 'chat' },
      { component: ManualStock, options: { key: 'manual-compaction' }, locale: 'chat' }
    )
    const chatT: Translate = (key, params) => (
      key === 'message.compaction.completed'
        ? `completed:${String(params?.['items'])}`
        : `chat:${key}`
    )
    const dispose = install(fake, LABEL)

    const wrapperOptions = fake.registered.map(entry => entry.options)
    expect(wrapperOptions).toEqual([
      { name: 'conversation.chat.node', key: 'compaction', priority: -1, locale: 'chat' },
      { name: 'conversation.chat.node', key: 'manual-compaction', priority: -1, locale: 'chat' },
    ])
    expect(fake.registered).toHaveLength(2)
    expect(fake.entriesOfSlot('conversation.chat.node').map(entry => entry.options?.key))
      .toEqual(['compaction', 'manual-compaction'])
    fake.emit()
    expect(fake.registered).toHaveLength(2)

    const marker = nativeMarker()
    const autoNode = { kind: 'compaction', data: { summary: marker } }
    const autoMarkup = renderWrapper(wrapperFor(fake, 'compaction'), { node: autoNode, t: chatT, extra: 'kept' })
    const autoProps = autoSeen.at(-1)
    expect(autoProps?.['extra']).toBe('kept')
    expect(autoProps?.['node']).not.toBe(autoNode)
    expect((autoProps?.['node'] as { data: { summary: string } }).data.summary).toBe(LABEL)
    const autoT = autoProps?.['t'] as Translate
    expect(autoT('message.compaction')).toBe(LABEL)
    expect(autoT('message.compaction.commandTitle')).toBe(LABEL)
    expect(autoT('message.compaction.completed', { items: 3 })).toBe('completed:3')
    expect(autoT('unrelated.key')).toBe('chat:unrelated.key')
    expect(autoMarkup).toContain(LABEL)
    expect(autoMarkup).not.toContain(MARKER_OPEN)
    expect(autoMarkup).not.toContain('encrypted_content')
    expect(autoMarkup).not.toContain('opaque')
    expect(autoNode.data.summary).toBe(marker)

    const command = { command: 'compact' }
    const manualNode = {
      kind: 'manual-compaction',
      data: { command, compaction: { summary: marker } },
    }
    const manualMarkup = renderWrapper(wrapperFor(fake, 'manual-compaction'), { node: manualNode, t: chatT })
    const manualProps = manualSeen.at(-1)
    const projected = manualProps?.['node'] as {
      data: { command: unknown; compaction: { summary: string } }
    }
    expect(projected.data.command).toBe(command)
    expect(projected.data.compaction.summary).toBe(LABEL)
    expect(manualProps?.['t']).not.toBe(chatT)
    expect(manualMarkup).toContain(LABEL)
    expect(manualMarkup).not.toContain(MARKER_OPEN)
    expect(manualMarkup).not.toContain('encrypted_content')
    expect(manualMarkup).not.toContain('opaque')
    expect(manualNode.data.compaction.summary).toBe(marker)

    dispose()
    expect(fake.registered).toHaveLength(2)
    expect(fake.rawEntries).toHaveLength(2)
  })

  it('passes ordinary summaries and their props through untouched', () => {
    const seen: Array<Record<string, unknown>> = []
    const Stock = (props: Record<string, unknown>): ReactElement => {
      seen.push(props)
      return createElement('div', null, 'stock')
    }
    const fake = new FakeSlots()
    fake.rawEntries.push({ component: Stock, options: { key: 'compaction' }, locale: 'chat' })
    const chatT: Translate = key => `chat:${key}`
    const dispose = install(fake, LABEL)
    const ordinary = { kind: 'compaction', data: { summary: 'ordinary summary' } }

    renderWrapper(wrapperFor(fake, 'compaction'), { node: ordinary, t: chatT })

    expect(seen.at(-1)?.['node']).toBe(ordinary)
    expect(seen.at(-1)?.['t']).toBe(chatT)
    dispose()
  })

  it('does not shadow stock entries that declare inject, children, or store', () => {
    for (const extra of [
      { inject: () => ({}) },
      { children: { 'conversation.chat.node': { kind: 'single', scope: 'session' } } },
      { store: { handle: 'chat' } },
    ]) {
      const fake = new FakeSlots()
      fake.rawEntries.push({
        component: memo(() => createElement('div', null, 'stock')),
        options: { key: 'compaction' },
        ...extra,
      })
      const dispose = install(fake, LABEL)
      expect(fake.registered).toHaveLength(0)
      expect(fake.rawEntries).toHaveLength(1)
      dispose()
    }
  })

  it('does not shadow a higher-priority inactive entry when the winner needs extra wiring', () => {
    const fake = new FakeSlots()
    fake.rawEntries.push(
      {
        component: memo(() => createElement('div', null, 'winner')),
        options: { key: 'compaction', priority: 1 },
        inject: () => ({ hooks: {} }),
      },
      {
        component: memo(() => createElement('div', null, 'inactive')),
        options: { key: 'compaction', priority: 3 },
      }
    )
    const dispose = install(fake, LABEL)

    expect(fake.registered).toHaveLength(0)
    expect(fake.rawEntries).toHaveLength(2)
    dispose()
  })

  it('wins its cell at stockPriority - 1 and never re-registers on later changes', () => {
    const fake = new FakeSlots()
    fake.rawEntries.push({
      component: memo(() => createElement('div', null, 'stock')),
      options: { key: 'compaction', priority: 5 },
      locale: 'chat',
    })
    const dispose = install(fake, LABEL)

    expect(fake.registered).toHaveLength(1)
    expect(fake.registered[0]?.options).toMatchObject({ key: 'compaction', priority: 4 })
    expect(fake.entriesOfSlot('conversation.chat.node').map(entry => entry.options?.priority))
      .toEqual([4])

    fake.emit()
    expect(fake.registered).toHaveLength(1)
    dispose()
  })

  it('waits for stock entries that arrive after the declaration and restores on dispose', () => {
    const fake = new FakeSlots()
    const dispose = install(fake, LABEL)
    expect(fake.registered).toHaveLength(0)

    fake.addStock({
      component: memo(() => createElement('div', null, 'stock')),
      options: { key: 'compaction' },
      locale: 'chat',
    })

    const wrapper = wrapperFor(fake, 'compaction')
    expect(fake.rawEntries).toHaveLength(2)
    expect((wrapper.options as Record<string, unknown>)['priority']).toBe(-1)

    dispose()
    expect(fake.registered).toHaveLength(1)
    expect(fake.rawEntries).toHaveLength(1)
    expect(fake.rawEntries[0]?.options?.['key']).toBe('compaction')

    fake.addStock({
      component: memo(() => createElement('div', null, 'late')),
      options: { key: 'manual-compaction' },
      locale: 'chat',
    })
    expect(fake.registered).toHaveLength(1)
  })

  it('projects a component without a locale-provided t and keeps the title untouched', () => {
    const seen: Array<Record<string, unknown>> = []
    const fake = new FakeSlots()
    fake.rawEntries.push({
      component: (props: Record<string, unknown>) => {
        seen.push(props)
        return createElement('div', null, 'stock')
      },
      options: { key: 'compaction' },
    })
    const dispose = install(fake, LABEL)
    const marker = nativeMarker()
    renderWrapper(wrapperFor(fake, 'compaction'), {
      node: { kind: 'compaction', data: { summary: marker } },
    })

    expect(seen.at(-1)?.['node']).toMatchObject({ data: { summary: LABEL } })
    expect(seen.at(-1)?.['t']).toBeUndefined()
    dispose()
  })
})

// Keep a compile-time check that stock components stay React-recognizable.
const _memoType: ComponentType<Record<string, unknown>> = memo(() => null)
void _memoType
