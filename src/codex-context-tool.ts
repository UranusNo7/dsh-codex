/**
 * Model-facing `codex_context` tool: owner facts, one queued native compaction
 * request, and bounded recall from the current Agent's own session.
 *
 * Registration is per-Agent and only for Agents routed to the Codex provider:
 * the tool is registered into `agent.ctx` when that Agent is created, never
 * globally, so no other provider's Agent sees it.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import {
  CODEX_CONTEXT_PROVIDER,
  agentProvider,
  type CodexContextAgent,
  type CodexContextController,
  type CompactionOwner,
  type RecallItem,
} from './codex-context.ts'

/** Stable tool name exposed to the model. */
export const CODEX_CONTEXT_TOOL_NAME = 'codex_context'
/** Scoped system-prompt section carrying the tool's short usage rule. */
export const CODEX_CONTEXT_SECTION_NAME = 'codex-context-guidance'
/** Fixed order inside the prompt; unique per Agent scope. */
export const CODEX_CONTEXT_SECTION_ORDER = 900

/** One sentence: only the trigger the tool schema itself cannot state. */
export const CODEX_CONTEXT_GUIDANCE =
  'When the user asks to compact this session, call `codex_context` with `action: "request_compaction"`; it queues the work, which runs after the current turn — a queued ticket is not a finished compaction.'

interface CodexContextToolArgs {
  readonly action: 'status' | 'request_compaction' | 'recall'
  readonly from_seq?: number
  readonly to_seq?: number
  readonly query?: string
  readonly limit?: number
}

function ownerValue(owner: CompactionOwner): Record<string, unknown> {
  return {
    state: owner.state,
    evidence: [...owner.evidence],
    ...(owner.provider === undefined ? {} : { provider: owner.provider }),
  }
}

function recallItemValue(item: RecallItem): Record<string, unknown> {
  return {
    seq: item.seq,
    type: item.type,
    kind: item.kind,
    text: item.text,
    ...(item.role === undefined ? {} : { role: item.role }),
    ...(item.truncated === undefined ? {} : { truncated: item.truncated }),
  }
}

/**
 * Build the tool definition over a controller. The definition itself is pure:
 * every effect happens through the controller when the model calls it.
 * @param controller - owner/queue/recall controller for the current Agent.
 * @param effectiveProvider - last verified route of this Agent, when known.
 * @returns the registry-ready tool definition.
 */
