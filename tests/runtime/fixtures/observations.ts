/** Deterministic, internally consistent observations for calculation tests. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ConditionId, EventId, MarketId, TokenId } from '../../../src/runtime/data/market.ts'
import type { PaperPosition } from '../../../src/runtime/execution/ledger-types.ts'
import { createObservation, type Observation } from '../../../src/runtime/runtime-state.ts'

/**
 * Build a synthetic, executable observation with equal bid and ask prices.
 * @param id - Token and market fixture identity.
 * @param at - Explicit observation clock.
 * @param price - Probability and executable price.
 * @param category - Optional recorded market category.
 * @returns a content-hashed observation.
 */
export function observation(id = 'token', at = 10_000, price = 0.25, category?: string): Observation {
  const tokenId = brandString<TokenId>(id)
  const conditionId = brandString<ConditionId>(`condition-${id}`)
  const value = createObservation({
    id: brandString<MarketId>(`market-${id}`), eventId: brandString<EventId>(`event-${id}`), conditionId,
    question: `Synthetic ${id}?`, description: 'Synthetic calculation fixture.', resolutionSource: 'https://fixture.test/result',
    endDate: '2100-01-01T00:00:00Z', observedAt: at, active: true, closed: false, acceptingOrders: true, feesEnabled: false,
    tokens: [{ id: tokenId, outcome: 'Yes' }, { id: brandString<TokenId>(`${id}-other`), outcome: 'No' }],
    ...(category === undefined ? {} : { category }),
  }, {
    tokenId, conditionId, observedAt: at, timestamp: at, hash: `book-${id}-${at}`, minOrderSize: 1, tickSize: 0.001, negRisk: false,
    bids: [{ price, size: 1000 }], asks: [{ price, size: 1000 }],
  }, { conditionId, observedAt: at, rate: 0, exponent: 1, takerOnly: true, makerBaseFeeBps: 0, takerBaseFeeBps: 0 }, 1, 0)
  if (value === null) throw new Error('The observation fixture must support a one-share purchase')
  return value
}

/**
 * Describe a held token using its matching observation identity.
 * @param value - Source market and token.
 * @param costMicros - Explicit cost used for exposure weighting.
 * @returns one synthetic open position.
 */
export function holding(value: Observation, costMicros = 1_000_000): PaperPosition {
  return { tokenId: value.book.tokenId, eventId: value.market.eventId, marketId: value.market.id,
    conditionId: value.market.conditionId, quantity: 10, costMicros }
}
