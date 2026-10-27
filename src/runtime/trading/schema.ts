/** Durable validation of original purchase mathematics and its recorded checks. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ResearchObservationId } from '../strategy/experiment-schema.ts'
import type { DecisionCheck, QuoteBreakdown, SizingView, TradeAssessment } from './types.ts'
import { conservativeEdge } from './sizing.ts'

const money = z.number().int().nonnegative()
const probability = z.number().min(0).max(1)
const purchaseChecks = ['eligible', 'fresh', 'depth', 'edge', 'budget', 'cash', 'event', 'exposure', 'drawdown']

/** Recorded result of one named criterion; missing evidence remains null. */
export const decisionCheckSchema: z.ZodType<DecisionCheck> = z.strictObject({
  code: z.enum(['eligible', 'fresh', 'depth', 'budget', 'edge', 'cash', 'event', 'exposure', 'drawdown',
    'samples', 'brier', 'confidence', 'account-drawdown', 'independence']),
  passed: z.boolean().nullable(), value: z.number().nullable(), limit: z.number().nullable(),
})

/** Exact integer cost attribution; components must sum to the debit. */
export const quoteBreakdownSchema: z.ZodType<QuoteBreakdown> = z.strictObject({
  quantity: money.positive(), bookCostMicros: money, feeMicros: money, slippageMicros: money, totalCostMicros: money.positive(),
}).refine(quote => quote.bookCostMicros + quote.feeMicros + quote.slippageMicros === quote.totalCostMicros,
  'Quote components differ from the total cost')

/** Complete sizing evidence from one calculation, including rejected proposals. */
export const sizingViewSchema: z.ZodType<SizingView> = z.strictObject({
  rawKellyFraction: probability, fractionalKelly: probability, budgetMicros: money, quantity: money,
  quote: quoteBreakdownSchema.nullable(), checks: z.array(decisionCheckSchema).length(purchaseChecks.length),
}).refine(value => new Set(value.checks.map(check => check.code)).size === purchaseChecks.length
  && value.checks.every(check => purchaseChecks.includes(check.code)), 'Purchase checks must be complete and unique')
  .refine(value => value.quote === null || value.quote.quantity === value.quantity, 'Quote quantity differs from sizing')

/** Prediction and capital facts frozen at assessment time, independent of later account changes. */
export const tradeAssessmentSchema: z.ZodType<TradeAssessment> = z.strictObject({
  algorithm: z.literal('fractional-kelly-v1'), at: money, accountSequence: money, equityMicros: money,
  forecastObservationId: z.string().min(1).transform(brandString<ResearchObservationId>), forecastReceivedAt: money,
  forecastRevision: money.optional(),
  probability, uncertainty: probability, minEdge: probability, kellyFraction: probability.positive(), sizing: sizingViewSchema,
}).refine(value => value.forecastReceivedAt <= value.at, 'Forecast must precede its assessment')
  .refine(value => value.sizing.fractionalKelly === value.sizing.rawKellyFraction * value.kellyFraction
    && value.sizing.budgetMicros <= Math.floor(value.equityMicros * value.sizing.fractionalKelly),
  'Assessment differs from its fractional Kelly allocation')
  .refine((value) => {
    const check = value.sizing.checks.find(item => item.code === 'edge')
    const edge = conservativeEdge(value, value.sizing.quote)
    return check?.value === edge && check.limit === value.minEdge && check.passed === (edge !== null && edge >= value.minEdge)
  }, 'Assessment edge differs from its recorded probability and price')
