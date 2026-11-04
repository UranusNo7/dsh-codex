import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import LlmRuntime, { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRuntime from '@deepseek-ai/dsh-session-projection'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as OpenAICodex from '../src/index.ts'
import { imagegenTool } from '../src/imagegen.ts'

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const signal = new AbortController().signal

let workspace: string
let dshHome: string
let context: Context | undefined
let callCounter = 0

function accessToken(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })}.signature`
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-imagegen-'))
  dshHome = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-imagegen-home-'))
  vi.stubEnv('DSH_HOME', dshHome)
  const store = new OpenAICodex.OpenAICodexCredentialStore()
  await store.modify(OpenAICodex.OPENAI_CODEX_PROVIDER, () => Promise.resolve({
    type: 'oauth',
    access: accessToken('image-account'),
    refresh: 'refresh-secret',
    expires: Date.now() + 3_600_000,
    accountId: 'image-account',
  }))
})

afterEach(async () => {
  // Dispose first: the plugin owns a background catalog refresh whose request
  // must stay inside the mocked transport, never after the stubs are removed.
  await context?.fiber.dispose()
  context = undefined
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(workspace, { recursive: true, force: true })
  await rm(dshHome, { recursive: true, force: true })
})

async function setup(
  config: OpenAICodex.Config = {},
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access',
): Promise<Context> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  if (sandboxMode === undefined) {
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
  } else {
    await ctx.plugin(SessionProjectionRuntime)
    await ctx.plugin(SandboxPolicyService, { mode: sandboxMode, workspaceRoot: workspace })
    await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
  }
  await ctx.plugin(LocalAttachmentStore, { dshHome })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(WebRuntime)
  await ctx.plugin(OpenAICodex, config)
  return ctx
}

function agent(
  messages: readonly Message[] = [],
  model = 'gpt-5.6-sol',
  provider = OpenAICodex.OPENAI_CODEX_PROVIDER,
): object {
  return {
    options: {},
    session: {
      id: 'imagegen-session',
      events: [],
      inheritedEventCount: 0,
      seq: 0,
      snapshotEvents: () => [],
      header: { cwd: workspace },
      deriveMessages: () => messages,
      requestHeader: () => ({ config: { provider, model } }),
      append: () => undefined,
    },
  }
}

async function generate(
  ctx: Context,
  args: Record<string, unknown>,
  messages: readonly Message[] = [],
  model = 'gpt-5.6-sol',
  provider = OpenAICodex.OPENAI_CODEX_PROVIDER,
) {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(`imagegen-${++callCounter}`),
    name: OpenAICodex.IMAGEGEN_TOOL_NAME,
    arguments: args,
    agent: agent(messages, model, provider) as never,
  })
}

const CATALOG_REQUEST_PREFIX = 'https://chatgpt.com/backend-api/codex/models'

interface ProviderFetch {
  /** Global fetch stand-in: catalog prewarming is answered locally, images get the canned PNG. */
  mock: ReturnType<typeof vi.fn>
  /** Image requests only, so assertions stay strict while the catalog warms. */
  image: Array<[string, RequestInit]>
  /** Catalog prewarming requests, answered without touching the network. */
  catalog: string[]
}

function successfulFetch(): ProviderFetch {
  const image: Array<[string, RequestInit]> = []
  const catalog: string[] = []
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith(CATALOG_REQUEST_PREFIX)) {
      catalog.push(url)
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    image.push([url, init ?? {}])
    return new Response(JSON.stringify({
      data: [{ b64_json: PNG_1X1.toString('base64') }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return { mock, image, catalog }
}

describe('imagegen', () => {
  it('uses an injected request transport for image generation', async () => {
    const { mock: requestFetch } = successfulFetch()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('global fetch must not run') }))
    const client = new OpenAICodex.OpenAICodexImageClient(
      new OpenAICodex.OpenAICodexCredentialStore(),
      requestFetch as unknown as typeof globalThis.fetch,
    )

    await expect(client.generate('A tiny red pixel', [], signal)).resolves.toEqual(PNG_1X1)
    expect(requestFetch).toHaveBeenCalledOnce()
    const [, init] = requestFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body)).model)
      .toBe(OpenAICodex.OPENAI_CODEX_IMAGE_MODEL)
  })

  it('generates an attachment and optionally publishes the same PNG to the workspace', async () => {
    const ctx = await setup({ imageGenerationModel: 'gpt-image-2.5-sunburst' })
    const { mock: fetchMock, image } = successfulFetch()
    vi.stubGlobal('fetch', fetchMock)

    const result = await generate(ctx, { prompt: 'A tiny red pixel', output_path: 'art/pixel.png' })

    expect(result.isError).toBe(false)
    expect(result.content.some(block => block.type === 'image')).toBe(true)
    expect(result.content.find(block => block.type === 'text')?.text).toContain('<output_path operation="create">')
    const view = ctx.tools.get(OpenAICodex.IMAGEGEN_TOOL_NAME)?.presentResult?.(
      { prompt: 'A tiny red pixel', output_path: 'art/pixel.png' },
      result,
    )
    expect(view).toMatchObject({
      card: 'generic',
      title: 'Generated image art/pixel.png',
      content: result.content,
    })
    expect(await readFile(join(workspace, 'art', 'pixel.png'))).toEqual(PNG_1X1)
    expect(image).toHaveLength(1)
    const [url, init] = image[0] as [string, RequestInit]
    expect(url).toBe(OpenAICodex.OPENAI_CODEX_IMAGE_GENERATIONS_URL)
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${accessToken('image-account')}`)
    expect(headers.get('chatgpt-account-id')).toBe('image-account')
    expect(headers.get('x-codex-image-turn-id')).toBeNull()
    expect(JSON.parse(init.body as string)).toEqual({
      prompt: 'A tiny red pixel',
      background: 'auto',
      model: 'gpt-image-2.5-sunburst',
      quality: 'auto',
      size: 'auto',
    })
  })

  it('saves under a unique workspace filename when output_path is omitted', async () => {
    const ctx = await setup()
    vi.stubGlobal('fetch', successfulFetch().mock)

    const result = await generate(ctx, { prompt: 'A tiny red pixel' })

    expect(result.isError).toBe(false)
    const text = result.content.find(block => block.type === 'text')?.text ?? ''
    const match = text.match(/<output_path operation="create">([^<]+)<\/output_path>/u)
    expect(basename(match?.[1] ?? '')).toMatch(/^generated-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[0-9a-f]{8}\.png$/u)
    expect(await readFile(match?.[1] ?? 'missing')).toEqual(PNG_1X1)
  })

  it('reads reference paths through ctx.fs and sends data URLs only inside the provider request', async () => {
    const ctx = await setup()
    await writeFile(join(workspace, 'reference.png'), PNG_1X1)
    const { mock: fetchMock, image } = successfulFetch()
    vi.stubGlobal('fetch', fetchMock)

    const result = await generate(ctx, {
      prompt: 'Keep the composition and change the color',
      referenced_image_paths: ['reference.png'],
    })

    expect(result.isError).toBe(false)
    expect(image).toHaveLength(1)
    const [url, init] = image[0] as [string, RequestInit]
    expect(url).toBe(OpenAICodex.OPENAI_CODEX_IMAGE_EDITS_URL)
    const body = JSON.parse(init.body as string) as { images: Array<{ image_url: string }> }
    expect(body.images).toEqual([{ image_url: `data:image/png;base64,${PNG_1X1.toString('base64')}` }])
  })

  it('can use recent conversation image attachments without model-supplied bytes', async () => {
    const ctx = await setup()
    const ref = await ctx.attachments.saveImage({ data: PNG_1X1, mediaType: 'image/png', name: 'prior.png' })
    const messages = [createUserMessage({
      content: [{ type: 'image', attachment: ref }],
      source: { kind: 'user' },
    })]
    const { mock: fetchMock, image } = successfulFetch()
    vi.stubGlobal('fetch', fetchMock)

    const result = await generate(ctx, {
      prompt: 'Make a variation',
      num_last_images_to_include: 1,
    }, messages)

    expect(result.isError).toBe(false)
    expect(image).toHaveLength(1)
    const [, init] = image[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { images: Array<{ image_url: string }> }
    expect(body.images[0]?.image_url).toBe(`data:image/png;base64,${PNG_1X1.toString('base64')}`)
  })

  it('rejects ambiguous reference selection before making a provider request', async () => {
    const ctx = await setup()
    const { mock: fetchMock, image } = successfulFetch()
    vi.stubGlobal('fetch', fetchMock)

    const result = await generate(ctx, {
      prompt: 'Edit this',
      referenced_image_paths: ['one.png'],
      num_last_images_to_include: 1,
    })

    expect(result.isError).toBe(true)
    expect(result.content.find(block => block.type === 'text')?.text).toContain('provide only one')
    expect(image).toHaveLength(0)
  })

  it('honors the setting that disables imagegen for another model provider', async () => {
    const ctx = await setup({ shareImagegenWithOtherModels: false })
    const { mock: fetchMock, image } = successfulFetch()
    vi.stubGlobal('fetch', fetchMock)

    const result = await generate(ctx, { prompt: 'A tiny pixel' }, [], 'vision-model', 'another-provider')

    expect(result.isError).toBe(true)
    expect(result.content.find(block => block.type === 'text')?.text).toContain('disabled for models outside')
    expect(image).toHaveLength(0)
  })

  it('keeps image generation available on the backend-authorized Luna Reserve route', async () => {
    const ctx = await setup({ shareImagegenWithOtherModels: false })
    const { mock: fetchMock, image } = successfulFetch()
    vi.stubGlobal('fetch', fetchMock)

    const result = await generate(ctx, { prompt: 'A tiny pixel' }, [], OpenAICodex.OPENAI_CODEX_LUNA_RESERVE_MODEL)

    expect(result.isError).toBe(false)
    expect(result.content.some(block => block.type === 'image')).toBe(true)
    expect(image).toHaveLength(1)
  })

  it('keeps the attachment but refuses output_path under a read-only filesystem policy', async () => {
    const ctx = await setup({}, 'read-only')
    vi.stubGlobal('fetch', successfulFetch().mock)

    const result = await generate(ctx, { prompt: 'A tiny pixel', output_path: 'blocked.png' })

    expect(result.isError).toBe(false)
    expect(result.content.some(block => block.type === 'image')).toBe(true)
    expect(result.content.find(block => block.type === 'text')?.text).toContain('read-only mode')
    await expect(readFile(join(workspace, 'blocked.png'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('imagegen relay mode', () => {
  const RELAY_BASE = 'https://relay.example.test/v1'
  const RELAY_KEY = 'relay-test-key'

  interface RelayFetch {
    mock: ReturnType<typeof vi.fn>
    calls: Array<[string, RequestInit]>
  }

  function relayFetch(): RelayFetch {
    const calls: Array<[string, RequestInit]> = []
    const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push([String(input), init ?? {}])
      return new Response(JSON.stringify({
        data: [{ b64_json: PNG_1X1.toString('base64') }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    return { mock, calls }
  }

  it('generates through the configured relay with the static key only', async () => {
    const { mock: requestFetch, calls } = relayFetch()
    const store = new OpenAICodex.OpenAICodexCredentialStore()
    const read = vi.spyOn(store, 'read')
    const client = new OpenAICodex.OpenAICodexImageClient(
      store,
      requestFetch as unknown as typeof globalThis.fetch,
      () => ({ baseUrl: RELAY_BASE, apiKey: RELAY_KEY }),
    )

    await expect(client.generate('A tiny red pixel', [], signal)).resolves.toEqual(PNG_1X1)

    expect(read).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    const [url, init] = calls[0] as [string, RequestInit]
    expect(url).toBe(`${RELAY_BASE}/images/generations`)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${RELAY_KEY}`)
    expect(headers.get('chatgpt-account-id')).toBeNull()
    expect(JSON.parse(init.body as string)).toEqual({
      prompt: 'A tiny red pixel',
      background: 'auto',
      model: OpenAICodex.OPENAI_CODEX_IMAGE_MODEL,
      quality: 'auto',
      size: 'auto',
    })
  })

  it('uses the relay edits endpoint for reference images', async () => {
    const { mock: requestFetch, calls } = relayFetch()
    const client = new OpenAICodex.OpenAICodexImageClient(
      new OpenAICodex.OpenAICodexCredentialStore(),
      requestFetch as unknown as typeof globalThis.fetch,
      () => ({ baseUrl: RELAY_BASE, apiKey: RELAY_KEY }),
    )

    await expect(client.generate(
      'Edit this image',
      [`data:image/png;base64,${PNG_1X1.toString('base64')}`],
      signal,
    )).resolves.toEqual(PNG_1X1)

    expect(calls[0]?.[0]).toBe(`${RELAY_BASE}/images/edits`)
  })

  it('reports only a fixed status when relay upstream echoes the key', async () => {
    const requestFetch = vi.fn(async () => new Response(JSON.stringify({
      error: { message: `upstream rejected ${RELAY_KEY}` },
    }), { status: 401, headers: { 'content-type': 'application/json' } }))
    const client = new OpenAICodex.OpenAICodexImageClient(
      new OpenAICodex.OpenAICodexCredentialStore(),
      requestFetch as unknown as typeof globalThis.fetch,
      () => ({ baseUrl: RELAY_BASE, apiKey: RELAY_KEY }),
    )

    const error = await client.generate('A tiny red pixel', [], signal).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('OpenAI Codex relay image request failed (HTTP 401)')
    expect(`${(error as Error).message}${String((error as Error).cause ?? '')}`).not.toContain(RELAY_KEY)

    const htmlFetch = vi.fn(async () => new Response(`<html>${RELAY_KEY}</html>`, {
      status: 502,
      headers: { 'content-type': 'text/html' },
    }))
    const htmlClient = new OpenAICodex.OpenAICodexImageClient(
      new OpenAICodex.OpenAICodexCredentialStore(),
      htmlFetch as unknown as typeof globalThis.fetch,
      () => ({ baseUrl: RELAY_BASE, apiKey: RELAY_KEY }),
    )
    const htmlError = await htmlClient.generate('A tiny red pixel', [], signal).catch((caught: unknown) => caught)

    expect((htmlError as Error).message).toBe('OpenAI Codex returned an unprocessable image response (HTTP 502)')
    expect(`${(htmlError as Error).message}${String((htmlError as Error).cause ?? '')}`).not.toContain(RELAY_KEY)

    const transportFetch = vi.fn(async () => { throw new Error(`transport failed for key ${RELAY_KEY}`) })
    const transportClient = new OpenAICodex.OpenAICodexImageClient(
      new OpenAICodex.OpenAICodexCredentialStore(),
      transportFetch as unknown as typeof globalThis.fetch,
      () => ({ baseUrl: RELAY_BASE, apiKey: RELAY_KEY }),
    )
    const transportError = await transportClient.generate('A tiny red pixel', [], signal)
      .catch((caught: unknown) => caught)

    expect((transportError as Error).message).toBe('OpenAI Codex image request failed')
    expect((transportError as Error).cause).toBeUndefined()
  })

  it('forwards the relay resolver through imagegenTool', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalAttachmentStore, { dshHome })
    ctx.provide('llm', { resolveModelInfo: async () => ({ inputModalities: ['image'] }) } as never)
    const { mock: requestFetch, calls } = relayFetch()
    const tool = imagegenTool(
      ctx,
      new OpenAICodex.OpenAICodexCredentialStore(),
      new OpenAICodex.ImageToolPolicy(),
      requestFetch as unknown as typeof globalThis.fetch,
      () => ({ baseUrl: RELAY_BASE, apiKey: RELAY_KEY }),
    )
    const execute = tool.execute as unknown as (
      args: Record<string, unknown>,
      exec: unknown,
    ) => Promise<{ file?: { path: string } }>

    const result = await execute(
      { prompt: 'A tiny red pixel', output_path: 'relay.png' },
      { signal, agent: agent([]), deferContext: () => undefined },
    )

    expect(result.file?.path).toContain('relay.png')
    expect(await readFile(join(workspace, 'relay.png'))).toEqual(PNG_1X1)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe(`${RELAY_BASE}/images/generations`)
    expect(new Headers(calls[0]?.[1].headers).get('authorization')).toBe(`Bearer ${RELAY_KEY}`)
  })
})
