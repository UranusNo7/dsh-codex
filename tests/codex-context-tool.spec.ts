import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import {
  CODEX_CONTEXT_PROVIDER,
  CodexContextController,
  type CodexContextAgent,
  type CodexContextEvent,
} from '../src/codex-context.ts'
import {
  CODEX_CONTEXT_GUIDANCE,
  CODEX_CONTEXT_SECTION_NAME,
  CODEX_CONTEXT_TOOL_NAME,
  codexContextTool,
  installCodexContextTools,
  type CodexContextAgentRuntime,
  type CodexContextInstallHost,
} from '../src/codex-context-tool.ts'

const HISTORY: readonly CodexContextEvent[] = [
  { seq: 1, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
  {
    seq: 2,
    type: 'tool/result',
    data: { message: { role: 'tool', content: [{ type: 'text', text: 'ok' }] } },
  },
]

function agent(overrides: Partial<CodexContextAgent> = {}): CodexContextAgent {
  return {
    id: 'session-1',
    session: {
      id: 'session-1',
      requestHeader: () => ({ config: { provider: CODEX_CONTEXT_PROVIDER } }),
    },
    options: { provider: CODEX_CONTEXT_PROVIDER },
    ...overrides,
  }
}

interface ControllerOptions {
  readonly boundary?: { openTurnStartSeq: number | null; lastTurn: number } | null
  readonly history?: readonly CodexContextEvent[] | undefined
  readonly resolveCompaction?: () => { compactNow(agent: unknown, signal: AbortSignal): Promise<unknown> }
}

function controller(options: ControllerOptions = {}): CodexContextController {
  const boundary =
    options.boundary === undefined ? { openTurnStartSeq: 5, lastTurn: 1 } : options.boundary
  return new CodexContextController({
    resolveCompaction: options.resolveCompaction ?? (() => ({ compactNow: async () => undefined })),
    takeoverDeclared: () => false,
    ...(boundary === null ? {} : { resolveSourceTurn: () => boundary }),
    ...(options.history === undefined
      ? {}
      : {
          readHistory: async () => ({
            events: options.history ?? [],
            endSeq: (options.history ?? []).length + 1,
          }),
        }),
  })
}

type ToolExec = Parameters<ToolDefinition['execute']>[1]

function exec(agentValue: CodexContextAgent | undefined): ToolExec {
  return { agent: agentValue, signal: new AbortController().signal } as unknown as ToolExec
}

async function run(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  agentValue: CodexContextAgent | undefined = agent(),
): Promise<Record<string, unknown>> {
  return (await tool.execute(args as never, exec(agentValue))) as Record<string, unknown>
}

interface SourceStub {
  on(event: string, listener: (payload: never) => void): () => void
  emit(event: string, ...args: unknown[]): void
}

function sourceStub(): SourceStub {
  const listeners = new Map<string, Set<(payload: never) => void>>()
  return {
    on(event, listener) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => set.delete(listener)
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) {
        ;(listener as (...values: unknown[]) => void)(...args)
      }
    },
  }
}

