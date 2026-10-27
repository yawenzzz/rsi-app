/** One installable RSI application bundle over the unmodified official DSH runtime. */
import type { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import AgentWorkspaces, { Config as ProjectConfig, type Config as ProjectOptions } from './harness/index.ts'
import * as AgentPlugin from './agent/index.ts'
import { workflowInstructions } from './shared/workflow.ts'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Deployment role and project-owned runtime configuration. */
export interface Config {
  role: 'manager' | 'agent'
  projects: ProjectOptions
  agent: AgentPlugin.Config
}

/** Main and project profiles share one package and choose their role explicitly. */
export const Config = schema.object({
  role: schema.union(['manager', 'agent']).default('manager'),
  projects: ProjectConfig.default({ modelProviders: [{ provider: 'openai-codex', settingsNamespace: 'codex-subscription', bundle: 'dsh-codex-subscription' }] }),
  agent: schema.object({ workflowInstructions: schema.string().default(workflowInstructions),
    controlTimeoutMs: schema.number().min(1).default(30000), maxToolOutputBytes: schema.number().min(256).default(32768),
    maxControlBytes: schema.number().min(256).default(1048576) }).default({}),
})

export const name = 'rsi-app'
export const inject = ['connection', 'webServer', 'profileContext']

/** Mount the requested role and identify this page for RSI's own client plugin. */
export function apply(ctx: Context, config: Config): void {
  const projectId = config.role === 'agent'
    ? z.string().regex(/^(?:a|w)-[a-f0-9-]{36}$/).parse(process.env['DSH_RSI_PROJECT_ID']) : null
  ctx.on('webserver/index-inject', table => {
    table.push({ kind: 'global', name: '__RSI_PAGE__', value: {
      projectId, requestTimeoutMs: config.projects.startupTimeoutMs + config.agent.controlTimeoutMs,
      catalogPollIntervalMs: config.projects.catalogPollIntervalMs,
      managerUrl: config.role === 'agent' ? z.url().parse(process.env['DSH_RSI_MANAGER_URL']) : ctx.webServer.getOrigin(),
    } })
  })
  if (config.role === 'manager') ctx.plugin(AgentWorkspaces, config.projects)
  else ctx.plugin(AgentPlugin, config.agent)
}
