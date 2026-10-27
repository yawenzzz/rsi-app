/** Whole-share sizing and admission checks over one account and observation snapshot. */
import type { Candidate, Forecast } from '../strategy/experiment-types.ts'
import type { LedgerState } from '../execution/ledger-types.ts'
import type { Observation } from '../runtime-state.ts'
import { quotePurchase, quotePurchaseBreakdown } from '../execution/quotes.ts'
import type { QuoteBreakdown, SizingView } from './types.ts'

/**
 * Compare the conservative probability with the full rounded per-share cost.
 * @param forecast - Recorded probability and uncertainty.
 * @param quote - Complete executable quote, or unavailable depth.
 * @returns net probability advantage, or null when no complete quote exists.
 */
export function conservativeEdge(forecast: Pick<Forecast, 'probability' | 'uncertainty'>, quote: QuoteBreakdown | null): number | null {
  return quote === null ? null
    : Math.max(0, forecast.probability - forecast.uncertainty) - Math.ceil(quote.totalCostMicros / quote.quantity) / 1_000_000
}

/**
 * Calculate the same proposed purchase for execution and opportunity previews.
 * @param candidate - Immutable strategy policy.
 * @param forecast - Prospective probability and uncertainty.
 * @param observation - Current market, depth and explicit fees.
 * @param account - Committed account state used for the proposal.
 * @param eligible - Whether prospective evaluation permits execution.
 * @param fresh - Whether all evidence and the forecast remain current.
 * @returns the proposed cost and checks; execution requires every check to pass and rechecks the ledger atomically.
 */
export function sizePurchase(
  candidate: Pick<Candidate, 'minEdge' | 'kellyFraction'>, forecast: Pick<Forecast, 'probability' | 'uncertainty'>,
  observation: Observation, account: LedgerState, eligible: boolean, fresh: boolean,
): SizingView {
  const probability = Math.max(0, forecast.probability - forecast.uncertainty)
  const minimum = quotePurchase(observation.book, observation.fees, Math.ceil(observation.book.minOrderSize), observation.slippageBps)
  const price = minimum === null ? 1 : minimum.averageCostMicros / 1_000_000
  const rawKellyFraction = price >= 1 ? 0 : Math.max(0, (probability - price) / (1 - price))
  const fractionalKelly = rawKellyFraction * candidate.kellyFraction
  const eventCost = account.positions.filter(position => position.eventId === observation.market.eventId)
    .reduce((sum, position) => sum + position.costMicros, 0)
  const budgetMicros = Math.max(0, Math.min(Math.floor(account.equityMicros * fractionalKelly), account.cashMicros,
    account.config.perEventLimitMicros - eventCost,
    account.config.totalExposureLimitMicros - account.committedCostMicros,
    account.config.maxDrawdownMicros - account.drawdownMicros - account.committedCostMicros))
  const quantity = minimum === null ? 0 : Math.floor(budgetMicros / minimum.averageCostMicros)
  const quote = quotePurchaseBreakdown(observation.book, observation.fees, quantity, observation.slippageBps)
  const cost = quote?.totalCostMicros ?? 0
  const edge = conservativeEdge(forecast, quote)
  return {
    rawKellyFraction, fractionalKelly, budgetMicros, quantity, quote,
    checks: [
      { code: 'eligible', passed: eligible, value: null, limit: null },
      { code: 'fresh', passed: fresh, value: null, limit: null },
      { code: 'depth', passed: quote !== null, value: null, limit: null },
      { code: 'edge', passed: edge !== null && edge >= candidate.minEdge, value: edge, limit: candidate.minEdge },
      { code: 'budget', passed: quote !== null && cost <= budgetMicros, value: quote?.totalCostMicros ?? null, limit: budgetMicros },
      { code: 'cash', passed: cost <= account.cashMicros, value: cost, limit: account.cashMicros },
      { code: 'event', passed: eventCost + cost <= account.config.perEventLimitMicros,
        value: eventCost + cost, limit: account.config.perEventLimitMicros },
      { code: 'exposure', passed: account.committedCostMicros + cost <= account.config.totalExposureLimitMicros,
        value: account.committedCostMicros + cost, limit: account.config.totalExposureLimitMicros },
      { code: 'drawdown', passed: account.peakEquityMicros - account.cashMicros + cost <= account.config.maxDrawdownMicros,
        value: account.peakEquityMicros - account.cashMicros + cost, limit: account.config.maxDrawdownMicros },
    ],
  }
}
