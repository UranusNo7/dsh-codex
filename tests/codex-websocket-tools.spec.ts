/**
 * Codex Responses WebSocket tool-call regression.
 *
 * The plugin's transport keeps pi-ai's public parsing authoritative and only
 * turns WebSocket frames into the SSE bytes the SDK already understands. These
 * tests therefore drive the real pi-ai provider (scripted frames, no network)
 * and prove the two behaviors the shim can break without touching text:
 * a `function_call` event becomes the same AssistantMessage tool call the
 * public SSE parser produces, and a tool result is sent back as a
 * `previous_response_id` delta on the same socket.
 */
import { describe, expect, it } from 'vitest'
import { normalizeContext } from '@earendil-works/pi-ai'
import type {
  AssistantMessage,
  ToolCall,
  UserMessage,
} from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import type { WebSocket as UndiciWebSocket } from 'undici'
import { CodexWebSocketTransport } from '../src/codex-websocket.ts'
import type { CodexWebSocketRoute } from '../src/proxy.ts'

type Frame = Record<string, unknown>
type Listener = (event: { data?: unknown }) => void

/** Minimal undici WebSocket shape: open, send, close, and message events. */
class FakeSocket {
  readyState = 0
  readonly sent: Frame[] = []
  readonly responses: Frame[][] = []
  private readonly listeners = new Map<string, Set<Listener>>()

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Frame
    this.sent.push(frame)
    const response = this.responses.shift() ?? []
    queueMicrotask(() => {
      for (const event of response) {
        this.emit('message', { data: JSON.stringify(event) })
      }
    })
  }

  close(): void {
    this.readyState = 3
  }

  open(): void {
    this.readyState = 1
    this.emit('open', {})
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }
}

/** Local-only JWT carrying the account id the transport keys sockets by. */
function accessToken(accountId: string): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })}.signature`
}

function sseResponse(frames: readonly Frame[]): Response {
  return new Response(
    frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

const FIRST_TURN: Frame[] = [
  { type: 'response.created', response: { id: 'resp_1' } },
  {
    type: 'response.output_item.added',
    output_index: 0,
    item: {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'imagegen',
      arguments: '',
    },
  },
  {
    type: 'response.function_call_arguments.delta',
    output_index: 0,
    delta: '{"prompt":"x"}',
  },
  {
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'imagegen',
      arguments: '{"prompt":"x"}',
    },
  },
  {
    type: 'response.completed',
    response: {
      id: 'resp_1',
      status: 'completed',
      output: [],
      usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
    },
  },
]

const SECOND_TURN: Frame[] = [{
  type: 'response.completed',
  response: {
    id: 'resp_2',
    status: 'completed',
    output: [],
    usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 },
  },
}]

const user: UserMessage = {
  role: 'user',
  content: [{ type: 'text', text: 'draw a pixel' }],
  timestamp: Date.now(),
}

function setup(frames: readonly Frame[][]) {
  const base = openaiCodexProvider()
  const model = base.getModels().find(candidate => candidate.id === 'gpt-5.6-sol')
    ?? base.getModels()[0]
  if (model === undefined) throw new Error('Codex provider has no test model')
  const sockets: FakeSocket[] = []
  const route: CodexWebSocketRoute = {
    identity: {},
    fetch: async () => {
      throw new Error('HTTP fallback must not run')
    },
    createWebSocket: () => {
      const socket = new FakeSocket()
      socket.responses.push(...frames.map(turn => [...turn]))
      sockets.push(socket)
      // The transport attaches its open listener synchronously after this call.
      queueMicrotask(() => socket.open())
      return socket as unknown as UndiciWebSocket
    },
  }
  const manager = new CodexWebSocketTransport(() => route)
  const options = {
    transport: 'websocket-cached' as const,
    sessionId: 'session-tools',
    apiKey: accessToken('account-a'),
  }
  return {
    base,
    model,
    sockets,
    manager,
    provider: manager.wrap(base),
    options,
  }
}

function toolCallOf(message: AssistantMessage): ToolCall {
  const block = message.content.find(entry => entry.type === 'toolCall')
  if (block === undefined) throw new Error('the response has no tool call')
  return block
}

describe('Codex WebSocket tool calls', () => {
  it('maps a function_call frame to the same tool call as the public SSE parser', async () => {
    const harness = setup([FIRST_TURN])
    try {
      const overWebSocket = await harness.provider
        .streamSimple(harness.model, normalizeContext({ messages: [user] }), harness.options)
        .result()
      // The public HTTP path with the very same frames is the reference parse.
      const overSse = await harness.base
        .streamSimple(harness.model, normalizeContext({ messages: [user] }), {
          ...harness.options,
          transport: 'sse',
          fetch: async () => sseResponse(FIRST_TURN),
        })
        .result()

      const webSocketCall = toolCallOf(overWebSocket)
      const sseCall = toolCallOf(overSse)
      expect(webSocketCall).toMatchObject({
        id: 'call_1|fc_1',
        name: 'imagegen',
        arguments: { prompt: 'x' },
      })
      expect(sseCall).toMatchObject({
        name: webSocketCall.name,
        arguments: webSocketCall.arguments,
      })
      expect(overWebSocket.stopReason).toBe('toolUse')
      expect(overSse.stopReason).toBe(overWebSocket.stopReason)
      expect(harness.sockets).toHaveLength(1)
    } finally {
      harness.manager.dispose()
    }
  })

  it('sends the tool result as a previous_response_id delta on the same socket', async () => {
    const harness = setup([FIRST_TURN, SECOND_TURN])
    try {
      const first = await harness.provider
        .streamSimple(harness.model, normalizeContext({ messages: [user] }), harness.options)
        .result()
      const toolCall = toolCallOf(first)

      const second = await harness.provider
        .streamSimple(
          harness.model,
          normalizeContext({
            messages: [
              user,
              first,
              {
                role: 'toolResult',
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                content: [{ type: 'text', text: 'tool-ok' }],
                isError: false,
                timestamp: Date.now(),
              },
            ],
          }),
          harness.options,
        )
        .result()

      expect(second.stopReason).toBe('stop')
      // One socket carried both turns: the tool result continued its context.
      expect(harness.sockets).toHaveLength(1)
      const socket = harness.sockets[0]!
      expect(socket.sent).toHaveLength(2)
      const payload = socket.sent[1]!
      expect(payload['previous_response_id']).toBe('resp_1')
      const input = payload['input'] as Frame[]
      expect(input).toHaveLength(1)
      expect(input[0]).toMatchObject({
        type: 'function_call_output',
        call_id: 'call_1',
      })
      expect(JSON.stringify(input[0])).toContain('tool-ok')
    } finally {
      harness.manager.dispose()
    }
  })
})
