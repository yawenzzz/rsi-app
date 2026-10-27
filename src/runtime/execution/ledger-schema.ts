/** Strict durable paper records and accounting reconstruction. @module */

import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { tradeAssessmentSchema } from '../trading/schema.ts'
import type { ConditionId, EventId, MarketId, TokenId } from '../data/market.ts'
import type {
  EvidenceRef, LedgerConfig, LedgerState, PaperPosition, ResolutionRef, StrategyVersion,
  TradeIntentId, TradeIntent,
} from './ledger-types.ts'

const money = z.number().int().nonnegative()
const positiveMoney = money.positive()
const signedMoney = z.number().int()
const quantity = z.number().int().positive().max(Math.floor(Number.MAX_SAFE_INTEGER / 1_000_000))
const identifier = z.string().min(1)
const tokenId = identifier.transform(brandString<TokenId>)
const intentId = identifier.transform(brandString<TradeIntentId>)
const ownership = {
  marketId: identifier.transform(brandString<MarketId>),
  eventId: identifier.transform(brandString<EventId>),
  conditionId: identifier.transform(brandString<ConditionId>),
  tokenId,
}

/** Persisted fixed allocation; callers validate plugin configuration before opening. */
export const ledgerConfigSchema: z.ZodType<LedgerConfig> = z.strictObject({
  initialCapitalMicros: positiveMoney,
  perEventLimitMicros: positiveMoney,
  totalExposureLimitMicros: positiveMoney,
  maxDrawdownMicros: positiveMoney,
  maxAuditEntries: z.number().int().positive(),
}).refine(config => config.perEventLimitMicros <= config.totalExposureLimitMicros
  && config.totalExposureLimitMicros <= config.initialCapitalMicros
  && config.maxDrawdownMicros <= config.initialCapitalMicros,
{ message: 'Paper limits must fit the initial allocation and per-event limits must fit total exposure.' })

const intentSchema = z.strictObject({
  ...ownership,
  id: intentId,
  controlRevision: money,
  strategyVersion: identifier.transform(brandString<StrategyVersion>),
  evidenceRef: identifier.transform(brandString<EvidenceRef>),
  quantity,
  costMicros: positiveMoney,
  observedAt: money,
  validUntil: money,
  assessment: tradeAssessmentSchema.optional(),
}).refine(intent => intent.observedAt < intent.validUntil, { message: 'Observation must precede expiry.' })

const positionSchema = z.strictObject({ ...ownership, quantity, costMicros: positiveMoney })
const settlementSchema = z.strictObject({
  ...ownership,
  resolutionRef: identifier.transform(brandString<ResolutionRef>),
  final: z.literal(true),
  payoutPerShareMicros: money.max(1_000_000),
  resolvedAt: money,
})
const tradeSchema = z.strictObject({
  intent: intentSchema,
  sequence: money.positive(),
  executedAt: money,
  cashAfterMicros: money,
})
const settlementReceiptSchema = z.strictObject({
  settlement: settlementSchema,
  sequence: money.positive(),
  settledAt: money,
  quantity,
  costMicros: positiveMoney,
  payoutMicros: money,
  profitMicros: signedMoney,
  cashAfterMicros: money,
})
const auditFields = { sequence: money.positive(), at: money }
const auditSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...auditFields, kind: z.literal('control'), action: z.enum(['pause', 'resume']),
    reason: identifier, controlRevision: money.positive(),
  }),
  z.strictObject({ ...auditFields, kind: z.literal('trade'), intentId }),
  z.strictObject({ ...auditFields, kind: z.literal('settlement'), tokenId }),
])

/** Strict schema refusing records whose receipts disagree with balances or positions. */
export const ledgerStateSchema: z.ZodType<LedgerState> = z.strictObject({
  mode: z.literal('paper'),
  config: ledgerConfigSchema,
  createdAt: money,
  sequence: money,
  controlRevision: money,
  status: z.enum(['paused', 'running']),
  controlReason: identifier,
  cashMicros: money,
  committedCostMicros: money,
  realizedProfitMicros: signedMoney,
  equityMicros: money,
  peakEquityMicros: positiveMoney,
  drawdownMicros: money,
  positions: z.array(positionSchema),
  trades: z.array(tradeSchema),
  settlements: z.array(settlementReceiptSchema),
  audit: z.array(auditSchema),
}).refine(hasConsistentAccounting, { message: 'Paper balances, positions, or audit do not match financial receipts.' })

/** One update commits control, cash, positions, receipts, and recent activity together. */
export const paperLedgerDomain = defineDomain({
  name: 'rsi_paper',
  version: 1,
  tables: { account: domainTable<'paper', LedgerState>(ledgerStateSchema) },
})