export function codexContextTool(
  controller: CodexContextController,
  effectiveProvider?: (agent: CodexContextAgent) => string | undefined,
): ToolDefinition {
  return defineTool({
    name: CODEX_CONTEXT_TOOL_NAME,
    description: [
      'Inspect this session\'s Codex compaction ownership and request one native Codex compaction, or recall bounded plain-text history from this same session.',
      'Actions: status (read-only facts: owner state, queued ticket, last boundary outcome); request_compaction (accept exactly one request, returns a queued ticket — execution happens at the next idle boundary, never inside this call); recall (bounded text events with sequence numbers from the current session).',
      'This tool never targets another session: it always uses the calling agent\'s own session and accepts no session id. A request is not a completed compaction; report only what the returned ticket/outcome says.',
      'If this session switches away from the Codex provider, the definition may remain listed for one turn; every call in that turn refuses with reason "provider".',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'request_compaction', 'recall'],
        description:
          'What to do: "status" reads owner/queue/outcome facts; "request_compaction" queues one native compaction for the next idle boundary; "recall" reads bounded text history from the current session.',
      },
      from_seq: {
        type: 'integer',
        description:
          'Only for action="recall": inclusive first sequence number. Defaults to the start of a bounded scan window.',
      },
      to_seq: {
        type: 'integer',
        description:
          'Only for action="recall": exclusive last sequence number. Defaults to the current end of the log.',
      },
      query: {
        type: 'string',
        description:
          'Only for action="recall": case-insensitive plain-text filter applied to extracted text.',
      },
      limit: {
        type: 'integer',
        description:
          'Only for action="recall": maximum items, default 20, capped at 50.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          reason: {
            type: 'string',
            enum: [
              'owner',
              'provider',
              'disposed',
              'identity',
              'source-turn',
              'history-unavailable',
              'cooldown',
              'no-agent',
              'no-session',
            ],
          },
          owner: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              state: { type: 'string', required: true },
              evidence: {
                type: 'array',
                required: true,
                items: { type: 'string' },
              },
              provider: { type: 'string' },
            },
          },
          queued: {
            type: 'object',
            additionalProperties: false,
            properties: {
              requestId: { type: 'string', required: true },
              status: { type: 'string', required: true },
              boundary: { type: 'string', required: true },
              requestedAt: { type: 'integer', required: true },
            },
          },
          already_queued: { type: 'boolean' },
          retry_at: { type: 'integer' },
          last_outcome: {
            type: 'object',
            additionalProperties: false,
            properties: {
              state: { type: 'string', required: true },
              requestId: { type: 'string', required: true },
              at: { type: 'integer', required: true },
              reason: { type: 'string' },
            },
          },
          local_estimate: {
            type: 'object',
            additionalProperties: false,
            properties: {
              tokens: { type: 'integer', required: true },
              source: { type: 'string', required: true },
              at: { type: 'integer', required: true },
            },
          },
          provider_usage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              inputTokens: { type: 'integer' },
              outputTokens: { type: 'integer' },
              totalTokens: { type: 'integer' },
              source: { type: 'string', required: true },
              at: { type: 'integer', required: true },
            },
          },
          recall: {
            type: 'object',
            additionalProperties: false,
            properties: {
              fromSeq: { type: 'integer', required: true },
              toSeqExclusive: { type: 'integer', required: true },
              scanned: { type: 'integer', required: true },
              truncated: { type: 'boolean', required: true },
              nextFromSeq: { type: 'integer' },
              items: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    seq: { type: 'integer', required: true },
                    type: { type: 'string', required: true },
                    kind: { type: 'string', required: true },
                    role: { type: 'string' },
                    text: { type: 'string', required: true },
                    truncated: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: JSON.stringify(value, null, 2) },
      ],
    },
    isConcurrencySafe: (args) => args.action === 'status' || args.action === 'recall',
    execute: (async (args: CodexContextToolArgs, exec: ToolRunContext) => {
      const agent = exec.agent as CodexContextAgent | undefined
      if (agent === undefined) {
        return { action: args.action, ok: false, reason: 'no-agent' as const }
      }
      // The tool is registered only for Codex-routed Agents; if routing changed
      // after installation, every action refuses instead of acting elsewhere.
      // The verified route wins over a stale header (one turn may still list
      // the schema, and that turn's calls refuse here).
      const provider = effectiveProvider?.(agent) ?? agentProvider(agent)
      if (provider !== CODEX_CONTEXT_PROVIDER) {
        return {
          action: args.action,
          ok: false as const,
          reason: 'provider' as const,
          owner: ownerValue(controller.owner(agent)),
        }
      }
      switch (args.action) {
        case 'status': {
          const snapshot = controller.snapshot(agent)
          return {
            action: 'status' as const,
            ok: true as const,
            owner: ownerValue(snapshot.owner),
            ...(snapshot.queued === undefined
              ? {}
              : {
                  queued: {
                    requestId: snapshot.queued.requestId,
                    status: snapshot.queued.status,
                    boundary: snapshot.queued.boundary,
                    requestedAt: snapshot.queued.requestedAt,
                  },
                }),
            ...(snapshot.lastOutcome === undefined
              ? {}
              : {
                  last_outcome: {
                    state: snapshot.lastOutcome.state,
                    requestId: snapshot.lastOutcome.requestId,
                    at: snapshot.lastOutcome.at,
                    ...(snapshot.lastOutcome.reason === undefined
                      ? {}
                      : { reason: snapshot.lastOutcome.reason }),
                  },
                }),
            ...(snapshot.localEstimate === undefined
              ? {}
              : {
                  local_estimate: {
                    tokens: snapshot.localEstimate.tokens,
                    source: snapshot.localEstimate.source,
                    at: snapshot.localEstimate.at,
                  },
                }),
            ...(snapshot.providerUsage === undefined
              ? {}
              : {
                  provider_usage: {
                    source: snapshot.providerUsage.source,
                    at: snapshot.providerUsage.at,
                    ...(snapshot.providerUsage.inputTokens === undefined
                      ? {}
                      : { inputTokens: snapshot.providerUsage.inputTokens }),
                    ...(snapshot.providerUsage.outputTokens === undefined
                      ? {}
                      : { outputTokens: snapshot.providerUsage.outputTokens }),
                    ...(snapshot.providerUsage.totalTokens === undefined
                      ? {}
                      : { totalTokens: snapshot.providerUsage.totalTokens }),
                  },
                }),
          }
        }
        case 'request_compaction': {
          const result = controller.requestCompaction(agent, { callId: String(exec.callId) })
          const owner = ownerValue(controller.owner(agent))
          switch (result.status) {
            case 'queued':
              return {
                action: 'request_compaction' as const,
                ok: true as const,
                owner,
                queued: {
                  requestId: result.ticket.requestId,
                  status: result.ticket.status,
                  boundary: result.ticket.boundary,
                  requestedAt: result.ticket.requestedAt,
                },
              }
            case 'already-queued':
              return {
                action: 'request_compaction' as const,
                ok: true as const,
                owner,
                already_queued: true as const,
                queued: {
                  requestId: result.ticket.requestId,
                  status: result.ticket.status,
                  boundary: result.ticket.boundary,
                  requestedAt: result.ticket.requestedAt,
                },
              }
            case 'cooldown':
              return {
                action: 'request_compaction' as const,
                ok: false as const,
                reason: 'cooldown' as const,
                owner,
                retry_at: result.retryAt,
              }
            case 'refused':
              return {
                action: 'request_compaction' as const,
                ok: false as const,
                reason: result.reason,
                owner: ownerValue(result.owner),
              }
          }
        }
        case 'recall': {
          const result = await controller.recall(agent, {
            ...(args.from_seq === undefined ? {} : { fromSeq: args.from_seq }),
            ...(args.to_seq === undefined ? {} : { toSeq: args.to_seq }),
            ...(args.query === undefined ? {} : { query: args.query }),
            ...(args.limit === undefined ? {} : { limit: args.limit }),
            signal: exec.signal,
          })
          if (!result.ok) {
            return {
              action: 'recall' as const,
              ok: false as const,
              reason: result.reason,
            }
          }
          return {
            action: 'recall' as const,
            ok: true as const,
            owner: ownerValue(controller.owner(agent)),
            recall: {
              fromSeq: result.fromSeq,
              toSeqExclusive: result.toSeqExclusive,
              scanned: result.scanned,
              truncated: result.truncated,
              items: result.items.map(recallItemValue),
              ...(result.nextFromSeq === undefined
                ? {}
                : { nextFromSeq: result.nextFromSeq }),
            },
          }
        }
      }
    }) as never,
  })
}

