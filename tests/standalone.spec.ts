/**
 * Standalone acceptance: the published bundle must be usable with a base DSH
 * core alone. This composition loads the real Harness services plus
 * `dsh-codex`; it never imports or installs `dsh-custom-header` or
 * `dsh-gpt-compat`, and it makes no OpenAI request.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRuntime from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import WebRuntime from '@deepseek-ai/dsh-web'
import {
  OPENAI_CODEX_AUTH_CANCEL_PATH,
  OPENAI_CODEX_AUTH_LOGIN_PATH,
  OPENAI_CODEX_AUTH_LOGOUT_PATH,
  OPENAI_CODEX_AUTH_STATUS_PATH,
  OPENAI_CODEX_CONTEXT_WINDOW_SETTINGS_PATH,
  OPENAI_CODEX_FAST_MODE_SETTINGS_PATH,
  OPENAI_CODEX_IMAGE_TOOL_SETTINGS_PATH,
  OPENAI_CODEX_MODEL_CATALOG_SETTINGS_PATH,
  OPENAI_CODEX_MODEL_FALLBACK_SETTINGS_PATH,
  OPENAI_CODEX_PROXY_SETTINGS_PATH,
  OPENAI_CODEX_RESPONSE_API_SETTINGS_PATH,
} from '../src/auth-routes.ts'
import * as OpenAICodex from '../src/index.ts'

const signal = new AbortController().signal
const ESCALATION_MODES = ['workspace-write', 'danger-full-access'] as const
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

let workspace: string
let dshHome: string
let contexts: Context[]
let sequence: number

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-codex-standalone-'))
  dshHome = await mkdtemp(join(tmpdir(), 'dsh-codex-standalone-home-'))
  vi.stubEnv('DSH_HOME', dshHome)
  contexts = []
  sequence = 0
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts = []
  await rm(workspace, { recursive: true, force: true })
  await rm(dshHome, { recursive: true, force: true })
})

interface StandaloneAgent {
  agent: {
    id: string
    options: { provider: string }
    session: unknown
    ctx: { tools: { register: (definition: ToolDefinition) => () => void } }
  }
  /** Tool definitions the plugin shadowed into this agent scope. */
  registrations: ToolDefinition[]
}

function standaloneAgent(provider: string): StandaloneAgent {
  const registrations: ToolDefinition[] = []
  const id = `standalone-agent-${++sequence}`
  return {
    registrations,
    agent: {
      id,
      options: { provider },
      session: {
        id: `standalone-session-${sequence}`,
        events: [],
        inheritedEventCount: 0,
        seq: 0,
        snapshotEvents: () => [],
        header: { cwd: workspace },
        deriveMessages: () => [],
        requestHeader: () => ({ config: { provider, model: 'gpt-5.6-sol' } }),
        append: () => undefined,
      },
      ctx: {
        tools: {
          register(definition: ToolDefinition) {
            registrations.push(definition)
            return () => undefined
          },
        },
      },
    },
  }
}

interface Received {
  name: string
  keys: string[]
}

/** Fixture using the native DSH escalation contract declared on its schema. */
function escalationTool(name: string, received: Received[]): ToolDefinition {
  return defineTool({
    name,
    description: `Fixture for the native ${name} escalation contract.`,
    parameters: {
      target: { type: 'string', required: true },
      sandbox_permissions: { type: 'string', enum: ESCALATION_MODES },
      justification: { type: 'string' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          keys: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.keys }],
    },
    async execute(args) {
      const keys = Object.keys(args).sort()
      received.push({ name, keys })
      return { name, keys: JSON.stringify(keys) }
    },
  })
}

/** Minimal read_image shape the enhancement shadows; proves the mount only. */
function baseReadImage(): ToolDefinition {
  return defineTool({
    name: OpenAICodex.READ_IMAGE_TOOL_NAME,
    description: 'Read an image from a local file path.',
    parameters: {
      file_path: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string', required: true },
        },
      },
      render: () => [],
    },
    async execute(args) {
      return { file_path: args.file_path }
    },
  })
}

