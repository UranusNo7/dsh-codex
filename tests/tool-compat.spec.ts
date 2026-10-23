import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installOpenAICodexToolCompat,
  stripRedundantEscalation,
} from '../src/tool-compat.ts'

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

const ESCALATION_PARAMETERS = {
  type: 'object',
  properties: {
    script: { type: 'string' },
    sandbox_permissions: {
      type: 'string',
      enum: ['workspace-write', 'danger-full-access'],
    },
    justification: { type: 'string' },
  },
  additionalProperties: true,
}

const NON_CONTRACT_PARAMETERS = {
  type: 'object',
  properties: {
    script: { type: 'string' },
    sandbox_permissions: { type: 'string' },
    justification: { type: 'string' },
  },
  additionalProperties: true,
}

const OUTPUT = {
  schema: { type: 'object', properties: { ran: { type: 'boolean' } } },
  render: (): ContentBlock[] => [{ type: 'text', text: 'ok' }],
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

interface Harness {
  ctx: Context
  approvalRequest: ReturnType<typeof vi.fn>
  body: ReturnType<typeof vi.fn>
  sandboxResolve: ReturnType<typeof vi.fn>
  invoke(options: {
    name?: string
    arguments: Record<string, unknown>
    agent?: Agent
    currentMode?: string
  }): Promise<{ isError: boolean; observed?: Record<string, unknown> }>
}

async function harness(
  options: {
    installBeforeGuard?: boolean
    guard?: (args: Record<string, unknown>) => 'ask' | 'deny' | 'cancel' | undefined
  } = {}
): Promise<Harness> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)

  const approvalRequest = vi.fn(async () => 'rejected')
  const sandboxResolve = vi.fn(() => ({ mode: 'read-only', workspaceRoot: '/tmp' }))
  ctx.provide('approval', { request: approvalRequest } as never)
  ctx.provide(
    'sandboxPolicy',
    { resolve: sandboxResolve } as never,
  )

  const body = vi.fn(async (args: Record<string, unknown>) => {
    return { ran: true, ...args }
  })
  const observed: { arguments?: Record<string, unknown> } = {}
  const tool = (name: string, parameters: unknown): ToolDefinition =>
    ({
      name,
      description: `${name} fixture`,
      parameters,
      output: OUTPUT,
      execute: async (args: unknown) => body(args as Record<string, unknown>),
    }) as unknown as ToolDefinition
  ctx.tools.register(tool('bash', ESCALATION_PARAMETERS))
  ctx.tools.register(tool('pwsh', NON_CONTRACT_PARAMETERS))
  ctx.tools.register(tool('thirdparty', ESCALATION_PARAMETERS))

  if (options.installBeforeGuard !== false) installOpenAICodexToolCompat(ctx)
  ctx.on('tools/pre-execute', (exec, next) => {
    const args = (exec.arguments ?? {}) as Record<string, unknown>
    observed.arguments = args
    if (args.sandbox_permissions === undefined) return next()
    const decision = options.guard?.(args)
    if (decision === 'ask') return Promise.resolve({ kind: 'ask', reason: 'sandbox escalation' })
    if (decision === 'deny') return Promise.resolve({ kind: 'deny', reason: 'denied by fixture' })
    if (decision === 'cancel') return Promise.resolve({ kind: 'cancel' })
    return next()
  })

  let calls = 0
  return {
    ctx,
    approvalRequest,
    body,
    sandboxResolve,
    async invoke(input) {
      calls += 1
      if (input.currentMode !== undefined) {
        sandboxResolve.mockReturnValue({ mode: input.currentMode, workspaceRoot: '/tmp' })
      }
      const result = await ctx.tools.execute({
        callId: `call-${calls}` as ToolCallId,
        name: input.name ?? 'bash',
        arguments: input.arguments,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        signal: new AbortController().signal,
      })
      return {
        isError: result.isError,
        ...(observed.arguments === undefined ? {} : { observed: observed.arguments }),
      }
    },
  }
}

function agentFor(routed: string | undefined, configured?: string): Agent {
  return {
    options: { provider: configured },
    session: {
      requestHeader: () =>
        routed === undefined ? undefined : { config: { provider: routed } },
    },
  } as unknown as Agent
}

