/** Read-only presentation of the execution owner's cost and sizing calculations. */
import type { Observation } from '../runtime-state.ts'
import { quotePurchaseBreakdown } from '../execution/quotes.ts'
import type { QuoteBreakdown } from '../trading/types.ts'

export { sizePurchase as explainSizing } from '../trading/sizing.ts'

/**
 * Resolve cost components from the same quote used by execution.
 * @param observation - Complete retained executable evidence.
 * @param quantity - Requested whole shares.
 * @returns exact cost components, or null when the recorded depth cannot fill.
 */
export function explainQuote(observation: Observation, quantity: number): QuoteBreakdown | null {
  return quotePurchaseBreakdown(observation.book, observation.fees, quantity, observation.slippageBps)
}
