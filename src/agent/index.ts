/** Project-scoped cognitive tools over the owning application's authenticated control channel. */
import type { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { jsonTextOutput } from '../shared/json-text-output.ts'
import { installCognitiveTools, installCognitivePluginTools, cognitiveSnapshotSchema,
  cognitivePluginSnapshotSchema } from '../harness/agent-tools.ts'
import { approveEscalation } from '@deepseek-ai/dsh-sandbox'
import { exitOnStdinEnd } from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-workspace'
import { AgentEvidence } from './evidence.ts'
import { installWorkflow } from './workflow.ts'
import { installManagerProxy } from '../harness/rpc.ts'
export { AgentEvidence } from './evidence.ts'

/** Control request and model response bounds for one Agent. */
export interface Config {
  /** Four-phase policy added independently of the provider persona. */
  workflowInstructions: string
  /** Deadline for each project control request, in milliseconds. */
  controlTimeoutMs: number
  /** Maximum complete model tool response size in bytes. */
  maxToolOutputBytes: number
  /** Maximum authenticated UI control request bytes. */
  maxControlBytes: number
}
/** Project bridge configuration; no executable version or draft fields exist. */
export const Config = schema.object({ workflowInstructions: schema.string().required(),
  controlTimeoutMs: schema.number().min(1).default(30000),
  maxToolOutputBytes: schema.number().min(256).default(32768),
  maxControlBytes: schema.number().min(256).default(1048576) })
/** Project capability tool owner. */
export const name = 'rsi-agent'
/** Model tools and existing approval policy are shared by the native conversation. */
export const inject = ['tools', 'sandboxPolicy', 'systemPrompt', 'workspaceRegistry', 'connection']

/**
 * Register cognitive operations scoped to this process's single project identity.
 * @param ctx - Native Agent runtime services.
 * @param config - Bounded control policy.
 * @returns after the task working directory is registered for native conversation creation.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const parentStdin = process.env['DSH_AGENT_PARENT_STDIN']
  if (parentStdin !== undefined) {
    if (parentStdin !== 'pipe') throw new Error('Project Agent parent stdin must be a pipe')
    exitOnStdinEnd(ctx, 'rsi-agent.parent')
    process.stdin.resume()
  }
  await ctx.workspaceRegistry.create(process.cwd())
  const url = process.env['DSH_AGENT_CONTROL_URL']
  const token = process.env['DSH_AGENT_CONTROL_TOKEN']
  if (url === undefined || token === undefined || new URL(url).hostname !== '127.0.0.1') {
    throw new Error('Project Agent requires its application-owned control channel')
  }
  const digest = process.env['DSH_AGENT_COMPOSITION_HASH']
  if (digest === undefined || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Project Agent requires a composition digest')
  ctx.effect(() => ctx.systemPrompt.section({ name: 'agent:composition', order: 100,
    text: `Agent composition digest: ${digest}` }))
  installWorkflow(ctx, config.workflowInstructions)
  ctx.plugin(AgentEvidence)
  const lifetime = new AbortController()
  const requests = new Set<Promise<unknown>>()
  const call = (operation: string, request: unknown = null): Promise<unknown> => {
    const result = (async () => {
      const response = await fetch(url, { method: 'POST',
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(config.controlTimeoutMs)]),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ operation, request }) })
      const body = z.object({ result: z.unknown().optional(), error: z.string().optional() }).parse(await response.json())
      if (!response.ok || body.error !== undefined) throw new Error(body.error ?? 'Project control request failed')
      return body.result
    })()
    requests.add(result)
    void result.then(() => { requests.delete(result) }, () => { requests.delete(result) })
    return result
  }
  ctx.effect(() => async () => { lifetime.abort(); await Promise.allSettled(requests) })
  installManagerProxy(ctx, call, config.maxControlBytes)
  installTools(ctx, () => call('context'))
  installCognitiveTools(ctx, {
    snapshot: async () => cognitiveSnapshotSchema.parse(await call('cognition')),
    update: async request => cognitiveSnapshotSchema.parse(await call('update', request)),
  }, config.maxToolOutputBytes)
  installCognitivePluginTools(ctx, {
    status: async () => cognitivePluginSnapshotSchema.parse(await call('plugins')),
    register: async request => cognitiveSnapshotSchema.parse(await call('register', request)),
    select: async (id, enabled, execution) => {
      await approveEscalation({ requestedMode: 'danger-full-access',
        effectiveMode: ctx.sandboxPolicy.resolve(execution.agent === undefined ? {} : { session: execution.agent.session }).mode,
        subject: 'project capability selection', justification: 'Select this project bundle for execution after the Agent restarts.',
      }, { approver: ctx.get('approval'), agent: execution.agent, callId: execution.callId, toolName: 'agent_bundle', signal: execution.signal })
      return cognitivePluginSnapshotSchema.parse(await call('select', { id, enabled }))
    },
  }, config.maxToolOutputBytes)
}

/**
 * Register native Agent identity inspection without invoking the control channel during schema discovery.
 * @param ctx - Model tool owner.
 * @param read - Scoped runtime identity reader.
 */
export function installTools(ctx: Context, read: () => Promise<unknown>): void {
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'agent_context',
    description: 'Read this Agent identity, project root, task workspace, plugin and bundle directories, profile directory, loaded profile and composition digest. Store task files in the task workspace. This conversation already runs with that profile.',
    parameters: {}, output: jsonTextOutput,
    execute: async () => ({ result: JSON.stringify(await read()) }),
    presentCall: () => ({ card: 'generic', title: 'Inspect project Agent', kind: 'read' }),
  })))
}
