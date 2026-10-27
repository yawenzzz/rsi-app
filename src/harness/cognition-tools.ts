/** Model-facing cognitive proposals and real task execution; human grading is deliberately absent. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { jsonTextOutput } from '../shared/json-text-output.ts'
import { z } from 'zod'
import type { CognitiveCommand, CognitiveSnapshot } from './cognition-types.ts'
import { cognitiveCommandSchema } from './cognition-schema.ts'

/** Caller-scoped operations capture the selected workspace before asynchronous execution. */
export interface CognitiveToolOperations {
  snapshot(): Promise<CognitiveSnapshot>
  update(request: CognitiveCommand): Promise<CognitiveSnapshot>
}

/**
 * Register logged proposals and isolated executions without a score-writing tool.
 * @param ctx - Scoped tool registry owner.
 * @param operations - Workspace-derived service operations.
 * @param maxBytes - Complete rendered response allowance.
 */
export function installCognitiveTools(ctx: Context, operations: CognitiveToolOperations, maxBytes: number): void {
  const render = (state: CognitiveSnapshot) => {
    const compact = { ...state,
      evidence: state.evidence.map(({ content, ...record }) => ({ ...record, bytes: Buffer.byteLength(content) })) }
    const result = JSON.stringify(compact)
    return { result: Buffer.byteLength(result) <= maxBytes ? result : JSON.stringify({ revision: state.revision,
      omitted: true, reason: 'Cognitive history exceeds the response allowance; inspect it in the workbench.' }) }
  }
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'agent_cognition',
    description: 'Read or update generic cognitive tasks. Omit command_json for status. Commands carry the current revision. unit: {action,id:null or existing UUID,kind:judgment|method,capability,content,applicability,expectedOutcome,implementation:[]}; task: {action,objective,outline,situation,criteria}; select: {action,taskId,units:[{id,revision}]}; advance, reassess, complete: {action,taskId}; evidence: {action,taskId,units,content}. Clarify precedes self-evaluation. Missing or failing evidence enters repair; reviewed known-effective units allow execute. Human acceptance of the latest execution is required for completion. Submitted observations never update scores. Task criteria are immutable; create a new task when they change. No operation can manufacture human assessments.',
    parameters: { command_json: { type: 'string', description: 'JSON command with the current cognitive revision; omit to inspect.' },
      evidence_id: { type: 'string', description: 'Read retained evidence by UUID instead of updating or listing state.' },
      offset: { type: 'number', description: 'Grapheme offset for an evidence read; defaults to zero.' } },
    output: jsonTextOutput,
    execute: async (args) => {
      if (args.evidence_id !== undefined) {
        if (args.command_json !== undefined) throw new Error('Evidence reads cannot include a mutation command')
        const evidence = (await operations.snapshot()).evidence.find(item => item.id === args.evidence_id)
        if (evidence === undefined) throw new Error('Cognitive evidence does not exist')
        const offset = args.offset === undefined ? 0 : z.int().nonnegative().parse(args.offset)
        const characters = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(evidence.content), item => item.segment)
        if (offset > characters.length) throw new Error('Evidence offset exceeds retained content')
        let end = Math.min(characters.length, offset + Math.max(1, Math.floor(maxBytes / 12)))
        const response = () => JSON.stringify({ id: evidence.id, contentHash: evidence.contentHash,
          offset, content: characters.slice(offset, end).join(''), nextOffset: end < characters.length ? end : null })
        let result = response()
        while (Buffer.byteLength(result) > maxBytes && end > offset) { end--; result = response() }
        if (Buffer.byteLength(result) > maxBytes || end === offset && offset < characters.length) {
          throw new Error('Evidence character exceeds the response allowance; inspect the full record in the workbench')
        }
        return Promise.resolve({ result })
      }
      if (args.offset !== undefined) throw new Error('An offset requires evidence_id')
      return render(args.command_json === undefined ? await operations.snapshot()
        : await operations.update(cognitiveCommandSchema.parse(JSON.parse(args.command_json))))
    },
    presentCall: () => ({ card: 'generic', title: 'Manage cognitive task', kind: 'other' }),
  })))
}
