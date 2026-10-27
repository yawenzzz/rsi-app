/** Project management RPC is shared by the main application and authenticated project UIs. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { installRpc, rpcMethod, type RpcHandler } from '../shared/rpc.ts'
import { workspaceIdSchema } from './catalog.ts'
import { cognitiveCommandSchema, cognitivePluginRequestSchema, cognitiveReviewSchema } from './cognition-schema.ts'
import type { CognitivePluginId } from './cognition-types.ts'
import type { AgentWorkspaces } from './index.ts'

export const managerMethods = ['workspaces', 'createWorkspace', 'openWorkspace', 'stopWorkspace', 'cognition',
  'updateCognition', 'reviewCognition', 'cognitivePlugins', 'registerCognitivePlugin', 'setCognitivePluginEnabled',
  'captureConversation'] as const
export const managerMethodSchema = z.enum(managerMethods)
export const managerRequestSchema = z.strictObject({ method: managerMethodSchema, args: z.unknown() })

/** Bind each wire request to a declared management operation and its validated inputs. */
export function managerHandlers(manager: AgentWorkspaces): Record<typeof managerMethods[number], RpcHandler> {
  const id = z.strictObject({ id: workspaceIdSchema })
  return {
    workspaces: rpcMethod(z.strictObject({}), () => manager.workspaces()),
    createWorkspace: rpcMethod(z.strictObject({ request: z.strictObject({ name: z.string().trim().min(1).max(128), path: z.string() }) }),
      ({ request }) => manager.createWorkspace(request)),
    openWorkspace: rpcMethod(id, ({ id }) => manager.openWorkspace(id)),
    stopWorkspace: rpcMethod(id, ({ id }) => manager.stopWorkspace(id)),
    cognition: rpcMethod(id, ({ id }) => manager.cognition(id)),
    updateCognition: rpcMethod(z.strictObject({ id: workspaceIdSchema, request: cognitiveCommandSchema }),
      ({ id, request }) => manager.updateCognition(request, id)),
    reviewCognition: rpcMethod(z.strictObject({ id: workspaceIdSchema, request: cognitiveReviewSchema }),
      ({ id, request }) => manager.reviewCognition(request, id)),
    cognitivePlugins: rpcMethod(id, ({ id }) => manager.cognitivePlugins(id)),
    registerCognitivePlugin: rpcMethod(z.strictObject({ id: workspaceIdSchema, request: cognitivePluginRequestSchema }),
      ({ id, request }) => manager.registerCognitivePlugin(request, id)),
    setCognitivePluginEnabled: rpcMethod(z.strictObject({ id: workspaceIdSchema,
      pluginId: z.uuid().transform(brandString<CognitivePluginId>), enabled: z.boolean() }),
      ({ id, pluginId, enabled }) => manager.setCognitivePluginEnabled(pluginId, enabled, id)),
    captureConversation: rpcMethod(z.strictObject({ id: workspaceIdSchema, taskId: z.string().min(1) }),
      ({ id, taskId }) => manager.captureConversation(taskId, id)),
  }
}

/** Serve project management only through DSH's authenticated browser transport. */
export function installManagerRpc(ctx: Context, manager: AgentWorkspaces, maxBytes: number): void {
  installRpc(ctx, 'agentWorkspaces', managerHandlers(manager), maxBytes)
}

/** Forward authenticated UI operations to the parent; model tools use their narrower control operations. */
export function installManagerProxy(ctx: Context, call: (operation: string, request: unknown) => Promise<unknown>, maxBytes: number): void {
  installRpc(ctx, 'agentWorkspaces', Object.fromEntries(managerMethods.map(method => [method,
    (args: unknown) => call('ui', { method, args }),
  ])), maxBytes)
}
