/**
 * Show durable Codex-native compaction checkpoints as one status label.
 *
 * The persisted checkpoint stays untouched: this shadows the two stock Chat
 * cells and delegates to their components with a projected Node. Ordinary or
 * malformed summaries pass through by reference.
 */

import { createElement } from 'react'
import type { ComponentType, ReactNode } from 'react'

const MARKER_OPEN = '<dsh-openai-codex-compaction-4f5cf1b7-v1>'
const MARKER_CLOSE = '</dsh-openai-codex-compaction-4f5cf1b7-v1>'
const SLOT = 'conversation.chat.node'
const TITLE_KEYS = new Set(['message.compaction', 'message.compaction.commandTitle'])

/** The stock Chat cells carrying compaction checkpoints. */
export const NATIVE_COMPACTION_SLOT_KEYS = ['compaction', 'manual-compaction'] as const
export type NativeCompactionSlotKey = (typeof NATIVE_COMPACTION_SLOT_KEYS)[number]

interface StockEntry {
  component: unknown
  options?: { key?: string; priority?: number }
  inject?: unknown
  children?: unknown
  store?: unknown
  locale?: string
}

interface SlotService {
  inject(key: string, callback: () => () => void): () => void
  entries(key: string): readonly StockEntry[]
  subscribe(key: string, listener: () => void): () => void
  register(options: Record<string, unknown>, component: ComponentType<Record<string, unknown>>): () => void
}

type Translate = (key: string, params?: Record<string, unknown>) => string

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>) : undefined
}

/** True only for text that is exactly a complete valid v1 checkpoint. */
export function isNativeCompactionSummary(summary: unknown): boolean {
  if (typeof summary !== 'string') return false
  const text = summary.trim()
  if (!text.startsWith(MARKER_OPEN) || !text.endsWith(MARKER_CLOSE)) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(MARKER_OPEN.length, -MARKER_CLOSE.length))
  } catch {
    return false
  }
  return Array.isArray(parsed) && parsed.some(item => record(item)?.['type'] === 'compaction')
}

/** Replace the opaque summary with `label`; non-native nodes stay by reference. */
export function projectNativeCompactionNode(
  node: unknown,
  key: NativeCompactionSlotKey,
  label: string
): unknown {
  const chatNode = record(node)
  const data = record(chatNode?.['data'])
  if (chatNode === undefined || data === undefined) return node
  if (key === 'compaction') {
    if (!isNativeCompactionSummary(data['summary'])) return node
    return { ...chatNode, data: { ...data, summary: label } }
  }
  const compaction = record(data['compaction'])
  if (compaction === undefined || !isNativeCompactionSummary(compaction['summary'])) return node
  return { ...chatNode, data: { ...data, compaction: { ...compaction, summary: label } } }
}

function withNativeTitle(stockTranslate: unknown, label: string): Translate | undefined {
  if (typeof stockTranslate !== 'function') return undefined
  const translate = stockTranslate as Translate
  return (key, params) => TITLE_KEYS.has(key) ? label : translate(key, params)
}

function priorityOf(entry: StockEntry): number {
  return typeof entry.options?.priority === 'number' ? entry.options.priority : 0
}

function isDelegableStock(entry: StockEntry, key: string): boolean {
  return entry.options?.key === key && entry.inject === undefined &&
    entry.children === undefined && entry.store === undefined &&
    entry.component !== undefined && entry.component !== null
}

/**
 * Wait for each stock cell, then register one delegating wrapper at
 * `stockPriority - 1` and stop listening. Children/store/inject-bearing stock
 * entries are never shadowed.
 * @param slots - public Slot service.
 * @param labelSource - localized label or render-time getter.
 * @returns disposer removing wrappers and pending listeners.
 */
export function installNativeCompactionPresentation(
  slots: SlotService,
  labelSource: string | (() => string)
): () => void {
  const resolveLabel = (): string =>
    typeof labelSource === 'function' ? labelSource() : labelSource
  const disposers: Array<() => void> = []

  for (const key of NATIVE_COMPACTION_SLOT_KEYS) {
    disposers.push(slots.inject(SLOT, () => {
      let disposed = false
      let installing = false
      let installed: (() => void) | undefined
      let unsubscribe: (() => void) | undefined

      const stopListening = (): void => {
        unsubscribe?.()
        unsubscribe = undefined
      }

      const install = (): void => {
        if (disposed || installing || installed !== undefined) return
        // Pick the cell's current winner first: wrapping a higher-priority
        // inactive entry would bypass that winner's render contract.
        const stock = slots.entries(SLOT)
          .filter(entry => entry.options?.key === key)
          .sort((left, right) => priorityOf(left) - priorityOf(right))[0]
        if (stock === undefined || !isDelegableStock(stock, key)) return
        const component: ComponentType<Record<string, unknown>> = props => {
          const label = resolveLabel()
          const projected = projectNativeCompactionNode(props['node'], key, label)
          if (projected === props['node']) {
            return createElement(stock.component as ComponentType<Record<string, unknown>>, props)
          }
          const t = withNativeTitle(props['t'], label)
          return createElement(stock.component as ComponentType<Record<string, unknown>>, {
            ...props,
            node: projected,
            ...(t === undefined ? {} : { t }),
          })
        }
        installing = true
        let dispose: () => void
        try {
          dispose = slots.register({
            name: SLOT,
            key,
            priority: priorityOf(stock) - 1,
            ...(stock.locale === undefined ? {} : { locale: stock.locale }),
          }, component)
        } finally {
          installing = false
        }
        if (disposed) {
          dispose()
          return
        }
        installed = dispose
        stopListening()
      }

      install()
      if (installed === undefined && !disposed) {
        unsubscribe = slots.subscribe(SLOT, install)
      }

      return () => {
        disposed = true
        stopListening()
        installed?.()
        installed = undefined
      }
    }))
  }

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