function finishTurn(source: SourceStub, target: CodexContextAgent): void {
  source.emit(
    'session/event',
    { id: target.id },
    { seq: 9, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  )
  source.emit('agent/status', { agent: target, status: 'idle' })
}

describe('codex_context tool definition', () => {
  it('exposes the three actions and no session-id parameter', () => {
    const tool = codexContextTool(controller())
    expect(tool.name).toBe(CODEX_CONTEXT_TOOL_NAME)
    const parameters = tool.parameters as {
      properties?: Record<string, unknown>
      required?: readonly string[]
    }
    expect(Object.keys(parameters.properties ?? {}).sort()).toEqual([
      'action',
      'from_seq',
      'limit',
      'query',
      'to_seq',
    ])
    const action = parameters.properties?.['action'] as { enum?: string[] }
    expect(parameters.required).toContain('action')
    expect(action.enum).toEqual(['status', 'request_compaction', 'recall'])
    expect(parameters.properties?.['sessionId']).toBeUndefined()
  })

  it('keeps the prompt guidance to one short line without restating the schema', () => {
    expect(CODEX_CONTEXT_GUIDANCE.length).toBeLessThan(220)
    expect(CODEX_CONTEXT_GUIDANCE).toContain('request_compaction')
    expect(CODEX_CONTEXT_GUIDANCE.split('. ').length).toBeLessThanOrEqual(2)
    expect(CODEX_CONTEXT_GUIDANCE).not.toContain('from_seq')
    expect(CODEX_CONTEXT_GUIDANCE).not.toContain('limit')
  })

  it('adds a bounded first-turn prompt cost for one tool (local estimate)', async () => {
    const context = new Context()
    await context.plugin(SystemPrompt)
    await context.plugin(ToolRuntime)
    await context.plugin(NativeToolExecutor)
    try {
      const before = JSON.stringify(context.tools.schemas()).length
      context.tools.register(codexContextTool(controller()))
      const after = JSON.stringify(context.tools.schemas()).length
      const addedCharacters = after - before
      expect(addedCharacters).toBeGreaterThan(0)
      const estimatedTokens = Math.ceil(addedCharacters / 4)
      expect(estimatedTokens).toBeLessThan(1_200)
    } finally {
      await context.fiber.dispose()
    }
  })

  it('refuses every action without an agent', async () => {
    const tool = codexContextTool(controller())
    for (const action of ['status', 'request_compaction', 'recall']) {
      const value = (await tool.execute({ action } as never, {} as ToolExec)) as Record<
        string,
        unknown
      >
      expect(value).toMatchObject({ ok: false, reason: 'no-agent' })
    }
  })

  it('refuses every action for an Agent that is not Codex-routed', async () => {
    const tool = codexContextTool(controller())
    const other = agent({
      session: { requestHeader: () => ({ config: { provider: 'anthropic' } }) },
      options: { provider: 'anthropic' },
    })
    for (const action of ['status', 'request_compaction', 'recall']) {
      expect(await run(tool, { action }, other)).toMatchObject({
        ok: false,
        reason: 'provider',
      })
    }
  })
})

describe('codex_context tool actions', () => {
  it('reports owner facts for status', async () => {
    const tool = codexContextTool(controller())
    const value = await run(tool, { action: 'status' })
    expect(value).toMatchObject({
      action: 'status',
      ok: true,
      owner: { state: 'available', evidence: ['agent-scoped-compaction-service-present'] },
    })
    expect(value['queued']).toBeUndefined()
    expect(value['last_outcome']).toBeUndefined()
  })

  it('returns a queued ticket without starting compaction', async () => {
    const compactNow = vi.fn(async () => undefined)
    const instance = controller({ resolveCompaction: () => ({ compactNow }) })
    const target = agent()
    const tool = codexContextTool(instance)
    const value = await run(tool, { action: 'request_compaction' }, target)
    expect(value).toMatchObject({
      action: 'request_compaction',
      ok: true,
      queued: { status: 'queued', boundary: 'after-current-turn' },
    })
    expect(compactNow).not.toHaveBeenCalled()
    const duplicate = await run(tool, { action: 'request_compaction' }, target)
    expect(duplicate).toMatchObject({ ok: true, already_queued: true })
  })

  it('reports an owner refusal instead of pretending to queue', async () => {
    const tool = codexContextTool(
      new CodexContextController({
        resolveCompaction: () => undefined,
        takeoverDeclared: () => false,
        resolveSourceTurn: () => ({ openTurnStartSeq: 5, lastTurn: 1 }),
      }),
    )
    expect(await run(tool, { action: 'request_compaction' })).toMatchObject({
      ok: false,
      reason: 'owner',
      owner: { state: 'unavailable' },
    })
  })

  it('reports a sanitized last outcome after the boundary runs', async () => {
    const target = agent()
    const source = sourceStub()
    const instance = new CodexContextController({
      resolveCompaction: () => ({
        async compactNow() {
          throw Object.assign(new Error('raw body'), { code: 'summary' })
        },
      }),
      takeoverDeclared: () => false,
      resolveSourceTurn: () => ({ openTurnStartSeq: 5, lastTurn: 1 }),
    })
    instance.attach(source as never)
    const tool = codexContextTool(instance)
    await run(tool, { action: 'request_compaction' }, target)
    finishTurn(source, target)
    await vi.waitFor(() => expect(instance.snapshot(target).lastOutcome).toBeDefined())
    const value = await run(tool, { action: 'status' }, target)
    expect(value['last_outcome']).toMatchObject({ state: 'failed', reason: 'summary' })
    expect(JSON.stringify(value)).not.toContain('raw body')
  })

  it('recalls bounded events through the read-only history port', async () => {
    const tool = codexContextTool(controller({ history: HISTORY }))
    const value = await run(tool, { action: 'recall', limit: 5 })
    expect(value).toMatchObject({
      action: 'recall',
      ok: true,
      recall: { fromSeq: 0, toSeqExclusive: 3, scanned: 2, truncated: false },
    })
    const recall = value['recall'] as { items: Array<Record<string, unknown>> }
    expect(recall.items).toEqual([
      { seq: 1, type: 'user/message', kind: 'message', role: 'user', text: 'hi' },
      { seq: 2, type: 'tool/result', kind: 'tool-result', role: 'tool', text: 'ok' },
    ])
  })

  it('reports no-session and history-unavailable explicitly', async () => {
    const noSessionAgent = agent()
    delete (noSessionAgent as { session?: unknown }).session
    const tool = codexContextTool(controller())
    expect(await run(tool, { action: 'recall' }, noSessionAgent)).toMatchObject({
      ok: false,
      reason: 'no-session',
    })
    expect(await run(tool, { action: 'recall' })).toMatchObject({
      ok: false,
      reason: 'history-unavailable',
    })
  })
})

describe('tool execution signal (probe)', () => {
  it('records whether exec.signal aborts after a normally completed tool', async () => {
    const context = new Context()
    await context.plugin(SystemPrompt)
    await context.plugin(ToolRuntime)
    await context.plugin(NativeToolExecutor)
    try {
      let seen: AbortSignal | undefined
      context.tools.register(
        defineTool({
          name: 'codex_context_signal_probe',
          description: 'Probe the tool execution signal.',
          parameters: {},
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: { aborted: { type: 'boolean', required: true } },
            },
            render: () => [],
          },
          async execute(_args, exec) {
            seen = exec.signal
            return { aborted: exec.signal.aborted }
          },
        }),
      )
      const batch = await context.tools.execute({
        calls: [{
          type: 'tool-call',
          id: ToolCallId('probe-call'),
          name: 'codex_context_signal_probe',
          arguments: JSON.stringify({}),
        }],
        signal: new AbortController().signal,
      })
      const result = batch.results[0]!.result
      expect(result.isError).toBe(false)
      expect(seen).toBeDefined()
      // Observed on this Harness: a normally completed tool leaves the signal
      // un-aborted, so it cannot serve as a turn-cancellation latch.
      expect(seen?.aborted).toBe(false)
    } finally {
      await context.fiber.dispose()
    }
  })
})

