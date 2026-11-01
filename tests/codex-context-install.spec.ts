import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  CodexContextController,
  CODEX_CONTEXT_PROVIDER,
} from '../src/codex-context.ts'
import {
  CODEX_CONTEXT_TOOL_NAME,
  installCodexContextTools,
} from '../src/codex-context-tool.ts'
import type { CodexContextInstallHost } from '../src/codex-context-tool.ts'

/**
 * Composition test for the index wiring contract: the per-Agent tool installer
 * needs only the root Agent roster. The tool itself is registered in each
 * Agent's own `ctx.tools`, so a composition without a root `tools` service must
 * still install, and an Agent without its own tools is skipped safely.
 */
function controller(): CodexContextController {
  return new CodexContextController({
    resolveCompaction: () => undefined,
    takeoverDeclared: () => false,
  })
}

interface AgentHarness {
  readonly agent: {
    id: string
    options: { provider: string }
    ctx: { tools?: { register(definition: unknown): () => void } }
  }
  readonly register: ReturnType<typeof vi.fn>
  readonly dispose: ReturnType<typeof vi.fn>
}

function codexAgent(id: string, withTools: boolean): AgentHarness {
  const dispose = vi.fn()
  const register = vi.fn(() => dispose)
  const agent = {
    id,
    options: { provider: CODEX_CONTEXT_PROVIDER },
    ctx: withTools ? { tools: { register } } : {},
  }
  return { agent, register, dispose }
}

function otherAgent(id: string): AgentHarness {
  const dispose = vi.fn()
  const register = vi.fn(() => dispose)
  return {
    agent: { id, options: { provider: 'anthropic' }, ctx: { tools: { register } } },
    register,
    dispose,
  }
}

async function installInRoot(options: { agents: AgentHarness[]; rootTools?: boolean }) {
  const ctx = new Context()
  const agents = options.agents.map(harness => harness.agent)
  ctx.provide('agents', { list: () => agents })
  const rootRegister = vi.fn()
  if (options.rootTools === true) ctx.provide('tools', { register: rootRegister })
  let dispose: (() => void) | undefined
  ctx.inject(['agents'], scope => {
    dispose = installCodexContextTools(
      scope as unknown as CodexContextInstallHost,
      controller(),
    )
  })
  // Cordis activates an available dependency synchronously; a microtask keeps
  // the assertion stable across activation timing.
  await Promise.resolve()
  return { ctx, dispose, rootRegister }
}

describe('codex_context installer composition', () => {
  it('installs in the Agent scope with a root roster and no root tools service', async () => {
    const agent = codexAgent('agent-codex', true)
    const harness = await installInRoot({ agents: [agent] })

    expect(harness.dispose).toBeTypeOf('function')
    expect(agent.register).toHaveBeenCalledTimes(1)
    expect((agent.register.mock.calls[0]?.[0] as { name?: string }).name).toBe(CODEX_CONTEXT_TOOL_NAME)

    harness.dispose?.()
    expect(agent.dispose).toHaveBeenCalledTimes(1)
    await harness.ctx.fiber.dispose()
  })

  it('never registers in root tools and skips an Agent without its own tools', async () => {
    const withTools = codexAgent('agent-with-tools', true)
    const withoutTools = codexAgent('agent-without-tools', false)
    const foreign = otherAgent('agent-other')
    const harness = await installInRoot({
      agents: [withTools, withoutTools, foreign],
      rootTools: true,
    })

    expect(withTools.register).toHaveBeenCalledTimes(1)
    expect(withoutTools.register).not.toHaveBeenCalled()
    expect(foreign.register).not.toHaveBeenCalled()
    // The installer never touches the root tools service.
    expect(harness.rootRegister).not.toHaveBeenCalled()

    harness.dispose?.()
    await harness.ctx.fiber.dispose()
  })

  it('does not install without the root roster', async () => {
    const ctx = new Context()
    const agent = codexAgent('agent-codex', true)
    let called = false
    ctx.inject(['agents'], () => {
      called = true
      return () => undefined
    })
    await Promise.resolve()

    expect(called).toBe(false)
    expect(agent.register).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})