function hasConsistentAccounting(state: LedgerState): boolean {
  const positions = new Map<TokenId, PaperPosition>()
  const ids = new Set<TradeIntentId>()
  const settled = new Set<TokenId>()
  const sequences = new Set<number>()
  let cash = state.config.initialCapitalMicros
  let committed = 0
  let profit = 0
  let peak = cash
  const operations = [
    ...state.trades.map(receipt => ({ kind: 'trade' as const, receipt, sequence: receipt.sequence })),
    ...state.settlements.map(receipt => ({ kind: 'settlement' as const, receipt, sequence: receipt.sequence })),
  ].sort((a, b) => a.sequence - b.sequence)

  for (const operation of operations) {
    if (sequences.has(operation.sequence) || operation.sequence > state.sequence) return false
    sequences.add(operation.sequence)
    if (operation.kind === 'trade') {
      const { receipt } = operation
      const intent = receipt.intent
      if (ids.has(intent.id) || settled.has(intent.tokenId) || intent.controlRevision > state.controlRevision
        || receipt.executedAt < intent.observedAt || receipt.executedAt >= intent.validUntil) return false
      if (!matchesAssessment(intent, receipt.sequence, receipt.executedAt)) return false
      ids.add(intent.id)
      const previous = positions.get(intent.tokenId)
      if (previous !== undefined && !sameOwner(previous, intent)) return false
      const position: PaperPosition = {
        marketId: intent.marketId, eventId: intent.eventId, conditionId: intent.conditionId, tokenId: intent.tokenId,
        quantity: (previous?.quantity ?? 0) + intent.quantity,
        costMicros: (previous?.costMicros ?? 0) + intent.costMicros,
      }
      if (!Number.isSafeInteger(position.quantity * 1_000_000)) return false
      positions.set(intent.tokenId, position)
      cash -= intent.costMicros
      committed += intent.costMicros
      if (receipt.cashAfterMicros !== cash || cash < 0 || committed > state.config.totalExposureLimitMicros
        || peak - cash > state.config.maxDrawdownMicros) return false
      const eventCost = [...positions.values()].filter(item => item.eventId === intent.eventId)
        .reduce((sum, item) => sum + item.costMicros, 0)
      if (eventCost > state.config.perEventLimitMicros) return false
    } else {
      const { receipt } = operation
      const settlement = receipt.settlement
      const position = positions.get(settlement.tokenId)
      if (settled.has(settlement.tokenId) || position === undefined || !sameOwner(position, settlement)
        || receipt.settledAt < settlement.resolvedAt) return false
      settled.add(settlement.tokenId)
      positions.delete(settlement.tokenId)
      const payout = position.quantity * settlement.payoutPerShareMicros
      if (receipt.quantity !== position.quantity || receipt.costMicros !== position.costMicros
        || receipt.payoutMicros !== payout || receipt.profitMicros !== payout - position.costMicros) return false
      cash += payout
      committed -= position.costMicros
      profit += receipt.profitMicros
      peak = Math.max(peak, cash + committed)
      if (receipt.cashAfterMicros !== cash) return false
    }
  }
  const expectedAuditLength = Math.min(state.sequence, state.config.maxAuditEntries)
  if (state.audit.length !== expectedAuditLength || state.sequence !== operations.length + state.controlRevision) return false
  for (const [index, entry] of state.audit.entries()) {
    if (entry.sequence !== state.sequence - expectedAuditLength + index + 1) return false
    if (entry.kind === 'trade' && !state.trades.some(receipt => receipt.sequence === entry.sequence
      && receipt.intent.id === entry.intentId && receipt.executedAt === entry.at)) return false
    if (entry.kind === 'settlement' && !state.settlements.some(receipt => receipt.sequence === entry.sequence
      && receipt.settlement.tokenId === entry.tokenId && receipt.settledAt === entry.at)) return false
    if (entry.kind === 'control' && (entry.controlRevision > state.controlRevision || sequences.has(entry.sequence))) return false
  }
  return state.cashMicros === cash && state.committedCostMicros === committed
    && state.realizedProfitMicros === profit && state.equityMicros === cash + committed
    && state.equityMicros === state.config.initialCapitalMicros + profit
    && state.peakEquityMicros === peak && state.drawdownMicros === peak - state.equityMicros
    && isDeepStrictEqual(state.positions, [...positions.values()])
}

/**
 * Compare the original sizing evidence with the purchase it accompanies.
 * @param intent - Purchase and optional recorded assessment.
 * @param sequence - Financial commit sequence, after the assessed account snapshot.
 * @param at - Financial commit time.
 * @returns whether present evidence is valid, fully admitted, and matches the actual shares and debit.
 */
export function matchesAssessment(intent: TradeIntent, sequence: number, at: number): boolean {
  const assessment = intent.assessment
  return assessment === undefined || (tradeAssessmentSchema.safeParse(assessment).success
    && assessment.at <= at && assessment.at >= intent.observedAt && assessment.accountSequence < sequence
    && assessment.sizing.quantity === intent.quantity && assessment.sizing.quote?.totalCostMicros === intent.costMicros
    && assessment.sizing.checks.every(check => check.passed === true))
}

/**
 * Check the complete token ownership used by purchases and resolution observations.
 * @param left - Stored owner of a token.
 * @param right - Proposed owner of the same token.
 * @returns whether the token belongs to exactly the same market, event, and condition.
 */
export function sameOwner(
  left: Pick<PaperPosition, 'marketId' | 'eventId' | 'conditionId' | 'tokenId'>,
  right: Pick<PaperPosition, 'marketId' | 'eventId' | 'conditionId' | 'tokenId'>,
): boolean {
  return left.tokenId === right.tokenId && left.marketId === right.marketId
    && left.eventId === right.eventId && left.conditionId === right.conditionId
}
