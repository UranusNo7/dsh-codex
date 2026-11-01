import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  BlockAssembler,
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as OpenAICodex from '../src/index.ts'

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function accessToken(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })}.signature`
}

function responseEvents(id = 'resp_compaction', text = 'summary'): string {
  const events = [
    { type: 'response.created', response: { id } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_compaction', role: 'assistant', content: [] },
    },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_compaction',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    },
    {
      type: 'response.done',
      response: {
        id,
        status: 'completed',
        output: [],
        usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 },
      },
    },
  ]
  return `${events.map(event => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\n`
}

function compactionEvents(encryptedContent = 'encrypted-checkpoint'): string {
  const events = [
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'compaction', id: 'cmp_item_1', encrypted_content: encryptedContent },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_native_compaction',
        status: 'completed',
        output: [],
        usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
      },
    },
  ]
  return `${events.map(event => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\n`
}

function requestJson(init: RequestInit): Record<string, unknown> {
  const headers = new Headers(init.headers)
  const raw = init.body
  if (typeof raw === 'string') return JSON.parse(raw) as Record<string, unknown>
  if (!(raw instanceof Uint8Array)) throw new Error('expected a string or byte request body')
  const bytes = headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(raw) : raw
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>
}

function userMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/** Core-compatible chars/4 heuristic copied into the test (block +4, role +4). */
function heuristicEstimate(text: string): number {
  return Math.ceil(text.length / 4) + 8
}

/**
 * Replica of the current Harness `dsh-compaction-basic` frame + gate pricing.
 *
 * The package baseline does not install the real compaction/token-meter
 * packages, so these tests assert the verified runtime contract — frame
 * preamble/tags and the chars/4 estimator — instead of claiming a real-core E2E.
 */
const COMPACT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'
const FRAME_OPEN_TAG = '<compacted-summary>'
const FRAME_CLOSE_TAG = '</compacted-summary>'

function framedSummaryEstimate(summary: string, withSummary = true): number {
  const blocks = withSummary
    ? [`${COMPACT_PREAMBLE}\n\n${FRAME_OPEN_TAG}`, summary, FRAME_CLOSE_TAG]
    : [`${COMPACT_PREAMBLE}\n\n${FRAME_OPEN_TAG}`, FRAME_CLOSE_TAG]
  const content = blocks.reduce((total, text) => total + Math.ceil(text.length / 4) + 4, 0)
  return content + 4
}

/** Fake token meter matching the index's `estimateMessage(createUserMessage(...))` contract. */
function fakeTokenMeter() {
  const estimates: string[] = []
  return {
    estimates,
    service: {
      estimateMessage(message: { content: Array<{ type?: string; text?: string }> }) {
        const text = message.content
          .filter(block => block.type === 'text' && typeof block.text === 'string')
          .map(block => block.text)
          .join('')
        estimates.push(text)
        return heuristicEstimate(text)
      },
    },
  }
}

describe('OpenAI Codex compaction request', () => {
  it('keeps stateless reasoning and paired tool history without sending a standard output cap', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-compaction-'))
    vi.stubEnv('DSH_HOME', root)
    const store = new OpenAICodex.OpenAICodexCredentialStore()
    await store.modify(OpenAICodex.OPENAI_CODEX_PROVIDER, () => Promise.resolve({
      type: 'oauth',
      access: accessToken('account-1'),
      refresh: 'refresh-token',
      expires: Date.now() + 3_600_000,
      accountId: 'account-1',
    }))

    let request: { url: string; init: RequestInit } | undefined
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (init === undefined) throw new Error('expected request init')
      request = { url: String(input), init }
      return new Response(responseEvents(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const callId = ToolCallId('call_1|fc_1')
    const reasoningItem = {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'checked the workspace' }],
      encrypted_content: 'encrypted-reasoning',
    }
    const messages = [
      createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'checked the workspace' },
          { type: 'tool-call', id: callId, name: 'read_file', arguments: '{"path":"README.md"}' },
        ],
        source: {
          provider: 'openai-codex',
          model: 'gpt-5.6-sol',
          replayState: {
            kind: 'pi-ai',
            version: 1,
            api: 'openai-codex-responses',
            provider: 'openai-codex',
            model: 'gpt-5.6-sol',
            stopReason: 'toolUse',
            blocks: [
              { type: 'reasoning', thinkingSignature: JSON.stringify(reasoningItem) },
              { type: 'tool-call' },
            ],
          },
        },
      }),
      createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'repository readme' }],
        isError: false,
      }),
      createUserMessage({
        content: [{ type: 'text', text: 'Summarize the conversation for compaction.' }],
        source: { kind: 'user' },
      }),
    ]

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(WebRuntime)
    await ctx.plugin(OpenAICodex)
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      purpose: 'compaction',
      system: 'Preserve decisions and unresolved work.',
      messages,
      maxTokens: 777,
      sessionId: 'session-compaction' as never,
    })) assembler.push(chunk)

    expect(assembler.message({ provider: 'openai-codex', model: 'gpt-5.6-sol' }).content)
      .toEqual([{ type: 'text', text: 'summary' }])
    if (request === undefined) throw new Error('Codex request was not captured')
    const captured = request as { url: string; init: RequestInit }
    const headers = new Headers(captured.init.headers)
    const body = requestJson(captured.init)
    expect(captured.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(headers.get('authorization')).toBe(`Bearer ${accessToken('account-1')}`)
    expect(headers.get('chatgpt-account-id')).toBe('account-1')
    expect(headers.get('session-id')).toBe('session-compaction')
    expect(body).toMatchObject({
      model: 'gpt-5.6-sol',
      store: false,
      instructions: 'Preserve decisions and unresolved work.',
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: 'session-compaction',
    })
    expect(body).not.toHaveProperty('max_output_tokens')
    expect(body.input).toEqual([
      reasoningItem,
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"README.md"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'repository readme' },
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'Summarize the conversation for compaction.' }],
      },
    ])
  })

  it('uses native compact output as a durable checkpoint and restores its response items', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-native-compact-'))
    vi.stubEnv('DSH_HOME', root)
    const store = new OpenAICodex.OpenAICodexCredentialStore()
    await store.modify(OpenAICodex.OPENAI_CODEX_PROVIDER, () => Promise.resolve({
      type: 'oauth',
      access: accessToken('account-1'),
      refresh: 'refresh-token',
      expires: Date.now() + 3_600_000,
      accountId: 'account-1',
    }))

    const restoredOutput = [
      { role: 'user', content: [{ type: 'input_text', text: 'keep this request' }] },
      { type: 'compaction', id: 'cmp_item_1', encrypted_content: 'encrypted-checkpoint' },
    ]
    // Source-region text outside the retained native input keeps the real
    // marker comfortably below the conservative source budget.
    const toolText = 'T'.repeat(200_000)
    const toolCallId = ToolCallId('call_source|fc_source')
    const assistantMessage = createAssistantMessage({
      content: [
        { type: 'reasoning', text: 'R'.repeat(100_000) },
        { type: 'tool-call', id: toolCallId, name: 'read_file', arguments: `{"path":"${'x'.repeat(100_000)}"}` },
      ],
      source: {
        provider: 'openai-codex',
        model: 'gpt-5.6-sol',
      },
    })
    const toolResultMessage = createToolResultMessage({
      callId: toolCallId,
      content: [{ type: 'text', text: toolText }],
      isError: false,
    })
    const meter = fakeTokenMeter()
    const requests: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (init === undefined) throw new Error('expected request init')
      const request = { url: String(input), init }
      requests.push(request)
      const body = requestJson(init)
      if (Array.isArray(body.input) && body.input.some(item => (
        typeof item === 'object' && item !== null && (item as { type?: string }).type === 'compaction_trigger'
      ))) {
        return new Response(compactionEvents(), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return new Response(responseEvents('resp_after_compact', 'continued'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const ctx = new Context()
    context = ctx
    ctx.provide('tokenMeter', meter.service as never)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(WebRuntime)
    await ctx.plugin(OpenAICodex, { useNativeCompaction: true })
    const compacted = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      purpose: 'compaction',
      system: 'Preserve durable context. SYSTEM-SENTINEL',
      messages: [
        assistantMessage,
        toolResultMessage,
        userMessage('keep this request'),
        createUserMessage({
          content: [{ type: 'text', text: 'private Harness summary instruction' }],
          source: { kind: 'user' },
        }),
      ],
      sessionId: 'session-native-compact' as never,
    })) compacted.push(chunk)
    const marker = compacted.message({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
    }).content
    expect(JSON.stringify(marker)).toContain('encrypted-checkpoint')
    // The source budget comes from original text blocks only: tool-result text
    // (outside retained native input) is counted; reasoning, tool-call
    // arguments, the system prompt, and the final instruction are not.
    expect(meter.estimates[0]).toBe(`${toolText}\nkeep this request`)
    expect(meter.estimates[0]).not.toContain('SYSTEM-SENTINEL')
    expect(meter.estimates[0]).not.toContain('private Harness summary instruction')
    expect(meter.estimates[0]).not.toContain('R'.repeat(32))

    const continued = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      system: 'Preserve durable context.',
      messages: [
        createUserMessage({
          content: marker,
          source: { kind: 'user' },
        }),
        userMessage('continue'),
      ],
      sessionId: 'session-native-compact' as never,
    })) continued.push(chunk)

    expect(requests.map(request => request.url)).toEqual([
      'https://chatgpt.com/backend-api/codex/responses',
      'https://chatgpt.com/backend-api/codex/responses',
    ])
    const compactBody = requestJson(requests[0]!.init)
    const compactHeaders = new Headers(requests[0]!.init.headers)
    expect(compactHeaders.get('thread-id')).toBe('session-native-compact')
    expect(compactHeaders.get('x-codex-routing-hint')).toBe('model=gpt-5.6-sol')
    expect(compactBody).toMatchObject({
      model: 'gpt-5.6-sol',
      store: false,
      stream: true,
      instructions: 'Preserve durable context. SYSTEM-SENTINEL',
      include: ['reasoning.encrypted_content'],
    })
    expect(compactBody.input).toEqual(expect.arrayContaining([
      { role: 'user', content: [{ type: 'input_text', text: 'keep this request' }] },
      { type: 'compaction_trigger' },
    ]))
    expect(JSON.stringify(compactBody.input)).toContain(toolText)
    const continuedBody = requestJson(requests[1]!.init)
    expect(continuedBody.input).toEqual([
      ...restoredOutput,
      { role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
    ])
  })

  it('falls back to Harness compaction when the native endpoint is unavailable', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-native-fallback-'))
    vi.stubEnv('DSH_HOME', root)
    const store = new OpenAICodex.OpenAICodexCredentialStore()
    await store.modify(OpenAICodex.OPENAI_CODEX_PROVIDER, () => Promise.resolve({
      type: 'oauth',
      access: accessToken('account-1'),
      refresh: 'refresh-token',
      expires: Date.now() + 3_600_000,
      accountId: 'account-1',
    }))

    const requests: Array<{ url: string; init: RequestInit }> = []
    const meter = fakeTokenMeter()
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/backend-api/codex/models')) return Response.json({ models: [] })
      if (init === undefined) throw new Error('expected request init')
      const request = { url, init }
      requests.push(request)
      const body = requestJson(init)
      if (Array.isArray(body.input) && body.input.some(item => (
        typeof item === 'object' && item !== null && (item as { type?: string }).type === 'compaction_trigger'
      ))) {
        return Response.json({ detail: 'Unsupported input item' }, { status: 400 })
      }
      return new Response(responseEvents('resp_fallback', 'fallback summary'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const ctx = new Context()
    context = ctx
    ctx.provide('tokenMeter', meter.service as never)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(WebRuntime)
    await ctx.plugin(OpenAICodex, { useNativeCompaction: true })
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      purpose: 'compaction',
      system: 'Preserve durable context.',
      messages: [
        userMessage('keep this request'),
        createUserMessage({
          content: [{ type: 'text', text: 'Summarize the conversation.' }],
          source: { kind: 'user' },
        }),
      ],
      sessionId: 'session-native-fallback' as never,
    })) assembler.push(chunk)

    expect(assembler.message({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
    }).content).toEqual([{ type: 'text', text: 'fallback summary' }])
    expect(requests.map(request => request.url)).toEqual([
      'https://chatgpt.com/backend-api/codex/responses',
      'https://chatgpt.com/backend-api/codex/responses',
    ])
    expect(requestJson(requests[1]!.init).input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'keep this request' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Summarize the conversation.' }] },
    ])
  })

  it('discards an oversized native checkpoint and falls back to one standard summary', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-native-too-large-'))
    vi.stubEnv('DSH_HOME', root)
    const store = new OpenAICodex.OpenAICodexCredentialStore()
    await store.modify(OpenAICodex.OPENAI_CODEX_PROVIDER, () => Promise.resolve({
      type: 'oauth',
      access: accessToken('account-1'),
      refresh: 'refresh-token',
      expires: Date.now() + 3_600_000,
      accountId: 'account-1',
    }))

    const sourceText = 'h'.repeat(1_320_000)
    const opaque = 'o'.repeat(2_600_000)
    const requests: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/backend-api/codex/models')) return Response.json({ models: [] })
      if (init === undefined) throw new Error('expected request init')
      requests.push({ url, init })
      const body = requestJson(init)
      if (Array.isArray(body.input) && body.input.some(item => (
        typeof item === 'object' && item !== null && (item as { type?: string }).type === 'compaction_trigger'
      ))) {
        return new Response(compactionEvents(opaque), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return new Response(responseEvents('resp_standard', 'standard summary'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const ctx = new Context()
    context = ctx
    const meter = fakeTokenMeter()
    ctx.provide('tokenMeter', meter.service as never)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(WebRuntime)
    await ctx.plugin(OpenAICodex, { useNativeCompaction: true })

    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      purpose: 'compaction',
      system: 'Preserve durable context.',
      messages: [
        userMessage(sourceText),
        createUserMessage({
          content: [{ type: 'text', text: 'Summarize the conversation.' }],
          source: { kind: 'user' },
        }),
      ],
      sessionId: 'session-native-too-large' as never,
    })) assembler.push(chunk)

    const content = assembler.message({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
    }).content
    expect(content).toEqual([{ type: 'text', text: 'standard summary' }])
    expect(JSON.stringify(content)).not.toContain('<dsh-openai-codex-compaction')
    expect(JSON.stringify(content)).not.toContain(opaque.slice(0, 32))
    expect(requests).toHaveLength(2)
    expect(requestJson(requests[0]!.init).input).toEqual(expect.arrayContaining([
      { type: 'compaction_trigger' },
    ]))
    expect(requestJson(requests[1]!.init).input).not.toEqual(expect.arrayContaining([
      { type: 'compaction_trigger' },
    ]))
    expect(meter.estimates).toHaveLength(2)
    expect(meter.estimates[0]).toBe(sourceText)
    expect(meter.estimates[1]?.startsWith('<dsh-openai-codex-compaction-4f5cf1b7-v1>')).toBe(true)
    // Contract replica of the current core gate (not the real package):
    // the marker is oversized, while the final plain summary would pass.
    const sourceBudget = heuristicEstimate(sourceText)
    const markerEstimate = heuristicEstimate(meter.estimates[1] ?? '')
    expect(markerEstimate + 256).toBeGreaterThanOrEqual(sourceBudget)
    expect(framedSummaryEstimate('', false)).toBeLessThan(256)
    expect(framedSummaryEstimate('standard summary')).toBeLessThan(sourceBudget)
  })

  it('skips the native request entirely when no token meter is composed', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-native-no-meter-'))
    vi.stubEnv('DSH_HOME', root)
    const store = new OpenAICodex.OpenAICodexCredentialStore()
    await store.modify(OpenAICodex.OPENAI_CODEX_PROVIDER, () => Promise.resolve({
      type: 'oauth',
      access: accessToken('account-1'),
      refresh: 'refresh-token',
      expires: Date.now() + 3_600_000,
      accountId: 'account-1',
    }))

    const requests: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/backend-api/codex/models')) return Response.json({ models: [] })
      if (init === undefined) throw new Error('expected request init')
      requests.push({ url, init })
      return new Response(responseEvents('resp_no_meter', 'standard summary'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(WebRuntime)
    await ctx.plugin(OpenAICodex, { useNativeCompaction: true })
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      purpose: 'compaction',
      system: 'Preserve durable context.',
      messages: [userMessage('h'.repeat(10_000)), userMessage('Summarize the conversation.')],
      sessionId: 'session-native-no-meter' as never,
    })) assembler.push(chunk)

    expect(assembler.message({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
    }).content).toEqual([{ type: 'text', text: 'standard summary' }])
    expect(requests).toHaveLength(1)
    expect(requestJson(requests[0]!.init).input).not.toEqual(expect.arrayContaining([
      { type: 'compaction_trigger' },
    ]))
  })
})