interface Composed {
  ctx: Context
  /** The plugin fiber, so a test can unload the whole bundle again. */
  plugin: { dispose(): Promise<void> }
  routes: string[]
  agent: StandaloneAgent
}

interface ComposeOptions {
  sandboxMode?: SandboxMode
  provider?: string
  config?: OpenAICodex.Config
}

/**
 * Load the real Harness registries this bundle depends on, then the bundle.
 * `webServer` and `agents` are the only recorded core fixtures: they stand for
 * the host surfaces whose registration this test observes, while tools, the
 * sandbox policy, the filesystem, attachments, LLM, and web are real services.
 */
async function compose(options: ComposeOptions = {}): Promise<Composed> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(SessionProjectionRuntime)
  await ctx.plugin(SandboxPolicyService, {
    mode: options.sandboxMode ?? 'workspace-write',
    workspaceRoot: workspace,
  })
  await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
  await ctx.plugin(LocalAttachmentStore, { dshHome })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(WebRuntime)

  ctx.tools.register(baseReadImage())

  const routes: string[] = []
  ctx.provide('webServer', {
    register(route: { path?: string }) {
      if (typeof route.path === 'string') routes.push(route.path)
      return () => undefined
    },
  })
  const agent = standaloneAgent(options.provider ?? OpenAICodex.OPENAI_CODEX_PROVIDER)
  ctx.provide('agents', {
    list: () => [agent.agent],
    get: (id: string) => (id === agent.agent.id ? agent.agent : undefined),
    currentInitiator: () => undefined,
  })

  const plugin = (await ctx.plugin(
    OpenAICodex,
    options.config ?? {}
  )) as unknown as { dispose(): Promise<void> }
  return { ctx, plugin, routes, agent }
}

async function call(
  composed: Composed,
  name: string,
  args: Record<string, unknown>
): Promise<{ isError: boolean; keys: string[] | undefined }> {
  const result = await composed.ctx.tools.execute({
    callId: ToolCallId(`standalone-${++sequence}`),
    name,
    arguments: args,
    signal,
    agent: composed.agent.agent as never,
  })
  const value = result.isError ? undefined : (result.value as { keys?: string })
  return {
    isError: result.isError,
    keys: value?.keys === undefined ? undefined : (JSON.parse(value.keys) as string[]),
  }
}