/** The Agent-scoped runtime pieces this installer touches. */
export interface CodexContextAgentRuntime extends CodexContextAgent {
  readonly ctx: {
    readonly tools: { register(definition: ToolDefinition): () => void }
    readonly systemPrompt?: {
      section(section: PromptSection): () => void
    }
  }
}

/** Provider fact carried by one durable `request/header` session event. */
interface RequestHeaderEvent {
  readonly type: string
  readonly data?: { readonly header?: { readonly config?: { readonly provider?: string } } }
}

/** The Host surface used for per-Agent installation. */
export interface CodexContextInstallHost {
  readonly agents: { list(): readonly CodexContextAgent[] }
  on(
    event: 'agent/created',
    listener: (payload: { readonly agent: CodexContextAgent }) => undefined,
  ): () => void
  on(
    event: 'agent/disposed',
    listener: (payload: { readonly agent: CodexContextAgent }) => void,
  ): () => void
  on(
    event: 'agent/request',
    listener: (
      payload: { readonly agent: CodexContextAgent },
      next: () => Promise<{ readonly provider?: string }>,
    ) => Promise<{ readonly provider?: string }>,
  ): () => void
  on(
    event: 'session/event',
    listener: (
      session: { readonly id: string },
      event: RequestHeaderEvent,
    ) => void,
  ): () => void
  on(event: 'tools/change', listener: () => void): () => void
}

