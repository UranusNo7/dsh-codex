import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import {
  CompactionDiagnostics,
  CompactionRemote,
  compactionRemoteContribution,
} from '../src/compaction-diagnostics.ts'
import { COMPACTION_REMOTE_NAMESPACE } from '../src/compaction-types.ts'
import type { CompactionRequestFact } from '../src/compaction-types.ts'
import type { CompactionSessionEventLike } from '../src/compaction-diagnostics.ts'

const MARKER_OPEN = '<dsh-openai-codex-compaction-4f5cf1b7-v1>'
const MARKER_CLOSE = '</dsh-openai-codex-compaction-4f5cf1b7-v1>'
const nativeMarker = `${MARKER_OPEN}${JSON.stringify([{ type: 'compaction', encrypted_content: 'opaque' }])}${MARKER_CLOSE}`

function events(): CompactionSessionEventLike[] {
  return [
    { type: 'compaction/start', seq: 1, time: 10, data: { compactionId: 'compaction-gw', turn: 1 } },
    {
      type: 'compaction/summary',
      seq: 2,
      time: 20,
      data: {
        compactionId: 'compaction-gw',
        summary: nativeMarker,
        shadowedSeqs: [1],
        shadowedTokenCount: 100,
        provider: 'openai-codex',
        model: 'gpt-6-sol',
        usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 },
      },
    },
    {
      type: 'user/message',
      seq: 3,
      time: 30,
      data: { role: 'user', content: [{ type: 'text', text: nativeMarker }], source: { kind: 'compact-checkpoint', compactionId: 'compaction-gw' } },
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
    },
    { type: 'compaction/end', seq: 4, time: 40, data: { compactionId: 'compaction-gw', turn: 1 } },
  ]
}

interface RpcDispatch {
  readonly claim: (endpoint: string) => boolean
  readonly dispatch: (endpoint: string, payload: unknown, signal: AbortSignal, peer: unknown) => Promise<unknown>
}

async function gatewayHarness(options: {
  events?: readonly CompactionSessionEventLike[]
  observe?: () => Promise<unknown>
  requests?: readonly CompactionRequestFact[]
} = {}) {
  const ctx = new Context()
  // The Gateway registers its whole dispatch through the connection layer, so
  // the test drives the same public interception the browser carrier uses.
  const rpc = { handlers: [] as RpcDispatch[] }
  ctx.provide('connection', {
    rpc: {
      intercept: (_prefix: string, claim: RpcDispatch['claim'], dispatch: RpcDispatch['dispatch']) => {
        rpc.handlers.push({ claim, dispatch })
        return () => undefined
      },
    },
  })
  const dispose = vi.fn()
  const observeSession = vi.fn(async (sessionId: string, init: { signal?: AbortSignal; projectionMode?: 'all' | 'none' } = {}) => {
    // The real session-query service rejects an aborted observation; the fake
    // reproduces that contract so the carrier -> Remote mapping is exercised.
    if (init.signal?.aborted === true) {
      throw Object.assign(new Error('observation aborted'), { code: 'SESSION_QUERY_ABORTED' })
    }
    if (options.observe !== undefined) return options.observe()
    return {
      events: options.events ?? events(),
      [Symbol.dispose]: dispose,
      sessionId,
      init,
    }
  })
  ctx.provide('sessionQuery', { observeSession })
  // The real published registry: it validates the contribution exactly as the
  // Host composition does, and the real Gateway discovers it from `local`.
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(CompactionRemote, {
    diagnostics: new CompactionDiagnostics(),
    ...options.requests === undefined ? {} : { requests: () => options.requests },
  })
  const contribution = compactionRemoteContribution()
  const disposeContribution = ctx.typert.register(contribution)
  const gateway = new TypertGatewayService(ctx, {
    websocketHeartbeatIntervalMs: 30_000,
    streamInboxBytes: 1_024,
  })
  const peer = { signal: new AbortController().signal, principal: { kind: 'owner' } }
  const rpcCall = (endpoint: string, payload: unknown, signal: AbortSignal) => {
    const handler = rpc.handlers[0]
    if (handler === undefined) throw new Error('gateway registered no RPC handler')
    return handler.dispatch(endpoint, payload, signal, peer) as Promise<{
      ok: boolean
      value?: unknown
      error?: { code?: string }
    }>
  }
  const claims = (endpoint: string) => rpc.handlers.some(handler => handler.claim(endpoint))

  return { ctx, gateway, observeSession, dispose, peer, rpcCall, claims, contribution, disposeContribution }
}

