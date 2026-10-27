/** Provider observations retain failures independently of unrelated reads or cancellation. */
import { describe, expect, it, vi } from 'vitest'
import { healthReceiptSchema, healthStateSchema, observeHealth, observeMarketData } from '../../src/runtime/runtime/health.ts'
import { observation } from './fixtures/observations.ts'
import type { ObservedMarketData } from '../../src/runtime/runtime/health.ts'

function fixture() {
  const sample = observation()
  return { sample, data: {
    discover: vi.fn<ObservedMarketData['discover']>().mockResolvedValue([sample.market]),
    book: vi.fn<ObservedMarketData['book']>().mockResolvedValue(sample.book),
    feeParameters: vi.fn<ObservedMarketData['feeParameters']>().mockResolvedValue(sample.fees),
    resolution: vi.fn<ObservedMarketData['resolution']>().mockResolvedValue({ conditionId: sample.market.conditionId,
      observedAt: sample.market.observedAt, sourceStatus: 'proposed', status: 'unresolved', payouts: [] }),
  } }
}

describe('measured provider health', () => {
  it('keeps providers without reads unknown and records Gamma failure independently', async () => {
    const { data } = fixture()
    data.discover.mockRejectedValue('Gamma unavailable')
    const batch = observeMarketData(data, healthStateSchema.parse(undefined), 5000, () => 10_000)
    await expect(batch.data.discover(new AbortController().signal)).rejects.toBe('Gamma unavailable')
    expect(batch.updates).toEqual({ gamma: { observedAt: 10_000, state: 'degraded', lastSuccessAt: null,
      lastErrorAt: 10_000, error: 'Gamma unavailable' } })
  })

  it('retains a failed book read when fees subsequently succeed, and recovers on a new clean batch', async () => {
    const { data, sample } = fixture()
    let now = 10_000
    const state = healthStateSchema.parse(undefined)
    const batch = observeMarketData(data, state, 5000, () => now)
    const signal = new AbortController().signal
    await batch.data.discover(signal)
    data.book.mockRejectedValueOnce(new Error('Book unavailable'))
    now = 11_000
    await expect(batch.data.book(sample.book.tokenId, signal)).rejects.toThrow('Book unavailable')
    now = 12_000
    await batch.data.feeParameters(sample.market.conditionId, signal)
    await batch.data.resolution(sample.market.conditionId, signal)
    expect(batch.updates.clob).toEqual({ observedAt: 12_000, state: 'degraded', lastSuccessAt: 12_000,
      lastErrorAt: 11_000, error: 'Book unavailable' })
    expect(batch.updates.gamma?.state).toBe('healthy')
    const next = observeMarketData(data, { ...state, ...batch.updates }, 5000, () => now)
    await next.data.book(sample.book.tokenId, signal)
    expect(next.updates.clob).toEqual({ observedAt: 12_000, state: 'healthy', lastSuccessAt: 12_000,
      lastErrorAt: 11_000, error: null })
  })

  it.each([4000, 11_000])('reports an out-of-window exchange timestamp without changing the returned book (%s)', async (timestamp) => {
    const { data, sample } = fixture()
    sample.book.timestamp = timestamp
    const batch = observeMarketData(data, healthStateSchema.parse(undefined), 5000, () => 10_000)
    expect(await batch.data.book(sample.book.tokenId, new AbortController().signal)).toBe(sample.book)
    expect(batch.updates.clob?.state).toBe('degraded')
    expect(batch.updates.clob?.error).toContain('stale or future-dated')
  })

  it.each([false, true])('does not attribute caller cancellation to provider availability (reject=%s)', async (reject) => {
    const { data } = fixture()
    const abort = new AbortController()
    data.discover.mockImplementation(async () => {
      abort.abort(new Error('Operator stop'))
      if (reject) throw abort.signal.reason
      return []
    })
    const batch = observeMarketData(data, healthStateSchema.parse(undefined), 5000, () => 10_000)
    const result = batch.data.discover(abort.signal)
    if (reject) await expect(result).rejects.toThrow('Operator stop')
    else expect(await result).toEqual([])
    expect(batch.updates).toEqual({})
  })

  it('bounds retained errors and carries the last successful observation across failures', () => {
    const success = observeHealth(null, 100, null)
    const failure = observeHealth(success, 200, 'x'.repeat(600))
    expect(failure).toEqual({ observedAt: 200, state: 'degraded',
      lastSuccessAt: 100, lastErrorAt: 200, error: 'x'.repeat(512) })
    expect(healthReceiptSchema.parse(success)).toEqual(success)
    expect(healthReceiptSchema.parse(failure)).toEqual(failure)
    for (const value of [{ ...success, lastSuccessAt: null }, { ...success, error: 'Conflicting state' },
      { ...failure, lastErrorAt: null }, { ...failure, error: null }]) {
      expect(healthReceiptSchema.safeParse(value).success).toBe(false)
    }
  })
})
