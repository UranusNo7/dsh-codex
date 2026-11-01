import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import {
  LlmAdapter,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRuntime from '@deepseek-ai/dsh-session-projection'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolsRuntime from '@deepseek-ai/dsh-tools'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import {
  CompactionDiagnostics,
  foldCompactionEvents,
  readCompactionSnapshot,
} from '../src/compaction-diagnostics.ts'
import { CodexContextController } from '../src/codex-context.ts'
import { codexContextTool, installCodexContextTools } from '../src/codex-context-tool.ts'

/**
 * Real driver ordering for idle-only manual compaction.
 *
 * This composition is the Harness's own agent loop (`dsh-agent-loop`, which
 * owns `agent/status` and the turn lifecycle) plus the real compaction backend.
 * Only the model route is scripted (`LlmAdapter`): the point of this file is
 * driver ordering, not provider behavior.
 *
 * Version caveat: workspace pins the 0.2.0-rc.1 family; the installed Desktop
 * runtime is 0.2.1-rc.5. This is a protocol test, not a target-machine E2E.
 */

const PROVIDER = 'openai-codex'
const MODEL = 'scripted-1'

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.unstubAllEnvs()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function textChunk(index: number, text: string): StreamChunk[] {
  return [
    { type: 'block-start', index, blockType: 'text' },
    { type: 'text-delta', index, text },
    { type: 'block-end', index, block: { type: 'text', text } },
  ]
}

function toolCallChunk(index: number, id: string, name: string, args: string): StreamChunk[] {
  return [
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id: id as never, name, argumentsDelta: args },
    { type: 'block-end', index, block: { type: 'tool-call', id: id as never, name, arguments: args } },
  ]
}

function usage(inputTokens: number, outputTokens: number): StreamChunk[] {
  return [{ type: 'usage', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } }]
}

/**
 * One scripted model route: a tool-using turn, a closing turn, and one
 * summarization call. The compaction call is recognized by its call purpose, so
 * the driver sequence stays observable independently of prompt text.
 */
class ScriptedAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  /** Optional hold so a test can observe an in-flight compaction. */
  compactionGate: Promise<void> | undefined
  releaseCompaction: (() => void) | undefined
  /** Tool the scripted first turn asks the driver to run. */
  toolName = 'probe_tool'
  toolArguments = '{"value":"x"}'
  /** Whether the summarization call answers with a visual block (never a valid checkpoint). */
  compactionImage = false
  /** Answer the first conversation call with plain text instead of a tool call. */
  textOnly = false
  /** Model-visible tool names per call, keyed by the routed session id. */
  readonly toolsSeen: Array<{ sessionId: string | undefined; names: string[] }> = []

  providerInfo(provider: string) {
    return { id: provider, name: 'Scripted provider' }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    this.toolsSeen.push({
      sessionId: options.sessionId === undefined ? undefined : String(options.sessionId),
      names: (options.tools ?? []).map(tool => tool.name),
    })
    if (options.purpose === 'compaction') {
      if (this.compactionGate !== undefined) await this.compactionGate
      yield* textChunk(0, 'condensed checkpoint body')
      if (this.compactionImage) {
        yield {
          type: 'block-start',
          index: 1,
          blockType: 'image',
        }
        yield {
          type: 'block-end',
          index: 1,
          block: {
            type: 'image',
            attachment: { id: 'att_probe', mediaType: 'image/png' },
          } as never,
        }
      }
      yield* usage(10, 4)
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const conversationCalls = this.calls.filter(call => call.purpose !== 'compaction')
    if (conversationCalls.length === 1 && !this.textOnly) {
      yield* textChunk(0, `reading the workspace ${'x'.repeat(3_000)}`)
      yield* toolCallChunk(1, 'call_probe|fc_probe', this.toolName, this.toolArguments)
      yield* usage(20, 8)
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield* textChunk(0, 'finished the step')
    yield* usage(21, 5)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function probeTool() {
  return {
    name: 'probe_tool',
    description: 'Probe tool used to prove a durable tool call/result pair.',
    parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object' as const, properties: {}, additionalProperties: false },
      render: () => [{ type: 'text' as const, text: 'ok' }],
    },
    async execute() {
      return {}
    },
  }
}

/**
 * The public `turnBoundary` projection, exactly as the product wiring resolves
 * it: the accepted source turn never comes from a deprecated log scan.
 */
function sourceTurnBoundary(ctx: Context, agent: { readonly session?: unknown }) {
  const projections = (ctx as unknown as { get(name: string): unknown }).get('sessionProjections') as
    | { stateOf(session: unknown, key: string): unknown }
    | undefined
  if (agent.session === undefined || projections === undefined) return undefined
  const boundary = projections.stateOf(agent.session, 'turnBoundary')
  return typeof boundary === 'object' && boundary !== null
    ? (boundary as { openTurnStartSeq: number | null; lastTurn: number })
    : undefined
}

async function waitForOpenTurn(ctx: Context, agent: { readonly session?: unknown }): Promise<void> {
  await waitFor(
    () => (sourceTurnBoundary(ctx, agent)?.openTurnStartSeq ?? null) !== null,
    'open turn boundary projection',
  )
}

function controllerFor(
  ctx: Context,
  phases: string[] = [],
  timeline?: string[],
  options: { readonly cooldownMs?: number } = {},
) {
  return new CodexContextController({
    resolveCompaction: () => ({
      compactNow: (agent, signal) => ctx.compaction.compactNow(agent as never, signal),
    }),
    takeoverDeclared: () => false,
    // Mirrors product index.ts: the projection is the only accepted source turn.
    resolveSourceTurn: (agent) => sourceTurnBoundary(ctx, agent),
    ...options.cooldownMs === undefined ? {} : { cooldownMs: options.cooldownMs },
    onRequestChange: (_sessionId, change) => {
      phases.push(change.phase)
      timeline?.push(`phase:${change.phase}`)
    },
  })
}

function allEvents(session: Session): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let index = 0; index < session.seq; index += 1) {
    const event = session.eventAt(index as never)
    if (event !== undefined) events.push(event)
  }
  return events
}