describe('codexCompaction readonly Gateway binding', () => {
  it('is discovered from its registered descriptor and returns the session snapshot', async () => {
    const harness = await gatewayHarness()
    const controller = new AbortController()

    const result = await harness.rpcCall(
      `${COMPACTION_REMOTE_NAMESPACE}/read`,
      { args: { request: { sessionId: 'session-gw' } } },
      controller.signal,
    )

    expect(result.ok).toBe(true)
    const value = result.value as {
      v: number
      persistent: boolean
      facts: readonly { compactionId: string; status: string; checkpointSeq: number }[]
      records: readonly unknown[]
      session: { state: string; owner: { state: string } }
    }
    expect(value.v).toBe(1)
    expect(value.persistent).toBe(false)
    expect(value.facts).toHaveLength(1)
    expect(value.facts[0]).toMatchObject({
      compactionId: 'compaction-gw',
      status: 'native',
      checkpointSeq: 3,
    })
    expect(value.records).toEqual([])
    expect(value.session).toEqual({ state: 'unknown', owner: { state: 'unknown', evidence: [] }, at: expect.any(Number) })

    // The Gateway injected its own carrier signal and the cold-read option.
    expect(harness.observeSession).toHaveBeenCalledTimes(1)
    expect(harness.observeSession).toHaveBeenCalledWith('session-gw', {
      signal: controller.signal,
      projectionMode: 'none',
    })
    expect(harness.dispose).toHaveBeenCalledTimes(1)
    // The real connection layer claims the strict local endpoint.
    expect(harness.claims(`${COMPACTION_REMOTE_NAMESPACE}/read`)).toBe(true)

    // The public contribution carries a real package model (an Inspector can
    // name the one exported service and its method), not an undefined model.
    expect(harness.contribution.model.events).toEqual([])
    expect(harness.contribution.model.objects).toEqual([])
    expect(harness.contribution.model.services).toHaveLength(1)
    expect(harness.contribution.model.services[0]).toMatchObject({
      key: 'compactionDiagnostics',
      exportName: 'compactionDiagnostics',
    })
    expect(harness.contribution.model.services[0]?.members.map(member => member.name)).toEqual(['read'])
    // The real registry accepted that model and exposes it for live inspection.
    const typert = harness.ctx.typert
    expect(typert.getPackage('dsh-codex', 'host')?.model.services[0]?.key).toBe('compactionDiagnostics')

    // The registry disposer is the async `TypertDisposer`; awaiting it
    // withdraws the package model and the strict endpoint together.
    await harness.disposeContribution()
    expect(typert.getPackage('dsh-codex', 'host')).toBeUndefined()
    expect(typert.local.get(`${COMPACTION_REMOTE_NAMESPACE}/read`)).toBeUndefined()
    await harness.ctx.fiber.dispose()
  })

  it('rejects a malformed argument shape before the method runs', async () => {
    const harness = await gatewayHarness()

    const result = await harness.rpcCall(
      `${COMPACTION_REMOTE_NAMESPACE}/read`,
      { args: { sessionId: 'session-gw' } },
      new AbortController().signal,
    )

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('gateway/arguments-invalid')
    expect(harness.observeSession).not.toHaveBeenCalled()
    await harness.ctx.fiber.dispose()
  })

  it('maps an aborted carrier and a failed observation into Remote failures', async () => {
    const abortedHarness = await gatewayHarness()
    const aborted = new AbortController()
    aborted.abort(new Error('client cancel'))
    const abortedResult = await abortedHarness.rpcCall(
      `${COMPACTION_REMOTE_NAMESPACE}/read`,
      { args: { request: { sessionId: 'session-gw' } } },
      aborted.signal,
    )
    expect(abortedResult.ok).toBe(false)
    expect(abortedResult.error?.code).toBe('gateway/cancelled')

    const failingHarness = await gatewayHarness({
      observe: async () => {
        throw Object.assign(new Error('not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
      },
    })
    const failingResult = await failingHarness.rpcCall(
      `${COMPACTION_REMOTE_NAMESPACE}/read`,
      { args: { request: { sessionId: 'missing-session' } } },
      new AbortController().signal,
    )
    expect(failingResult.ok).toBe(false)
    expect(failingResult.error?.code).toBe('gateway/internal')

    await abortedHarness.ctx.fiber.dispose()
    await failingHarness.ctx.fiber.dispose()
  })
})

/**
 * The GUI reads through the product client contribution and the product reader.
 * The published client bundle needs the browser boot globals, so this harness
 * reproduces exactly its carrier call (`connection.rpc.call("/api", endpoint,
 * { args }, signal)`) against the real Gateway dispatch and feeds the resulting
 * `RemoteResult` to the product reader. The contribution itself still supplies
 * the wire field names and codecs asserted below.
 */
async function clientHarness(host: Awaited<ReturnType<typeof gatewayHarness>>) {
  // The host tsconfig is configured without a jsx option; this client helper
  // module contains no JSX and is transformed by the test runner.
  // @ts-expect-error -- client helper module extension outside the host tsconfig
  const product = await import('../src/client/CompactionStatus.tsx') as unknown as {
    createCompactionRemoteContribution(): {
      readonly package: string
      readonly descriptors: readonly unknown[]
    }
    createCompactionDiagnosticsReader(
      remote: () => unknown,
      ready?: Promise<boolean>,
    ): { read(sessionId: string, signal?: AbortSignal): Promise<unknown> }
  }
  const contribution = product.createCompactionRemoteContribution()
  const descriptor = contribution.descriptors[0] as {
    readonly id: string
    readonly service: string
    readonly namespace: string
    readonly method: string
    readonly parameters: readonly { readonly wire: string; create?: never; codec: { create: () => { parse(value: unknown): unknown } } }[]
    readonly cancellation?: { readonly parameter: string }
  }
  const namespace = {
    read: async (request: { sessionId: string }, signal?: AbortSignal) => {
      const args: Record<string, unknown> = Object.create(null)
      for (const parameter of descriptor.parameters) {
        args[parameter.wire] = parameter.codec.create().parse(request)
      }
      return host.rpcCall(`${descriptor.namespace}/${descriptor.method}`, { args }, signal ?? new AbortController().signal)
    },
  }
  const reader = product.createCompactionDiagnosticsReader(() => namespace as never)
  return { reader, contribution, descriptor }
}

describe('codexCompaction real client contribution over the Gateway wire', () => {
  it('reads a running request through the product reader', async () => {
    const host = await gatewayHarness({
      events: [{ type: 'compaction/start', seq: 1, time: 10, data: { compactionId: 'compaction-gw', turn: null } }],
      requests: [{ requestId: 'req-live', phase: 'running', compactionId: 'compaction-gw', startedAt: 5 }],
    })
    const client = await clientHarness(host)
    try {
      // The product contribution is the client-side wire identity the GUI mounts.
      expect(client.contribution.package).toBe('dsh-codex-client')
      expect(client.descriptor).toMatchObject({
        id: 'dsh-codex-client#codexCompaction/read',
        service: 'compactionDiagnostics',
        namespace: 'codexCompaction',
        method: 'read',
        cancellation: { parameter: 'signal' },
      })
      expect(client.descriptor.parameters.map(parameter => parameter.wire)).toEqual(['request'])

      const snapshot = await client.reader.read('session-gw', new AbortController().signal) as {
        requests?: readonly { requestId: string; phase: string }[]
      }

      expect(snapshot.requests?.[0]).toMatchObject({ requestId: 'req-live', phase: 'running' })
    } finally {
      await host.ctx.fiber.dispose()
    }
  })

  it('reads the completed native request through the same product reader', async () => {
    const host = await gatewayHarness({
      requests: [{ requestId: 'req-done', phase: 'completed', compactionId: 'compaction-gw' }],
    })
    const client = await clientHarness(host)
    try {
      const snapshot = await client.reader.read('session-gw', new AbortController().signal) as {
        requests?: readonly { requestId: string; phase: string; result?: string; checkpointSeq?: number }[]
        facts: readonly { status: string }[]
      }

      expect(snapshot.facts[0]?.status).toBe('native')
      expect(snapshot.requests?.[0]).toMatchObject({
        requestId: 'req-done',
        phase: 'completed',
        result: 'native',
        checkpointSeq: 3,
      })
    } finally {
      await host.ctx.fiber.dispose()
    }
  })
})