describe('stripRedundantEscalation', () => {
  it('returns a frozen copy without mutating the caller arguments', () => {
    const args = Object.freeze({
      script: 'ls',
      sandbox_permissions: 'workspace-write',
      justification: 'already writable',
      extra: true,
    })

    const stripped = stripRedundantEscalation(args, 'workspace-write')

    expect(stripped).toEqual({ script: 'ls', extra: true })
    expect(stripped).not.toBe(args)
    expect(Object.isFrozen(stripped)).toBe(true)
    expect(args).toEqual({
      script: 'ls',
      sandbox_permissions: 'workspace-write',
      justification: 'already writable',
      extra: true,
    })
    expect(stripRedundantEscalation(stripped ?? {}, 'workspace-write')).toBeUndefined()
  })

  it('preserves widening, invalid, missing, and unknown inputs', () => {
    expect(
      stripRedundantEscalation(
        { sandbox_permissions: 'danger-full-access', justification: 'needed' },
        'workspace-write'
      )
    ).toBeUndefined()
    expect(
      stripRedundantEscalation(
        { sandbox_permissions: 'read-only', justification: 'needed' },
        'workspace-write'
      )
    ).toBeUndefined()
    expect(
      stripRedundantEscalation({ sandbox_permissions: 'workspace-write' }, 'mystery')
    ).toBeUndefined()
    expect(stripRedundantEscalation({ script: 'ls' }, 'workspace-write')).toBeUndefined()
    expect(
      stripRedundantEscalation({ justification: 'only reason' }, 'workspace-write')
    ).toBeUndefined()
  })

  it.each([
    ['read-only', 'workspace-write', false],
    ['read-only', 'danger-full-access', false],
    ['workspace-write', 'workspace-write', true],
    ['workspace-write', 'danger-full-access', false],
    ['danger-full-access', 'workspace-write', true],
    ['danger-full-access', 'danger-full-access', true],
  ] as const)(
    'current %s with requested %s strips: %s',
    (currentMode, requested, expected) => {
      const stripped = stripRedundantEscalation(
        { script: 'ls', sandbox_permissions: requested, justification: 'why' },
        currentMode
      )
      expect(stripped !== undefined).toBe(expected)
      if (expected) {
        expect(stripped).toEqual({ script: 'ls' })
      }
    }
  )

  it.each([undefined, '', '   ', 42])(
    'strips a redundant target even when its justification is %j',
    (justification) => {
      const args: Record<string, unknown> = {
        script: 'ls',
        sandbox_permissions: 'workspace-write',
      }
      if (justification !== undefined) args.justification = justification
      expect(stripRedundantEscalation(args, 'workspace-write')).toEqual({ script: 'ls' })
    }
  )
})

