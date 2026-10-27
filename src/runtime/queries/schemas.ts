/** Shared validation for paper-research filters at tool and HTTP entry points. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ConsoleCursor, DecisionQuery, OpportunityQuery } from './types.ts'

const cursor = z.string().transform(brandString<ConsoleCursor>).nullable()
export const opportunityQuerySchema: z.ZodType<OpportunityQuery> = z.strictObject({
  search: z.string().max(500), category: z.string().nullable(),
  state: z.enum(['unforecasted', 'collecting', 'paper-eligible', 'rejected', 'stale', 'settled']).nullable(),
  minLiquidityMicros: z.number().int().nonnegative(), maxHorizonMs: z.number().positive().nullable(),
  maxAgeMs: z.number().positive().nullable(), order: z.enum(['edge', 'liquidity', 'deadline', 'newest']),
  cursor, limit: z.number().int().min(1).max(100),
})
export const decisionQuerySchema: z.ZodType<DecisionQuery> = z.strictObject({
  search: z.string().max(500), kinds: z.array(z.enum(['data', 'research', 'forecast', 'trade', 'settlement', 'release', 'control'])),
  cursor, limit: z.number().int().min(1).max(100),
})