function eventCount(session: Session, type: string): number {
  return allEvents(session).filter(event => event.type === type).length
}

function eventAt(session: Session, seq: number): SessionEvent {
  const event = session.eventAt(seq as never)
  if (event === undefined) throw new Error(`session event ${seq} is missing`)
  return event
}

async function mount() {
  root = await mkdtemp(join(tmpdir(), 'dsh-codex-driver-'))
  vi.stubEnv('DSH_HOME', root)
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SessionProjectionRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(ToolsRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop)
  await ctx.plugin(BasicCompactionEngine, {
    auto: false,
    summarizationProvider: PROVIDER,
    summarizationModel: MODEL,
  })
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter([PROVIDER], adapter)
  return { ctx, adapter }
}

describe('real driver idle-only compaction ordering', () => {
  it('queues work, reaches durable idle, then compacts after turn/end', async () => {
    const { ctx } = await mount()
    const statuses: string[] = []
    ctx.on('agent/status', ({ status }) => {
      statuses.push(status)
    })
    const tool = {
      name: 'probe_tool',
      description: 'Probe tool used to prove a durable tool call/result pair.',
      parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object' as const, properties: {}, additionalProperties: false },
        render: () => [{ type: 'text' as const, text: 'ok' }],
      },
      async execute() {
        return {}
      },
    }
    ctx.tools.register(tool as never)

    const handle = await ctx.agents.create({
      sessionId: 'agent-compaction-driver' as never,
      meta: { cwd: root as string },
      agentOptions: { provider: PROVIDER, model: MODEL },
    })
    const { agent } = handle
    const session = agent.session

    agent.send(createUserMessage({ content: [{ type: 'text', text: 'run the probe tool' }], source: { kind: 'user' } }), 'next-turn', true)
    // Queued behind the running turn: this must never be reported as success.
    agent.send(createUserMessage({ content: [{ type: 'text', text: 'then summarize' }], source: { kind: 'user' } }), 'next-turn', true)
    await agent.whenIdle()

    const events = allEvents(session)
    const toolCallSeq = events.find(event => event.type === 'tool/call')?.seq
    const toolResultSeq = events.find(event => event.type === 'tool/result')?.seq
    const turnEnds = events.filter(event => event.type === 'turn/end')
    expect(toolCallSeq).toBeDefined()
    expect(toolResultSeq).toBeDefined()
    expect(toolResultSeq as number).toBeGreaterThan(toolCallSeq as number)
    expect(turnEnds.length).toBeGreaterThanOrEqual(2)
    // Durable tool result precedes the turn boundary that released the driver.
    const lastTurnEndSeq = Math.max(...turnEnds.map(event => event.seq))
    expect(toolResultSeq as number).toBeLessThan(lastTurnEndSeq)
    expect(agent.status).toBe('idle')
    expect(statuses.filter(status => status === 'idle').length).toBeGreaterThan(0)

    const result = await ctx.compaction.compactNow(agent, new AbortController().signal)
    expect(result).not.toBeNull()
    if (result === null) return
    const startEvent = eventAt(session, result.startSeq)
    expect(startEvent.type).toBe('compaction/start')
    // Compaction opens only after the last durable turn boundary.
    expect(result.startSeq).toBeGreaterThan(lastTurnEndSeq)
    expect(eventAt(session, result.summarySeq).type).toBe('compaction/summary')
    expect(eventAt(session, result.endSeq).type).toBe('compaction/end')
  })

  it('rejects compaction while a queued turn is still pending', async () => {
    const { ctx } = await mount()
    const tool = {
      name: 'probe_tool',
      description: 'Probe tool used to prove a durable tool call/result pair.',
      parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object' as const, properties: {}, additionalProperties: false },
        render: () => [{ type: 'text' as const, text: 'ok' }],
      },
      async execute() {
        return {}
      },
    }
    ctx.tools.register(tool as never)
    const handle = await ctx.agents.create({
      sessionId: 'agent-compaction-driver-busy' as never,
      meta: { cwd: root as string },
      agentOptions: { provider: PROVIDER, model: MODEL },
    })
    const { agent } = handle

    agent.send(createUserMessage({ content: [{ type: 'text', text: 'run the probe tool' }], source: { kind: 'user' } }), 'next-turn', true)
    agent.send(createUserMessage({ content: [{ type: 'text', text: 'queued follow-up' }], source: { kind: 'user' } }), 'next-turn', true)

    const seqBefore = agent.session.seq
    const failure = await Promise.resolve()
      .then(() => ctx.compaction.compactNow(agent, new AbortController().signal))
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(ManualCompactionError)
    expect((failure as ManualCompactionError).code).toBe('busy')
    // A rejected busy compaction writes nothing, including no compaction marker.
    expect(agent.session.seq).toBe(seqBefore)
    // The queued prompt still runs after the driver reaches idle.
    await agent.whenIdle()
    expect(eventAt(agent.session, agent.session.surface.nodes[0]!).type).toBe('system/message')
    expect(eventCount(agent.session, 'turn/end')).toBeGreaterThanOrEqual(2)
  })

  it('installs the real tool through installCodexContextTools into the Codex agent scope', async () => {
    const { ctx, adapter } = await mount()
    adapter.toolName = 'codex_context'
    adapter.toolArguments = '{"action":"request_compaction"}'
    // A second route proves the installer is Agent-scoped, not global.
    const otherAdapter = new ScriptedAdapter()
    otherAdapter.textOnly = true
    ctx.llm.registerAdapter(['other-route'], otherAdapter)
    const phases: string[] = []
    const controller = controllerFor(ctx, phases)
    const detach = controller.attach(ctx as never)
    // The product installer, not a hand-registered tool.
    const disposeInstall = installCodexContextTools(ctx as never, controller)
    const handle = await ctx.agents.create({
      sessionId: 'agent-codex-tool-idle' as never,
      meta: { cwd: root as string },
      agentOptions: { provider: PROVIDER, model: MODEL },
    })
    const { agent } = handle
    const session = agent.session

    agent.send(createUserMessage({ content: [{ type: 'text', text: 'compact when you are done' }], source: { kind: 'user' } }), 'next-turn', true)
    // The model-called tool returns a queued ticket, not a finished compaction.
    await waitFor(() => eventCount(session, 'tool/result') > 0, 'codex_context tool result')
    const toolResult = allEvents(session).find(event => event.type === 'tool/result')
    const toolPayload = JSON.stringify(toolResult?.data)
    // The tool's own answer is a queued ticket with an after-turn boundary, not a success.
    expect(toolPayload).toContain('queued')
    expect(toolPayload).toContain('after-current-turn')
    expect(toolPayload).not.toContain('"completed"')
    // Agent-scoped registration: the model saw the tool for this Agent only.
    const codexCall = adapter.toolsSeen.find(call => call.sessionId === session.id)
    expect(codexCall?.names).toContain('codex_context')

    await agent.whenIdle()
    await waitFor(() => controller.lastOutcome(agent as never) !== undefined, 'tool-requested idle compaction')
    expect(controller.lastOutcome(agent as never)?.state).toBe('completed')
    expect(phases).toEqual(['queued', 'started', 'completed'])

    const events = allEvents(session)
    const starts = events.filter(event => event.type === 'compaction/start')
    expect(starts).toHaveLength(1)
    const lastTurnEnd = Math.max(...events.filter(event => event.type === 'turn/end').map(event => event.seq))
    // The tool result was durable before the boundary; compaction opens after it.
    const toolResultSeq = events.find(event => event.type === 'tool/result')!.seq
    expect(toolResultSeq).toBeLessThan(lastTurnEnd)
    expect(starts[0]!.seq).toBeGreaterThan(lastTurnEnd)

    // A non-Codex route gets neither the model-visible tool nor a scoped registration.
    const otherHandle = await ctx.agents.create({
      sessionId: 'agent-other-route' as never,
      meta: { cwd: root as string },
      agentOptions: { provider: 'other-route', model: MODEL },
    })
    const otherAgent = otherHandle.agent
    otherAgent.send(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }), 'next-turn', true)
    await otherAgent.whenIdle()
    const otherCall = otherAdapter.toolsSeen.find(call => call.sessionId === otherAgent.session.id)
    expect(otherCall?.names ?? []).not.toContain('codex_context')

    disposeInstall()
    detach()
    await controller.dispose()
  })

  it('runs one tool-requested compaction at the idle boundary', async () => {
    const { ctx } = await mount()
    ctx.tools.register(probeTool() as never)
    const phases: string[] = []
    const controller = controllerFor(ctx, phases)
    const detach = controller.attach(ctx as never)
    const handle = await ctx.agents.create({
      sessionId: 'agent-codex-context-idle' as never,
      meta: { cwd: root as string },
      agentOptions: { provider: PROVIDER, model: MODEL },
    })
    const { agent } = handle
    const session = agent.session

    agent.send(createUserMessage({ content: [{ type: 'text', text: 'run the probe tool' }], source: { kind: 'user' } }), 'next-turn', true)
    await waitForOpenTurn(ctx, agent)

    const request = controller.requestCompaction(agent as never, { callId: 'call_probe|fc_probe' })
    expect(request.status).toBe('queued')
    // A queued receipt is a phase, never a compaction success.
    expect(controller.pending(agent as never)?.status).toBe('queued')
    expect(controller.lastOutcome(agent as never)).toBeUndefined()
    const startsWhileBusy = eventCount(session, 'compaction/start')
    expect(startsWhileBusy).toBe(0)

    await agent.whenIdle()
    await waitFor(() => controller.lastOutcome(agent as never) !== undefined, 'idle compaction outcome')
    const outcome = controller.lastOutcome(agent as never)
    expect(outcome?.state).toBe('completed')
    expect(phases).toEqual(['queued', 'started', 'completed'])

    const events = allEvents(session)
    const compactionStarts = events.filter(event => event.type === 'compaction/start')
    expect(compactionStarts).toHaveLength(1)
    const lastTurnEnd = Math.max(...events.filter(event => event.type === 'turn/end').map(event => event.seq))
    expect(compactionStarts[0]!.seq).toBeGreaterThan(lastTurnEnd)
    detach()
    await controller.dispose()
  })

  it('does not run a queued compaction after the source turn is cancelled', async () => {
    const { ctx } = await mount()
    ctx.tools.register(probeTool() as never)
    const phases: string[] = []
    const controller = controllerFor(ctx, phases)
    const detach = controller.attach(ctx as never)
    const handle = await ctx.agents.create({
      sessionId: 'agent-codex-context-cancelled' as never,
      meta: { cwd: root as string },
      agentOptions: { provider: PROVIDER, model: MODEL },
    })
    const { agent } = handle
    const session = agent.session

    agent.send(createUserMessage({ content: [{ type: 'text', text: 'run the probe tool' }], source: { kind: 'user' } }), 'next-turn', true)
    await waitForOpenTurn(ctx, agent)
    expect(controller.requestCompaction(agent as never).status).toBe('queued')
    // The human cancels this turn without disposing the Agent.
    agent.cancel('user' as never)

    await agent.whenIdle()
    await waitFor(() => controller.lastOutcome(agent as never) !== undefined, 'cancelled outcome')
    // A cancelled (or unverifiable) source turn is never reported as a success.
    expect(controller.lastOutcome(agent as never)?.state).not.toBe('completed')
    // The cancelled source turn must not trigger a compaction at the later idle.
    expect(eventCount(session, 'compaction/start')).toBe(0)
    expect(controller.pending(agent as never)).toBeUndefined()
    expect(phases).toContain('queued')
    detach()
    await controller.dispose()
  })

  it('does not cancel an accepted request when listeners are cleaned up', async () => {
    const { ctx, adapter } = await mount()
    ctx.tools.register(probeTool() as never)
    let release: (() => void) | undefined
    adapter.compactionGate = new Promise<void>((resolve) => {
      release = resolve
    })
    adapter.releaseCompaction = () => release?.()
    const phases: string[] = []
    const controller = controllerFor(ctx, phases)
    const detach = controller.attach(ctx as never)
    const handle = await ctx.agents.create({
      sessionId: 'agent-codex-context-cleanup' as never,
      meta: { cwd: root as string },
      agentOptions: { provider: PROVIDER, model: MODEL },
    })
    const { agent } = handle
    const session = agent.session

    agent.send(createUserMessage({ content: [{ type: 'text', text: 'run the probe tool' }], source: { kind: 'user' } }), 'next-turn', true)
    await waitForOpenTurn(ctx, agent)
    expect(controller.requestCompaction(agent as never).status).toBe('queued')
    await waitFor(() => phases.includes('started'), 'compaction start')
    // Normal lifecycle cleanup must not abort the in-flight maintenance.
    detach()
    adapter.releaseCompaction?.()
    await waitFor(() => controller.lastOutcome(agent as never) !== undefined, 'completed outcome')
    expect(controller.lastOutcome(agent as never)?.state).toBe('completed')
    expect(eventCount(session, 'compaction/start')).toBe(1)
    await agent.whenIdle()
    await controller.dispose()
  })

  it('refuses a visual summarization answer so the checkpoint stays text-only', async () => {
    const { ctx, adapter } = await mount()
    adapter.compactionImage = true
    ctx.tools.register(probeTool() as never)
    const controller = controllerFor(ctx)
    const detach = controller.attach(ctx as never)
    const handle = await ctx.agents.create({
      sessionId: 'agent-codex-image-summary' as never,
      meta: { cwd: root as string },
      agentOptions: { provider: PROVIDER, model: MODEL },
    })
    const { agent } = handle
    const session = agent.session

    agent.send(createUserMessage({ content: [{ type: 'text', text: 'run the probe tool' }], source: { kind: 'user' } }), 'next-turn', true)
    await waitForOpenTurn(ctx, agent)
    expect(controller.requestCompaction(agent as never).status).toBe('queued')
    await agent.whenIdle()
    await waitFor(() => controller.lastOutcome(agent as never) !== undefined, 'visual summary outcome')

    // The core refuses an image-bearing summary: a checkpoint is text-only.
    expect(controller.lastOutcome(agent as never)?.state).toBe('failed')
    expect(controller.lastOutcome(agent as never)?.reason).toBe('summary')
    expect(eventCount(session, 'compaction/summary')).toBe(0)
    const ends = allEvents(session).filter(event => event.type === 'compaction/end')
    expect(ends).toHaveLength(1)
    expect(JSON.stringify(ends[0]?.data)).toContain('error')
    detach()
    await controller.dispose()
  })

  it('measures the codex_context schema cost with the real meter', async () => {
    const { ctx } = await mount()
    const empty = ctx.sessions.create('session-compaction-meter' as never)
    const tool = codexContextTool(controllerFor(ctx))
    const header = { config: { provider: PROVIDER, model: MODEL } }
    // Same empty session and same route: only the tool schema differs.
    const before = ctx.tokenMeter.measure(empty, header as never)
    const after = ctx.tokenMeter.measure(empty, { ...header, tools: [tool] } as never)
    expect(after.totalTokens).toBeGreaterThan(before.totalTokens)
    // The delta is the first-turn local estimate of this tool definition, not a
    // provider bill. Log it so the number is inspectable in the test output.
    console.log(`codex_context schema cost: ${after.totalTokens - before.totalTokens} local tokens`)
    expect(after.totalTokens - before.totalTokens).toBeGreaterThan(0)
  })

  it('reads the exact end fact immediately when the request already captured a start', async () => {
    // The loop reports idle before this request's `compactNow` promise settles
    // (agent-loop rc1 runMaintenance finally), so an idle-time read sees the
    // controller mid-flight. A real terminal without a durable read trigger is
    // noop; the real loop always appends an assistant surface node, which makes
    // the compactable range non-null, so this case uses the deterministic
    // visual-summary failure as the same "terminal recorded after idle" path.
    const { ctx, adapter } = await mount()
    adapter.compactionImage = true
    const phases: string[] = []
    const timeline: string[] = []
    const controller = controllerFor(ctx, phases, timeline, { cooldownMs: 0 })
    let idleSettle: Promise<void> | undefined
    const offStatus = ctx.on('agent/status', ({ agent, status }) => {
      timeline.push(`status:${status}`)
      if (status !== 'idle') return
      // A read at this exact causal moment captures the settle window once.
      idleSettle = controller.settleForRead(agent.session.id)
    })
    const detach = controller.attach(ctx as never)
    const handle = await ctx.agents.create({
      sessionId: 'agent-codex-noop-settle' as never,
      meta: { cwd: root as string },
      agentOptions: { provider: PROVIDER, model: MODEL },
    })
    const { agent } = handle
    const session = agent.session

    agent.send(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }), 'next-turn', true)
    await waitForOpenTurn(ctx, agent)
    expect(controller.requestCompaction(agent as never).status).toBe('queued')

    await waitFor(() => controller.lastOutcome(agent as never) !== undefined, 'terminal outcome')
    // The real ordering: idle is reported before the controller records the terminal.
    expect(phases).toEqual(['queued', 'started', 'failed'])
    const idleIndex = timeline.indexOf('status:idle')
    expect(idleIndex).toBeGreaterThanOrEqual(0)
    expect(idleIndex).toBeLessThan(timeline.indexOf('phase:failed'))
    // A captured start means a real compaction: the read never waits on settle.
    expect(idleSettle).toBeUndefined()
    expect(controller.settleForRead(session.id)).toBeUndefined()
    // The terminal is read from the durable same-id fact, not from the late phase.
    const requests = controller.requestsForSession(session.id)
    expect(requests).toHaveLength(1)
    expect(requests?.[0]).toMatchObject({ phase: 'failed' })
    expect(requests?.[0]?.phase).not.toBe('running')
    const compactionId = requests?.[0]?.compactionId
    expect(typeof compactionId).toBe('string')
    const fact = foldCompactionEvents(allEvents(session)).facts.at(-1)
    expect(fact).toMatchObject({ compactionId, status: 'failed' })
    expect(fact?.endSeq).not.toBeNull()
    offStatus()
    detach()
    await controller.dispose()
  })
  it('overrides a stale running phase from the exact end fact and keeps requests separate', async () => {
    const { ctx } = await mount()
    ctx.tools.register(probeTool() as never)
    const controller = controllerFor(ctx, [], undefined, { cooldownMs: 0 })
    const detach = controller.attach(ctx as never)
    const handle = await ctx.agents.create({
      sessionId: 'agent-codex-exact-request' as never,
      meta: { cwd: root as string },
      agentOptions: { provider: PROVIDER, model: MODEL },
    })
    const { agent } = handle
    const session = agent.session

    // At the durable compaction/end the controller has NOT recorded its terminal
    // yet: the fact is already terminal while the request still reads running.
    let phaseAtEnd: string | undefined
    let factStatusAtEnd: string | undefined
    const offEnd = ctx.on('session/event', (_session, event) => {
      if (event.type !== 'compaction/end') return
      phaseAtEnd = controller.requestsForSession(session.id)?.at(-1)?.phase
      factStatusAtEnd = foldCompactionEvents(allEvents(session)).facts.at(-1)?.status
    })

    agent.send(createUserMessage({ content: [{ type: 'text', text: 'run the probe tool' }], source: { kind: 'user' } }), 'next-turn', true)
    await waitForOpenTurn(ctx, agent)
    const first = controller.requestCompaction(agent as never)
    expect(first.status).toBe('queued')
    const firstRequestId = first.status === 'queued' ? first.ticket.requestId : undefined
    await waitFor(() => controller.lastOutcome(agent as never) !== undefined, 'first outcome')
    expect(controller.lastOutcome(agent as never)?.state).toBe('completed')

    // The end fact already proved the terminal while the controller was stale.
    expect(phaseAtEnd).toBe('running')
    // The driver composition mounts the plain backend, so the durable fact is ordinary.
    expect(factStatusAtEnd).toBe('ordinary')
    const firstFacts = controller.requestsForSession(session.id)
    expect(firstFacts).toHaveLength(1)
    expect(firstFacts?.[0]).toMatchObject({ requestId: firstRequestId, phase: 'completed' })
    const firstCompactionId = firstFacts?.[0]?.compactionId
    expect(typeof firstCompactionId).toBe('string')
    const folded = foldCompactionEvents(allEvents(session)).facts
    expect(folded.at(-1)).toMatchObject({ compactionId: firstCompactionId })
    expect(folded.at(-1)?.endSeq).not.toBeNull()

    // A second request never overwrites the first request's terminal facts.
    agent.send(createUserMessage({ content: [{ type: 'text', text: 'run it again' }], source: { kind: 'user' } }), 'next-turn', true)
    await waitForOpenTurn(ctx, agent)
    const second = controller.requestCompaction(agent as never)
    expect(second.status).toBe('queued')
    const mid = controller.requestsForSession(session.id)
    expect(mid).toHaveLength(2)
    expect(mid?.[0]).toMatchObject({ requestId: firstRequestId, phase: 'completed', compactionId: firstCompactionId })
    expect(mid?.[1]?.requestId).not.toBe(firstRequestId)

    await waitFor(
      () => controller.requestsForSession(session.id)?.at(-1)?.endedAt !== undefined,
      'second request terminal',
    )
    const finalFacts = controller.requestsForSession(session.id)
    expect(finalFacts?.[0]).toMatchObject({ requestId: firstRequestId, phase: 'completed', compactionId: firstCompactionId })
    expect(finalFacts?.[0]?.compactionId).not.toBe(finalFacts?.[1]?.compactionId)
    offEnd()
    detach()
    await controller.dispose()
  })

  it('returns the exact running request through the real query before held compaction settles', async () => {
    // Exact observation is concrete in the real engine; these two abstract
    // search hooks are deliberately unavailable and never used by this read.
    class ExactSessionQuery extends SessionQueryEngine {
      async searchSessions(): Promise<never> {
        throw new Error('full-text search is not part of this exact-read regression')
      }

      async searchEvents(): Promise<never> {
        throw new Error('full-text search is not part of this exact-read regression')
      }
    }

    const { ctx, adapter } = await mount()
    await ctx.plugin(ExactSessionQuery)
    ctx.tools.register(probeTool() as never)
    const controller = controllerFor(ctx, [], undefined, { cooldownMs: 0 })
    const detach = controller.attach(ctx as never)
    const diagnostics = new CompactionDiagnostics()
    let openGate: () => void = () => undefined
    let released = false
    adapter.compactionGate = new Promise<void>(resolve => {
      openGate = resolve
    })
    const release = () => {
      if (released) return
      released = true
      openGate()
    }
    let pendingRead: ReturnType<typeof readCompactionSnapshot> | undefined

    try {
      const { agent } = await ctx.agents.create({
        sessionId: 'agent-codex-held-exact-read' as never,
        meta: { cwd: root as string },
        agentOptions: { provider: PROVIDER, model: MODEL },
      })
      const session = agent.session
      const ports: Parameters<typeof readCompactionSnapshot>[0] = {
        sessionQuery: () => ({
          observeSession: (id, options) => ctx.sessionQuery.observeSession(id as SessionId, options),
        }),
        diagnostics,
        sessionStatus: id => controller.statusForSession(id),
        requests: id => controller.requestsForSession(id),
        settleRequests: (id, signal) => controller.settleForRead(id, signal),
      }
      // This deadline belongs only to the test: a regression must fail while
      // the model gate stays held, not hang until the whole suite times out.
      const readWithDeadline = async () => {
        const abort = new AbortController()
        let deadline: ReturnType<typeof setTimeout> | undefined
        try {
          pendingRead = readCompactionSnapshot(ports, { sessionId: session.id }, abort.signal)
          return await Promise.race([
            pendingRead,
            new Promise<never>((_resolve, reject) => {
              deadline = setTimeout(() => {
                abort.abort()
                reject(new Error('exact diagnostics read waited for the held compaction'))
              }, 1_500)
            }),
          ])
        } finally {
          if (deadline !== undefined) clearTimeout(deadline)
        }
      }

      agent.send(createUserMessage({ content: [{ type: 'text', text: 'run the held-read probe' }], source: { kind: 'user' } }), 'next-turn', true)
      await waitForOpenTurn(ctx, agent)
      const accepted = controller.requestCompaction(agent as never)
      expect(accepted.status).toBe('queued')
      if (accepted.status !== 'queued') throw new Error('the held-read request was not accepted')
      const requestId = accepted.ticket.requestId
      await waitFor(
        () => eventCount(session, 'compaction/start') === 1 && adapter.calls.some(call => call.purpose === 'compaction'),
        'core start and held summarization call',
      )

      // Read the real committed start through a caller-owned query lease, not
      // through the controller's map or a manufactured event fixture.
      const observation = await ctx.sessionQuery.observeSession(session.id, { projectionMode: 'none' })
      let compactionId: string | undefined
      try {
        expect(observation.source).toBe('live')
        const start = observation.events.find(event => event.type === 'compaction/start')
        if (start?.type !== 'compaction/start') throw new Error('the real core start is missing')
        compactionId = start.data.compactionId
        expect(start.data.turn).toBeNull()
        expect(observation.events.some(event => event.type === 'compaction/end')).toBe(false)
      } finally {
        observation[Symbol.dispose]()
      }
      expect(controller.requestsForSession(session.id)?.find(request => request.requestId === requestId)).toMatchObject({
        requestId,
        phase: 'running',
        compactionId,
      })
      expect(controller.settleForRead(session.id)).toBeUndefined()

      const running = await readWithDeadline()
      expect(released).toBe(false)
      expect(eventCount(session, 'compaction/end')).toBe(0)
      expect(running.requests?.find(request => request.requestId === requestId)).toMatchObject({
        requestId,
        phase: 'running',
        compactionId,
      })
      expect(running.facts.find(fact => fact.compactionId === compactionId)).toMatchObject({
        status: 'open',
        checkpointSeq: null,
        endSeq: null,
      })

      release()
      await agent.whenIdle()
      await waitFor(
        () => controller.requestsForSession(session.id)?.find(request => request.requestId === requestId)?.phase === 'completed',
        'the exact held-read request terminal',
      )
      const completed = await readWithDeadline()
      const terminal = completed.facts.find(fact => fact.compactionId === compactionId)
      expect(terminal?.status).toBe('ordinary')
      expect(terminal?.checkpointSeq).not.toBeNull()
      expect(terminal?.endSeq).not.toBeNull()
      expect(completed.requests?.find(request => request.requestId === requestId)).toMatchObject({
        requestId,
        phase: 'completed',
        result: 'ordinary',
        compactionId,
        checkpointSeq: terminal?.checkpointSeq,
      })
    } finally {
      release()
      detach()
      await controller.dispose()
      await pendingRead?.catch(() => undefined)
      await diagnostics.dispose()
    }
  })

  it('queues later waking prompts FIFO while the idle compaction task is open', async () => {
    const { ctx, adapter } = await mount()
    ctx.tools.register(probeTool() as never)
    const controller = controllerFor(ctx, [], undefined, { cooldownMs: 0 })
    const detach = controller.attach(ctx as never)
    // Hold the real maintenance open inside its own summarization call.
    let release: (() => void) | undefined
    adapter.compactionGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const handle = await ctx.agents.create({
      sessionId: 'agent-codex-fifo' as never,
      meta: { cwd: root as string },
      agentOptions: { provider: PROVIDER, model: MODEL },
    })
    const { agent } = handle
    const session = agent.session

    agent.send(createUserMessage({ content: [{ type: 'text', text: 'prompt-1' }], source: { kind: 'user' } }), 'next-turn', true)
    await waitForOpenTurn(ctx, agent)
    expect(controller.requestCompaction(agent as never).status).toBe('queued')

    // The loop starts the idle maintenance synchronously; it is now held open.
    await waitFor(() => eventCount(session, 'compaction/start') === 1, 'idle compaction closed over the start marker')
    expect(agent.status).toBe('idle')
    const conversationCallsBefore = adapter.calls.filter(call => call.purpose !== 'compaction').length
    const turnsBefore = eventCount(session, 'turn/start')
    const seqBefore = session.seq

    // Later waking prompts are accepted into the inbox while compaction runs.
    agent.send(createUserMessage({ content: [{ type: 'text', text: 'prompt-2' }], source: { kind: 'user' } }), 'next-turn', true)
    agent.send(createUserMessage({ content: [{ type: 'text', text: 'prompt-3' }], source: { kind: 'user' } }), 'next-turn', true)

    // Accepted into the inbox (a real splice is logged), but no new turn and no
    // new normal LLM request yet: the surface is untouched.
    expect(eventCount(session, 'turn/start')).toBe(turnsBefore)
    expect(adapter.calls.filter(call => call.purpose !== 'compaction').length).toBe(conversationCallsBefore)
    const surfaceTexts = allEvents(session)
      .filter(event => event.type === 'user/message')
      .map(event => JSON.stringify(event.data))
    expect(surfaceTexts.some(text => text.includes('prompt-2'))).toBe(false)
    const spliced = allEvents(session).filter(event => event.type === 'agent/inbox/spliced')
    expect(JSON.stringify(spliced)).toContain('prompt-2')
    expect(JSON.stringify(spliced)).toContain('prompt-3')
    expect(controller.statusForSession(session.id)?.state).toBe('running')

    release?.()
    await agent.whenIdle()
    await waitFor(() => eventCount(session, 'turn/end') === 3, 'both queued prompts settled')

    // FIFO: the two accepted prompts run in submission order, after the checkpoint.
    const userTexts = allEvents(session)
      .filter(event => event.type === 'user/message')
      .map(event => JSON.stringify(event.data))
    const p2 = userTexts.findIndex(text => text.includes('prompt-2'))
    const p3 = userTexts.findIndex(text => text.includes('prompt-3'))
    expect(p2).toBeGreaterThanOrEqual(0)
    expect(p3).toBeGreaterThan(p2)
    // The new turn consumes the fresh checkpoint, and no second compaction ran.
    const postCompactionCalls = adapter.calls.filter(call => call.purpose !== 'compaction').slice(conversationCallsBefore)
    expect(postCompactionCalls.length).toBeGreaterThan(0)
    const firstTurnMessages = JSON.stringify(postCompactionCalls[0]?.messages)
    expect(firstTurnMessages).toContain('compact-checkpoint')
    expect(firstTurnMessages).toContain('prompt-2')
    expect(eventCount(session, 'compaction/start')).toBe(1)
    expect(session.seq).toBeGreaterThan(seqBefore)
    detach()
    await controller.dispose()
  })

  it('releases the maintenance on failure without a deadlock or a concurrent compaction', async () => {
    const { ctx, adapter } = await mount()
    ctx.tools.register(probeTool() as never)
    const controller = controllerFor(ctx, [], undefined, { cooldownMs: 0 })
    const detach = controller.attach(ctx as never)
    let fail: ((error: Error) => void) | undefined
    adapter.compactionGate = new Promise<void>((_resolve, reject) => {
      fail = reject
    })
    const handle = await ctx.agents.create({
      sessionId: 'agent-codex-fifo-failure' as never,
      meta: { cwd: root as string },
      agentOptions: { provider: PROVIDER, model: MODEL },
    })
    const { agent } = handle
    const session = agent.session

    agent.send(createUserMessage({ content: [{ type: 'text', text: 'prompt-1' }], source: { kind: 'user' } }), 'next-turn', true)
    await waitForOpenTurn(ctx, agent)
    expect(controller.requestCompaction(agent as never).status).toBe('queued')
    await waitFor(() => eventCount(session, 'compaction/start') === 1, 'idle compaction start')

    // Accepted while the failing maintenance is still open.
    agent.send(createUserMessage({ content: [{ type: 'text', text: 'prompt-2' }], source: { kind: 'user' } }), 'next-turn', true)
    fail?.(new Error('summarization failed for the FIFO failure case'))

    // The maintenance settles as failed; the queued prompt is not deadlocked.
    await waitFor(() => controller.lastOutcome(agent as never)?.state === 'failed', 'failed compaction terminal')
    await agent.whenIdle()
    await waitFor(() => eventCount(session, 'turn/end') === 2, 'queued prompt after the failure')
    expect(JSON.stringify(allEvents(session))).toContain('prompt-2')
    // Exactly one compaction transaction: the release never ran a second one.
    expect(eventCount(session, 'compaction/start')).toBe(1)
    detach()
    await controller.dispose()
  })
})