describe('OpenAI Codex tool compatibility', () => {
  it('strips a redundant escalation before a native guard can ask', async () => {
    const test = await harness({ guard: () => 'ask' })

    const result = await test.invoke({
      currentMode: 'workspace-write',
      arguments: {
        script: 'ls',
        sandbox_permissions: 'workspace-write',
        justification: 'already writable',
      },
      agent: agentFor('openai-codex'),
    })

    expect(result.isError).toBe(false)
    expect(test.body).toHaveBeenCalledTimes(1)
    expect((test.body.mock.calls[0]?.[0] as Record<string, unknown>).sandbox_permissions).toBeUndefined()
    expect((test.body.mock.calls[0]?.[0] as Record<string, unknown>).justification).toBeUndefined()
    expect(test.approvalRequest).not.toHaveBeenCalled()
    expect(result.observed?.sandbox_permissions).toBeUndefined()
  })

  it('keeps a genuine widening request and goes through real approval', async () => {
    const test = await harness({ guard: () => 'ask' })

    const result = await test.invoke({
      currentMode: 'read-only',
      arguments: {
        script: 'rm -rf build',
        sandbox_permissions: 'danger-full-access',
        justification: 'cleanup needs write access',
      },
      agent: agentFor('openai-codex'),
    })

    expect(result.isError).toBe(true)
    expect(test.body).not.toHaveBeenCalled()
    expect(test.approvalRequest).toHaveBeenCalledTimes(1)
    expect(test.approvalRequest.mock.calls[0]?.[0]).toMatchObject({ toolName: 'bash' })
  })

  it('respects a native deny or cancel decision without rewriting it', async () => {
    for (const decision of ['deny', 'cancel'] as const) {
      const test = await harness({ guard: () => decision })
      const result = await test.invoke({
        currentMode: 'read-only',
        arguments: {
          script: 'x',
          sandbox_permissions: 'workspace-write',
          justification: 'needed',
        },
        agent: agentFor('openai-codex'),
      })
      expect(result.isError).toBe(true)
      expect(test.body).not.toHaveBeenCalled()
      expect(test.approvalRequest).not.toHaveBeenCalled()
      await test.ctx.fiber.dispose()
      context = undefined
    }
  })

  it('leaves unknown targets, unknown modes, and unreadable policy alone', async () => {
    const test = await harness({ guard: () => 'ask' })

    await test.invoke({
      currentMode: 'workspace-write',
      arguments: { script: 'x', sandbox_permissions: 'read-only', justification: 'why' },
      agent: agentFor('openai-codex'),
    })
    expect(test.approvalRequest).toHaveBeenCalledTimes(1)

    await test.invoke({
      currentMode: 'mystery',
      arguments: { script: 'x', sandbox_permissions: 'workspace-write', justification: 'why' },
      agent: agentFor('openai-codex'),
    })
    expect(test.approvalRequest).toHaveBeenCalledTimes(2)

    test.sandboxResolve.mockImplementation(() => {
      throw new Error('policy unavailable')
    })
    await test.invoke({
      arguments: { script: 'x', sandbox_permissions: 'workspace-write', justification: 'why' },
      agent: agentFor('openai-codex'),
    })
    expect(test.approvalRequest).toHaveBeenCalledTimes(3)
  })

  it('requires the schema to advertise the escalation contract', async () => {
    const test = await harness({ guard: () => 'ask' })

    await test.invoke({
      name: 'pwsh',
      currentMode: 'workspace-write',
      arguments: {
        script: 'ls',
        sandbox_permissions: 'workspace-write',
        justification: 'why',
      },
      agent: agentFor('openai-codex'),
    })

    expect(test.body).not.toHaveBeenCalled()
    expect(test.approvalRequest).toHaveBeenCalledTimes(1)
  })

  it('ignores a third-party tool even when its schema looks identical', async () => {
    const test = await harness({ guard: () => 'ask' })

    await test.invoke({
      name: 'thirdparty',
      currentMode: 'workspace-write',
      arguments: {
        script: 'ls',
        sandbox_permissions: 'workspace-write',
        justification: 'why',
      },
      agent: agentFor('openai-codex'),
    })

    expect(test.body).not.toHaveBeenCalled()
    expect(test.approvalRequest).toHaveBeenCalledTimes(1)
  })

  it('only guards the routed Codex provider', async () => {
    const test = await harness({ guard: () => 'ask' })
    const redundant = {
      script: 'ls',
      sandbox_permissions: 'workspace-write',
      justification: 'why',
    }

    await test.invoke({
      currentMode: 'workspace-write',
      arguments: redundant,
      agent: agentFor('a1'),
    })
    expect(test.approvalRequest).toHaveBeenCalledTimes(1)

    await test.invoke({
      currentMode: 'workspace-write',
      arguments: redundant,
      agent: agentFor('a1', 'openai-codex'),
    })
    expect(test.approvalRequest).toHaveBeenCalledTimes(2)

    await test.invoke({
      currentMode: 'workspace-write',
      arguments: redundant,
      agent: agentFor('openai-codex', 'a1'),
    })
    expect(test.body).toHaveBeenCalledTimes(1)
    expect(test.approvalRequest).toHaveBeenCalledTimes(2)
  })

  it('fails closed without an agent or a session', async () => {
    const test = await harness({ guard: () => 'ask' })
    const argumentsWithEscalation = {
      script: 'ls',
      sandbox_permissions: 'workspace-write',
      justification: 'why',
    }

    const agentless = await test.invoke({
      currentMode: 'workspace-write',
      arguments: argumentsWithEscalation,
    })
    expect(agentless.isError).toBe(true)
    expect(test.body).not.toHaveBeenCalled()
    expect(test.approvalRequest).not.toHaveBeenCalled()

    const sessionless = {
      options: { provider: 'openai-codex' },
    } as unknown as Agent
    const result = await test.invoke({
      currentMode: 'workspace-write',
      arguments: argumentsWithEscalation,
      agent: sessionless,
    })
    expect(result.isError).toBe(true)
    expect(test.body).not.toHaveBeenCalled()
    expect(test.approvalRequest).toHaveBeenCalledTimes(1)
  })

  it('is idempotent when mounted more than once', async () => {
    const test = await harness({ guard: () => 'ask' })
    installOpenAICodexToolCompat(test.ctx)
    installOpenAICodexToolCompat(test.ctx)

    await test.invoke({
      currentMode: 'workspace-write',
      arguments: {
        script: 'ls',
        sandbox_permissions: 'workspace-write',
        justification: 'why',
      },
      agent: agentFor('openai-codex'),
    })

    expect(test.body).toHaveBeenCalledTimes(1)
    expect(test.approvalRequest).not.toHaveBeenCalled()
  })

  it('unbinds when its mounting fiber is disposed', async () => {
    const test = await harness({ installBeforeGuard: false })
    const fiber = await test.ctx.plugin({
      inject: ['tools', 'sandboxPolicy'],
      apply: (ctx: Context) => installOpenAICodexToolCompat(ctx),
    })
    const redundant = {
      script: 'ls',
      sandbox_permissions: 'workspace-write',
      justification: 'why',
    }

    await test.invoke({
      currentMode: 'workspace-write',
      arguments: redundant,
      agent: agentFor('openai-codex'),
    })
    expect(test.body).toHaveBeenCalledTimes(1)
    expect((test.body.mock.calls[0]?.[0] as Record<string, unknown>).sandbox_permissions).toBeUndefined()

    await fiber.dispose()
    await test.invoke({
      currentMode: 'workspace-write',
      arguments: redundant,
      agent: agentFor('openai-codex'),
    })
    expect(test.body).toHaveBeenCalledTimes(2)
    expect(
      (test.body.mock.calls[1]?.[0] as Record<string, unknown>).sandbox_permissions
    ).toBe('workspace-write')
  })
})