interface HostStub {
  readonly host: CodexContextInstallHost
  emit(event: string, ...args: unknown[]): void
  agents: CodexContextAgent[]
}

function host(agents: CodexContextAgent[]): HostStub {
  const emitter = sourceStub()
  return {
    agents,
    host: {
      agents: { list: () => agents },
      on: emitter.on,
    } as unknown as CodexContextInstallHost,
    emit: emitter.emit,
  }
}

interface RuntimeRecord {
  readonly tools: string[]
  readonly sections: string[]
}

function runtimeAgent(
  id: string,
  provider: { value: string | undefined },
  record: RuntimeRecord,
): CodexContextAgentRuntime {
  const shape = agent({
    id,
    session: {
      id,
      requestHeader: () =>
        provider.value === undefined ? undefined : { config: { provider: provider.value } },
    },
    options: {},
  })
  return Object.assign(shape, {
    ctx: {
      tools: {
        register(definition: ToolDefinition) {
          record.tools.push(definition.name)
          return () => {
            record.tools.push(`dispose:${definition.name}`)
          }
        },
      },
      systemPrompt: {
        section(section: { name: string; order: number; text: string }) {
          expect(section.order).toBe(900)
          expect(section.text).toBe(CODEX_CONTEXT_GUIDANCE)
          record.sections.push(section.name)
          return () => {
            record.sections.push(`dispose:${section.name}`)
          }
        },
      },
    },
  }) as CodexContextAgentRuntime
}

