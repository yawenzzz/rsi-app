/** Durable observations, background-run receipts and outstanding resource requests. */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { bookSchema, feeParametersSchema, marketSchema } from './data/market.ts'
import type { Book, FeeParameters, Market } from './data/market.ts'
import { quotePurchase } from './execution/quotes.ts'
import { healthStateSchema } from './runtime/health.ts'

const timestamp = z.number().int().nonnegative()

const observationFieldsSchema = z.strictObject({
  market: marketSchema,
  book: bookSchema,
  fees: feeParametersSchema,
  quantity: z.number().int().positive(),
  slippageBps: z.number().int().min(0).max(10_000),
  costMicros: z.number().int().positive(),
  averageCostMicros: z.number().int().positive(),
  baselineProbability: z.number().min(0).max(1),
})

/** The exact data snapshot and reproducible quoted cost used for a forecast or fill. */
export const observationSchema = observationFieldsSchema.extend({
  id: z.string().regex(/^[a-f0-9]{64}$/),
}).superRefine((observation, ctx) => {
  const { id, ...fields } = observation
  if (id !== observationHash(fields)) ctx.addIssue({ code: 'custom', message: 'Observation content hash mismatch' })
  try {
    requireSameMarket(fields.market, fields.book, fields.fees)
  } catch {
    // Only the local ownership assertion can throw in this try.
    ctx.addIssue({ code: 'custom', message: 'Observation market, token, and fee ownership differ' })
  }
  const quote = quotePurchase(fields.book, fields.fees, fields.quantity, fields.slippageBps)
  if (quote === null || quote.costMicros !== fields.costMicros || quote.averageCostMicros !== fields.averageCostMicros) {
    ctx.addIssue({ code: 'custom', message: 'Observation cost differs from its depth, fees, and slippage' })
  }
  const bid = fields.book.bids[0]?.price
  const ask = fields.book.asks[0]?.price
  if (bid === undefined || ask === undefined || (bid + ask) / 2 !== fields.baselineProbability) {
    ctx.addIssue({ code: 'custom', message: 'Observation baseline differs from its best bid and ask' })
  }
})

/** Immutable source data and the executable cost captured from it. */
export type Observation = z.infer<typeof observationSchema>

/**
 * Build reproducible forecast or execution evidence from actual runtime data.
 * @param market - Discovery metadata owning the token and condition.
 * @param book - Actual retained executable depth.
 * @param fees - Explicit fee curve for the same condition.
 * @param quantity - Requested whole shares.
 * @param slippageBps - Configured execution cost allowance retained in the evidence.
 * @returns hashed evidence, or null when complete depth and a midpoint are unavailable.
 */
export function createObservation(
  market: Market, book: Book, fees: FeeParameters, quantity: number, slippageBps: number,
): Observation | null {
  requireSameMarket(market, book, fees)
  const quote = quotePurchase(book, fees, quantity, slippageBps)
  const bid = book.bids[0]?.price
  const ask = book.asks[0]?.price
  if (quote === null || bid === undefined || ask === undefined) return null
  const fields = observationFieldsSchema.parse({ market, book, fees, ...quote, slippageBps, baselineProbability: (bid + ask) / 2 })
  return { id: observationHash(fields), ...fields }
}

function observationHash(fields: z.infer<typeof observationFieldsSchema>): string {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex')
}

function requireSameMarket(market: Market, book: Book, fees: FeeParameters): void {
  if (market.conditionId !== book.conditionId || market.conditionId !== fees.conditionId
    || !market.tokens.some(token => token.id === book.tokenId)) {
    throw new Error('Observation market, token, and fee ownership differ')
  }
}

/** Admission receipts survive restart; interrupted work still consumes its run allowance. */
const researchRunSchema = z.strictObject({
  id: z.string().min(1),
  day: z.string(),
  startedAt: timestamp,
  finishedAt: timestamp.nullable(),
  state: z.enum(['running', 'completed', 'failed', 'interrupted']),
  sessionId: z.string().nullable(),
  error: z.string().nullable(),
})

/** Research-run receipt consumed by the autonomous session driver. */
export type ResearchRun = z.infer<typeof researchRunSchema>

/** Deployment status and requests; financial authority belongs to the paper ledger. */
export const runtimeStateSchema = z.strictObject({
  objective: z.string().min(1),
  directiveRevision: z.number().int().nonnegative().default(0),
  researchPaused: z.boolean().default(false),
  nextTickAt: timestamp,
  lastTickAt: timestamp.nullable(),
  lastTickError: z.string().nullable(),
  health: healthStateSchema,
  researchRuns: z.array(researchRunSchema),
  resourceRequests: z.array(z.strictObject({
    id: z.string(), kind: z.string().min(1), reason: z.string().min(1),
    estimatedMonthlyCost: z.number().nonnegative(), requestedAt: timestamp,
  })),
})

/** Persistent control diagnostics and resource-request history. */
export type RuntimeState = z.infer<typeof runtimeStateSchema>

/** Runtime observations are retained separately from the atomically updated paper account. */
export const runtimeDomain = defineDomain({
  name: 'rsi_runtime', version: 1,
  tables: {
    state: domainTable<'state', RuntimeState>(runtimeStateSchema),
    observations: domainTable<string, Observation>(observationSchema),
  },
})
