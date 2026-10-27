/** Project-owned cognitive bundle registration and profile selection. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { jsonTextOutput } from '../shared/json-text-output.ts'
import { cognitivePluginRequestSchema } from './cognition-schema.ts'
import type { CognitivePluginRequest, CognitivePluginSnapshot, CognitiveSnapshot, CognitivePluginId } from './cognition-types.ts'

/** Workspace-derived artifact operations never mutate the application profile. */
export interface CognitivePluginOperations {
  status(): Promise<CognitivePluginSnapshot>
  select(id: CognitivePluginId, enabled: boolean, execution: ToolRunContext): Promise<CognitivePluginSnapshot>
  register(request: CognitivePluginRequest): Promise<CognitiveSnapshot>
}

/**
 * Register artifact inspection and binding without bypassing plugin installation permissions.
 * @param ctx - Tool registry owner.
 * @param operations - Selected workspace operations.
 * @param maxBytes - Complete response allowance.
 */
export function installCognitivePluginTools(ctx: Context, operations: CognitivePluginOperations, maxBytes: number): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'agent_bundle',
    description: 'Maintain cognitive bundles for the current project Agent. Omit arguments to obtain its plugins, bundles and profile directories. Implement plugins under plugins/ and compose ESM bundles under bundles/ with file: dependencies on local plugins. Register a tested bundle during Repair using command_json {revision,taskId,units:[{id,revision}],directory}. Keep the package name and register changed content against a new cognitive revision. Then pass bundle_id and enabled to select it in this Agent profile only. Disable superseded versions before verification. Selection saves the composition without executing code; Restart the idle Agent to apply the selection to its ordinary conversations. Do not install Repair bundles into the application profile with plugin_manager. Neither selection nor execution assigns cognitive scores.',
    parameters: {
      command_json: { type: 'string', description: 'JSON bundle registration; cannot be combined with selection.' },
      bundle_id: { type: 'string', description: 'Registered bundle UUID in this Agent workspace.' },
      enabled: { type: 'boolean', description: 'Select or deselect the registered bundle for future Agent executions.' },
    },
    output: jsonTextOutput,
    execute: async (args, execution) => {
      if (args.bundle_id !== undefined || args.enabled !== undefined) {
        if (args.command_json !== undefined || args.bundle_id === undefined || args.enabled === undefined) {
          throw new Error('Bundle selection requires bundle_id and enabled without command_json')
        }
        await operations.select(brandString<CognitivePluginId>(z.uuid().parse(args.bundle_id)), args.enabled, execution)
        return { result: JSON.stringify({ bundleId: args.bundle_id, selected: args.enabled }) }
      }
      if (args.command_json !== undefined) {
        const state = await operations.register(cognitivePluginRequestSchema.parse(JSON.parse(args.command_json)))
        const result = JSON.stringify({ revision: state.revision, plugin: state.plugins.at(-1) })
        return { result: Buffer.byteLength(result) <= maxBytes ? result : JSON.stringify({ revision: state.revision,
          pluginId: state.plugins.at(-1)?.id, omitted: true }) }
      }
      const result = JSON.stringify(await operations.status())
      if (Buffer.byteLength(result) > maxBytes) throw new Error('Plugin inventory exceeds allowance; inspect the workbench')
      return { result }
    },
    presentCall: () => ({ card: 'generic', title: 'Manage improvement plugin', kind: 'other' }),
  })))
}