/**
 * Install the tool and its short prompt rule into every live Codex-routed
 * Agent, and keep that set current while the plugin stays loaded.
 * @param host - Host agent roster and event source.
 * @param controller - shared owner/queue/recall controller.
 * @returns the disposer removing every registration and listener.
 */
export function installCodexContextTools(
  host: CodexContextInstallHost,
  controller: CodexContextController,
): () => void {
  const installed = new Map<
    string,
    { provider: string; tools: () => void; section?: () => void }
  >()
  // Last verified route per Agent. A stale request header may still name the
  // old provider for one turn; this map is the authority for execute checks.
  const effectiveProvider = new Map<string, string | undefined>()
  let syncing = false

  const remove = (agentId: string): void => {
    const current = installed.get(agentId)
    if (current === undefined) return
    installed.delete(agentId)
    current.section?.()
    current.tools()
  }

  const reconcile = (agent: CodexContextAgent, verifiedProvider?: string): void => {
    if (syncing) return
    const provider = verifiedProvider ?? effectiveProvider.get(agent.id) ?? agentProvider(agent)
    const current = installed.get(agent.id)
    if (current !== undefined && current.provider === provider) return
    syncing = true
    try {
      if (current !== undefined) remove(agent.id)
      if (provider !== CODEX_CONTEXT_PROVIDER) return
      const runtime = agent as CodexContextAgentRuntime
      let toolsDispose: () => void
      try {
        toolsDispose = runtime.ctx.tools.register(
          codexContextTool(controller, (candidate) => effectiveProvider.get(candidate.id)),
        )
      } catch {
        // An Agent whose scope is already closing simply gets no tool.
        return
      }
      let sectionDispose: (() => void) | undefined
      try {
        sectionDispose = runtime.ctx.systemPrompt?.section({
          name: CODEX_CONTEXT_SECTION_NAME,
          order: CODEX_CONTEXT_SECTION_ORDER,
          text: CODEX_CONTEXT_GUIDANCE,
        })
      } catch {
        sectionDispose = undefined
      }
      installed.set(agent.id, {
        provider,
        tools: toolsDispose,
        ...(sectionDispose === undefined ? {} : { section: sectionDispose }),
      })
    } finally {
      syncing = false
    }
  }

  const sync = (): void => {
    const live = new Set(host.agents.list().map((agent) => agent.id))
    for (const agentId of [...installed.keys()]) {
      if (!live.has(agentId)) remove(agentId)
    }
    for (const agent of host.agents.list()) reconcile(agent)
  }

  const offCreated = host.on('agent/created', ({ agent }) => {
    reconcile(agent)
    return undefined
  })
  const offDisposed = host.on('agent/disposed', ({ agent }) => {
    remove(agent.id)
  })
  // A provider switch is durable in `request/header`; reconcile exactly that
  // Agent instead of polling the roster.
  // A provider switch is verified at the `agent/request` waterfall (the config
  // that actually routes this step) and, durably, by `request/header` events.
  // Neither path infers the current route from the previous header.
  const offRequest = host.on('agent/request', async ({ agent }, next) => {
    const config = await next()
    const provider = typeof config.provider === 'string' ? config.provider : undefined
    effectiveProvider.set(agent.id, provider)
    if (provider !== undefined) reconcile(agent, provider)
    return config
  })
  const offRequestHeader = host.on('session/event', (session, event) => {
    if (event.type !== 'request/header') return
    const provider = event.data?.header?.config?.provider
    if (provider === undefined) return
    const agent = host.agents.list().find((candidate) => candidate.id === session.id)
    if (agent === undefined) return
    effectiveProvider.set(agent.id, provider)
    reconcile(agent, provider)
  })
  const offChanged = host.on('tools/change', () => {
    sync()
  })
  sync()

  return () => {
    offCreated()
    offDisposed()
    offRequest()
    offRequestHeader()
    offChanged()
    for (const agentId of [...installed.keys()]) remove(agentId)
    effectiveProvider.clear()
  }
}
