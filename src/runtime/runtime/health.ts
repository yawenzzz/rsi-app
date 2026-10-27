/** Retained provider observations distinguish successful reads from workflow completion. */
import { z } from 'zod'
import type { MarketDataClient } from '../data/market.ts'

const timestamp = z.number().int().nonnegative()

/** Persisted provider result with separate successful and failed observation times. */
export const healthReceiptSchema = z.strictObject({
  observedAt: timestamp, state: z.enum(['healthy', 'degraded']),
  lastSuccessAt: timestamp.nullable(), lastErrorAt: timestamp.nullable(), error: z.string().max(512).nullable(),
}).refine(value => value.state === 'healthy'
  ? value.lastSuccessAt !== null && value.error === null : value.lastErrorAt !== null && value.error !== null,
'Provider outcomes require their corresponding observation time and diagnostic')

/** Last measured outcome of one provider; absent evidence stays null. */
export type HealthReceipt = z.infer<typeof healthReceiptSchema>

/** Older runtime records start without invented provider measurements. */
export const healthStateSchema = z.strictObject({
  gamma: healthReceiptSchema.nullable(), clob: healthReceiptSchema.nullable(), model: healthReceiptSchema.nullable(),
}).default({ gamma: null, clob: null, model: null })

/** Source-specific observations retained by the runtime state owner. */
export type HealthState = z.infer<typeof healthStateSchema>

/**
 * Retain successful and failed provider times independently.
 * @param previous - Prior evidence, if any.
 * @param at - Local completion time.
 * @param error - Actual failure diagnostic, or null for success.
 * @returns the new observed outcome; diagnostics are bounded in the persistent record.
 */
export function observeHealth(previous: HealthReceipt | null, at: number, error: string | null): HealthReceipt {
  return { observedAt: at, state: error === null ? 'healthy' : 'degraded',
    lastSuccessAt: error === null ? at : previous?.lastSuccessAt ?? null,
    lastErrorAt: error === null ? previous?.lastErrorAt ?? null : at, error: error === null ? null : error.slice(0, 512) }
}

/** The collection and execution phases use only these public-data operations. */
export type ObservedMarketData = Pick<MarketDataClient, 'discover' | 'book' | 'feeParameters' | 'resolution'>

/**
 * Observe one tick's API operations, preserving any provider failure until that tick ends.
 * @param source - Real parser and HTTP adapter.
 * @param previous - Prior provider evidence.
 * @param maxAgeMs - The runtime's accepted quote age.
 * @param now - Local observation clock.
 * @returns wrapped reads and partial provider updates; caller cancellation does not blame the provider.
 */
export function observeMarketData(
  source: ObservedMarketData, previous: HealthState, maxAgeMs: number, now: () => number,
): { data: ObservedMarketData; updates: Partial<Pick<HealthState, 'gamma' | 'clob'>> } {
  const updates: Partial<Pick<HealthState, 'gamma' | 'clob'>> = {}
  const record = (provider: 'gamma' | 'clob', error: string | null) => {
    const before = updates[provider] ?? previous[provider]
    const next = observeHealth(before, now(), error)
    if (updates[provider]?.state === 'degraded' && error === null) {
      next.state = 'degraded'
      next.error = updates[provider].error
    }
    updates[provider] = next
  }
  const read = async <T>(provider: 'gamma' | 'clob', signal: AbortSignal, operation: () => Promise<T>, diagnostic: (value: T) => string | null) => {
    try {
      const value = await operation()
      if (!signal.aborted) record(provider, diagnostic(value))
      return value
    } catch (error) {
      if (!signal.aborted) record(provider, error instanceof Error ? error.message : String(error))
      throw error
    }
  }
  const data: ObservedMarketData = {
    discover: signal => read('gamma', signal, () => source.discover(signal), () => null),
    book: (token, signal) => read('clob', signal, () => source.book(token, signal), value =>
      value.timestamp > now() || now() - value.timestamp > maxAgeMs ? 'CLOB returned stale or future-dated book data' : null),
    feeParameters: (condition, signal) => read('clob', signal, () => source.feeParameters(condition, signal), () => null),
    resolution: (condition, signal) => read('gamma', signal, () => source.resolution(condition, signal), () => null),
  }
  return { data, updates }
}
