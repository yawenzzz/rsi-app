/** Whole-share taker cost estimates from retained CLOB depth and explicit V2 fees. */

import type { Book, FeeParameters } from '../data/market.ts'
import type { QuoteBreakdown } from '../trading/types.ts'

/** Modeled debit for a fully fillable whole-share purchase. */
export interface PaperQuote {
  quantity: number
  costMicros: number
  averageCostMicros: number
}

/**
 * Walk ask depth and charge V2 platform fees plus the configured execution allowance.
 * @param book - Validated asks in ascending order.
 * @param fees - Explicit same-condition V2 fee parameters; builder fees are unsupported.
 * @param quantity - Whole shares, respecting the book's minimum order size.
 * @param slippageBps - Additional cost allowance in basis points.
 * @returns the complete quote, or null when depth, price or fee metadata cannot support it.
 */
export function quotePurchase(book: Book, fees: FeeParameters, quantity: number, slippageBps: number): PaperQuote | null {
  const quote = quotePurchaseBreakdown(book, fees, quantity, slippageBps)
  return quote === null ? null : {
    quantity, costMicros: quote.totalCostMicros, averageCostMicros: Math.ceil(quote.totalCostMicros / quantity),
  }
}

/**
 * Attribute an executable quote to book depth, platform fees and slippage.
 * @param book - Validated asks in ascending order.
 * @param fees - Same-condition fee parameters; legacy and builder fees are unsupported.
 * @param quantity - Whole shares respecting minimum order size.
 * @param slippageBps - Additional cost allowance in basis points.
 * @returns rounded components summing to the total, or null when the purchase cannot fill.
 */
export function quotePurchaseBreakdown(book: Book, fees: FeeParameters, quantity: number, slippageBps: number): QuoteBreakdown | null {
  if (fees.conditionId !== book.conditionId || fees.makerBaseFeeBps !== 0 || fees.takerBaseFeeBps !== 0) return null
  if (!Number.isSafeInteger(quantity) || quantity < Math.ceil(book.minOrderSize)) return null
  let remaining = quantity
  let cost = 0
  let bookCost = 0
  for (const level of book.asks) {
    const shares = Math.min(remaining, level.size)
    bookCost += shares * level.price
    cost += shares * (level.price + fees.rate * (level.price * (1 - level.price)) ** fees.exponent)
    remaining -= shares
    if (remaining === 0) break
  }
  if (remaining !== 0) return null
  const costMicros = Math.ceil(cost * (1 + slippageBps / 10_000) * 1_000_000)
  if (!Number.isSafeInteger(costMicros) || costMicros <= 0) return null
  const bookCostMicros = Math.ceil(bookCost * 1_000_000)
  const beforeSlippage = Math.ceil(cost * 1_000_000)
  return { quantity, bookCostMicros, feeMicros: beforeSlippage - bookCostMicros,
    slippageMicros: costMicros - beforeSlippage, totalCostMicros: costMicros }
}