describe('installCodexContextTools', () => {
  it('installs the tool and prompt rule only into Codex-routed Agents', () => {
    const record: RuntimeRecord = { tools: [], sections: [] }
    const codex = runtimeAgent('session-codex', { value: CODEX_CONTEXT_PROVIDER }, record)
    const other = runtimeAgent('session-other', { value: 'anthropic' }, record)
    const stub = host([codex, other])
    const dispose = installCodexContextTools(stub.host, controller())
    expect(record.tools).toEqual([CODEX_CONTEXT_TOOL_NAME])
    expect(record.sections).toEqual([CODEX_CONTEXT_SECTION_NAME])
    dispose()
    expect(record.tools).toEqual([CODEX_CONTEXT_TOOL_NAME, `dispose:${CODEX_CONTEXT_TOOL_NAME}`])
    expect(record.sections).toContain(`dispose:${CODEX_CONTEXT_SECTION_NAME}`)
  })

  it('uninstalls on a provider switch and reinstalls when it switches back', () => {
    const record: RuntimeRecord = { tools: [], sections: [] }
    const provider = { value: CODEX_CONTEXT_PROVIDER }
    const target = runtimeAgent('session-1', provider, record)
    const stub = host([target])
    const dispose = installCodexContextTools(stub.host, controller())
    expect(record.tools).toEqual([CODEX_CONTEXT_TOOL_NAME])

    provider.value = 'anthropic'
    stub.emit('session/event', { id: 'session-1' }, {
      type: 'request/header',
      data: { header: { config: { provider: 'anthropic' } } },
    })
    expect(record.tools).toContain(`dispose:${CODEX_CONTEXT_TOOL_NAME}`)

    provider.value = CODEX_CONTEXT_PROVIDER
    stub.emit('session/event', { id: 'session-1' }, {
      type: 'request/header',
      data: { header: { config: { provider: CODEX_CONTEXT_PROVIDER } } },
    })
    expect(record.tools.filter((name) => name === CODEX_CONTEXT_TOOL_NAME)).toHaveLength(2)
    dispose()
  })

  it('refuses execute when the verified route is no longer Codex', async () => {
    const tool = codexContextTool(controller(), () => 'anthropic')
    for (const action of ['status', 'request_compaction', 'recall']) {
      expect(await run(tool, { action }, agent())).toMatchObject({
        ok: false,
        reason: 'provider',
      })
    }
  })

  it('keeps the definition for the switching turn, then uninstalls at the verified request', async () => {
    const record: RuntimeRecord = { tools: [], sections: [] }
    const provider = { value: CODEX_CONTEXT_PROVIDER }
    const target = runtimeAgent('session-1', provider, record)
    const stub = host([target])
    const dispose = installCodexContextTools(stub.host, controller())
    expect(record.tools).toEqual([CODEX_CONTEXT_TOOL_NAME])

    provider.value = 'anthropic'
    expect(record.tools).toEqual([CODEX_CONTEXT_TOOL_NAME])

    stub.emit('agent/request', { agent: target }, async () => ({ provider: 'anthropic' }))
    await vi.waitFor(() => expect(record.tools).toContain(`dispose:${CODEX_CONTEXT_TOOL_NAME}`))
    expect(record.sections).toContain(`dispose:${CODEX_CONTEXT_SECTION_NAME}`)
    dispose()
  })

  it('installs for a later Agent and removes one that is disposed', () => {
    const record: RuntimeRecord = { tools: [], sections: [] }
    const stub = host([])
    const dispose = installCodexContextTools(stub.host, controller())
    expect(record.tools).toEqual([])

    const late = runtimeAgent('session-late', { value: CODEX_CONTEXT_PROVIDER }, record)
    stub.agents.push(late)
    stub.emit('agent/created', { agent: late })
    expect(record.tools).toEqual([CODEX_CONTEXT_TOOL_NAME])

    stub.agents.length = 0
    stub.emit('agent/disposed', { agent: late })
    expect(record.tools).toContain(`dispose:${CODEX_CONTEXT_TOOL_NAME}`)
    dispose()
  })
})
