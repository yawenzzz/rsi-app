/** Executable costs and all-share budgets shared with the opportunity preview. */
import { describe, expect, it } from 'vitest'
import { sizePurchase } from '../../src/runtime/trading/sizing.ts'
import { quotePurchase, quotePurchaseBreakdown } from '../../src/runtime/execution/quotes.ts'
import type { LedgerState } from '../../src/runtime/execution/ledger-types.ts'
import { holding, observation } from './fixtures/observations.ts'

function account(): LedgerState {
  return {
    mode: 'paper', config: { initialCapitalMicros: 100_000_000, perEventLimitMicros: 10_000_000,
      totalExposureLimitMicros: 20_000_000, maxDrawdownMicros: 30_000_000, maxAuditEntries: 100 },
    createdAt: 0, sequence: 0, controlRevision: 1, status: 'running', controlReason: 'Synthetic test',
    cashMicros: 100_000_000, committedCostMicros: 0, realizedProfitMicros: 0, equityMicros: 100_000_000,
    peakEquityMicros: 100_000_000, drawdownMicros: 0, positions: [], trades: [], settlements: [], audit: [],
  }
}

const policy = { minEdge: 0.05, kellyFraction: 0.1 }
const forecast = { probability: 0.75, uncertainty: 0.05 }

describe('shared purchase calculations', () => {
  it('attributes rounded fees and slippage to the same total the executor debits', () => {
    const source = observation()
    const fees = { ...source.fees, rate: 0.0625 }
    expect(quotePurchaseBreakdown(source.book, fees, 3, 100)).toEqual({
      quantity: 3, bookCostMicros: 750_000, feeMicros: 35_157, slippageMicros: 7_851, totalCostMicros: 793_008,
    })
    expect(quotePurchase(source.book, fees, 3, 100)).toEqual({ quantity: 3, costMicros: 793_008, averageCostMicros: 264_336 })
    expect(quotePurchase(source.book, fees, 1001, 100)).toBeNull()
  })

  it('sizes the conservative probability within the fractional Kelly allocation', () => {
    const result = sizePurchase(policy, forecast, observation(), account(), true, true)
    expect(result.rawKellyFraction).toBeCloseTo(0.6)
    expect(result.fractionalKelly).toBeCloseTo(0.06)
    expect(result.quantity).toBe(24)
    expect(result.quote?.totalCostMicros).toBe(6_000_000)
    expect(result.checks.every(check => check.passed)).toBe(true)
  })

  it('rejects full-depth costs above the allocated budget even when cash and risk limits allow them', () => {
    const source = observation()
    source.book.asks = [{ price: 0.25, size: 1 }, { price: 0.26, size: 100 }]
    const result = sizePurchase(policy, forecast, source, account(), true, true)
    expect(result.quote?.totalCostMicros).toBe(6_230_000)
    expect(result.checks.find(check => check.code === 'budget')).toMatchObject({ passed: false, limit: 6_000_000, value: 6_230_000 })
    expect(result.checks.filter(check => check.code !== 'budget').every(check => check.passed)).toBe(true)
  })

  it('reserves existing event costs and drawdown before admitting another purchase', () => {
    const state = account()
    const source = observation()
    state.cashMicros = 80_000_000
    state.committedCostMicros = 9_000_000
    state.realizedProfitMicros = -11_000_000
    state.equityMicros = 89_000_000
    state.drawdownMicros = 11_000_000
    state.positions = [holding(source, 9_000_000)]
    const result = sizePurchase(policy, forecast, source, state, true, true)
    expect(result.budgetMicros).toBe(1_000_000)
    expect(result.quote?.quantity).toBe(4)
    expect(result.checks.find(check => check.code === 'event')).toMatchObject({ passed: true, value: 10_000_000 })
    state.config.maxDrawdownMicros = 20_000_000
    const exhausted = sizePurchase(policy, forecast, source, state, true, true)
    expect(exhausted.budgetMicros).toBe(0)
    expect(exhausted.quote).toBeNull()
  })

  it('preserves distinct reasons for missing depth, stale evidence and ineligible strategies', () => {
    const source = observation()
    source.book.asks = []
    const result = sizePurchase(policy, forecast, source, account(), false, false)
    expect(result.quantity).toBe(0)
    expect(result.rawKellyFraction).toBe(0)
    expect(result.quote).toBeNull()
    expect(result.checks.filter(check => check.passed === false).map(check => check.code))
      .toEqual(['eligible', 'fresh', 'depth', 'edge', 'budget'])
    const atPar = observation('par', 10_000, 1)
    expect(sizePurchase(policy, forecast, atPar, account(), true, true).rawKellyFraction).toBe(0)
  })
})