describe('standalone bundle composition', () => {
  it('mounts the Codex catalog, search, settings routes, and tools on base dsh core', async () => {
    const fetchBefore = globalThis.fetch
    const composed = await compose()

    expect(composed.ctx.llm.listProviders()).toEqual([
      { id: OpenAICodex.OPENAI_CODEX_PROVIDER, name: 'OpenAI Codex' },
    ])
    const models = await composed.ctx.llm.listModels(OpenAICodex.OPENAI_CODEX_PROVIDER)
    expect(models.length).toBeGreaterThan(0)
    expect(models.map((model) => model.id)).toContain('gpt-6-sol')

    // The real Web registry keeps the plugin's standalone search provider.
    const searchProviders = (composed.ctx.web as unknown as {
      searchProviders: Map<string, { id: string }>
    }).searchProviders
    expect(searchProviders.has(OpenAICodex.OPENAI_CODEX_SEARCH_PROVIDER)).toBe(true)

    expect(composed.routes).toEqual(
      expect.arrayContaining([
        OPENAI_CODEX_AUTH_STATUS_PATH,
        OPENAI_CODEX_AUTH_LOGIN_PATH,
        OPENAI_CODEX_AUTH_LOGOUT_PATH,
        OPENAI_CODEX_AUTH_CANCEL_PATH,
        OPENAI_CODEX_PROXY_SETTINGS_PATH,
        OPENAI_CODEX_IMAGE_TOOL_SETTINGS_PATH,
        OPENAI_CODEX_MODEL_CATALOG_SETTINGS_PATH,
        OPENAI_CODEX_CONTEXT_WINDOW_SETTINGS_PATH,
        OPENAI_CODEX_FAST_MODE_SETTINGS_PATH,
        OPENAI_CODEX_MODEL_FALLBACK_SETTINGS_PATH,
        OPENAI_CODEX_RESPONSE_API_SETTINGS_PATH,
      ])
    )

    expect(composed.ctx.tools.get(OpenAICodex.IMAGEGEN_TOOL_NAME)).toBeDefined()

    const shadowed = composed.agent.registrations.filter(
      (definition) => definition.name === OpenAICodex.READ_IMAGE_TOOL_NAME
    )
    expect(shadowed).toHaveLength(1)
    const shadowedProperties =
      (shadowed[0]?.parameters as unknown as {
        properties?: Record<string, unknown>
      }).properties ?? {}
    expect(Object.keys(shadowedProperties)).toEqual(
      expect.arrayContaining(['file_path', 'url'])
    )

    // No header-rewriting plugin is composed here, so process fetch stays intact.
    expect(globalThis.fetch).toBe(fetchBefore)
  })

  it('declares no dependency on the two retired companion plugins', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8')
    ) as Record<string, Record<string, string> | undefined>
    const declared = [
      manifest['dependencies'],
      manifest['devDependencies'],
      manifest['peerDependencies'],
    ].flatMap((section) => Object.keys(section ?? {}))
    expect(declared).not.toContain('dsh-custom-header')
    expect(declared).not.toContain('dsh-gpt-compat')
  })
})

describe('standalone Codex escalation compatibility', () => {
  it('strips a redundant escalation for the Codex provider', async () => {
    const received: Received[] = []
    const composed = await compose()
    composed.ctx.tools.register(escalationTool('bash', received))

    const result = await call(composed, 'bash', {
      target: 'workspace',
      sandbox_permissions: 'workspace-write',
      justification: 'not used',
    })

    expect(result.isError).toBe(false)
    expect(result.keys).toEqual(['target'])
    expect(received[0]?.keys).toEqual(['target'])
  })

  // This only proves the arguments reach downstream policy untouched. The
  // approval path itself (rejected ask, tool body not executed) is covered by
  // tests/tool-compat.spec.ts, which owns that gate.
  it('keeps a genuine widening request for downstream policy', async () => {
    const composed = await compose({ sandboxMode: 'workspace-write' })
    composed.ctx.tools.register(escalationTool('bash', []))

    const result = await call(composed, 'bash', {
      target: 'workspace',
      sandbox_permissions: 'danger-full-access',
      justification: 'needs to write outside the workspace',
    })

    expect(result.isError).toBe(false)
    expect(result.keys).toEqual(['justification', 'sandbox_permissions', 'target'])
  })

  it('leaves a non-Codex provider untouched', async () => {
    const composed = await compose({ provider: 'a1' })
    composed.ctx.tools.register(escalationTool('bash', []))

    const result = await call(composed, 'bash', {
      target: 'workspace',
      sandbox_permissions: 'workspace-write',
      justification: 'not used',
    })

    expect(result.keys).toEqual(['justification', 'sandbox_permissions', 'target'])
  })

  it('unregisters the hook when the bundle is disposed', async () => {
    const composed = await compose()
    composed.ctx.tools.register(escalationTool('bash', []))

    await composed.plugin.dispose()

    const result = await call(composed, 'bash', {
      target: 'workspace',
      sandbox_permissions: 'workspace-write',
      justification: 'not used',
    })

    expect(result.keys).toEqual(['justification', 'sandbox_permissions', 'target'])
    expect(composed.ctx.llm.listProviders()).toEqual([])
    expect(composed.ctx.tools.get(OpenAICodex.IMAGEGEN_TOOL_NAME)).toBeUndefined()
  })
})
