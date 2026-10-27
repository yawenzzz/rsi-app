/** Optional paper-research APIs use the same authenticated connection as native DSH settings. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { installRpc, rpcMethod } from '../shared/rpc.ts'
import type { RsiService } from './index.ts'
import type { CandidateId } from './strategy/experiment-schema.ts'
import type { TokenId } from './data/market.ts'
import type { DecisionId } from './queries/types.ts'
import { decisionQuerySchema, opportunityQuerySchema } from './queries/schemas.ts'

/** Register existing paper operations without depending on generated upstream schemas. */
export function installPaperRpc(ctx: Context, service: RsiService, maxBytes: number): void {
  const empty = z.strictObject({})
  installRpc(ctx, 'rsi', {
    jevSettings: rpcMethod(empty, () => service.remoteJevSettings()),
    status: rpcMethod(empty, () => service.remoteStatus()),
    overview: rpcMethod(empty, () => service.remoteOverview()),
    opportunities: rpcMethod(z.strictObject({ query: opportunityQuerySchema }), ({ query }) => service.remoteOpportunities(query)),
    opportunity: rpcMethod(z.strictObject({ id: z.string().min(1) }), ({ id }) => service.remoteOpportunity(id)),
    strategies: rpcMethod(empty, () => service.remoteStrategies()),
    strategy: rpcMethod(z.strictObject({ id: z.string().min(1).transform(brandString<CandidateId>) }), ({ id }) => service.remoteStrategy(id)),
    risk: rpcMethod(empty, () => service.remoteRisk()),
    position: rpcMethod(z.strictObject({ id: z.string().min(1).transform(brandString<TokenId>) }), ({ id }) => service.remotePosition(id)),
    decisions: rpcMethod(z.strictObject({ query: decisionQuerySchema }), ({ query }) => service.remoteDecisions(query)),
    decision: rpcMethod(z.strictObject({ id: z.string().min(1).transform(brandString<DecisionId>) }), ({ id }) => service.remoteDecision(id)),
    operations: rpcMethod(z.strictObject({ revision: z.int().nonnegative(), stopped: z.boolean(), reason: z.string().min(1).max(2048) }),
      ({ revision, stopped, reason }) => service.remoteOperations(revision, stopped, reason)),
    refresh: rpcMethod(empty, () => service.remoteRefresh()),
    control: rpcMethod(z.strictObject({ command: z.strictObject({ expectedRevision: z.int().nonnegative(),
      action: z.enum(['pause', 'resume']), reason: z.string().min(1).max(2048) }) }), ({ command }) => service.remoteControl(command)),
    research: rpcMethod(z.strictObject({ paused: z.boolean() }), ({ paused }) => service.remoteResearch(paused)),
    objective: rpcMethod(z.strictObject({ expectedRevision: z.int().nonnegative(), objective: z.string().trim().min(1).max(4096) }),
      ({ expectedRevision, objective }) => service.remoteObjective(expectedRevision, objective)),
  }, maxBytes)
}
