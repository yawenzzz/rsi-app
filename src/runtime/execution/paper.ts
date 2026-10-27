/** Refreshed paper execution with stable purchase identities and atomic financial receipts. */
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Config } from '../config.ts'
import type { Market } from '../data/market.ts'
import type { DecisionJournal } from '../decision/journal.ts'
import type { DecisionId } from '../queries/types.ts'
import { createObservation } from '../runtime-state.ts'
import type { Observation } from '../runtime-state.ts'
import type { ObservedMarketData } from '../runtime/health.ts'
import type { Candidate, Forecast, PrimaryForecast } from '../strategy/experiment-types.ts'
import { forecastRevision } from '../strategy/forecasts.ts'
import { sizePurchase } from '../trading/sizing.ts'
import type { TradeAssessment } from '../trading/types.ts'
import type { PaperLedger } from './ledger.ts'
import type { EvidenceRef, StrategyVersion, TradeIntentId } from './ledger-types.ts'

/** Eligible, unresolved research selected by Strategy for one candidate and event. */
export interface PaperAttempt {
  candidate: Candidate
  forecast: Forecast
  /** First admitted forecast keeps the purchase identity stable across prediction updates. */
  primaryForecast: PrimaryForecast
  market: Market
}

/** Account and data facilities owned by the runtime; paper execution opens no separate storage. */
export interface PaperExecutionOptions {
  config: Pick<Config, 'maxObservationAgeMs' | 'maxForecastAgeMs' | 'paperExecutionDelayMs' | 'paperSlippageBps'>
  ledger: PaperLedger
  journal: DecisionJournal
  data: Pick<ObservedMarketData, 'book' | 'feeParameters'>
  /**
   * Read evidence retained before Strategy admitted the forecast.
   * @param id - Forecast observation identity.
   * @returns the immutable source observation.
   */
  observation(id: string): Observation
  /**
   * Save executable evidence before any debit; reject when retention is unavailable.
   * @param observation - Refreshed depth, fees, and complete share cost.
   * @returns after evidence is durable.
   */
  retainObservation(observation: Observation): Promise<void>
  /**
   * Check whether Strategy still selects this exact prediction.
   * @param forecast - Prediction used by the pending attempt.
   * @returns false after replacement or settlement.
   */
  isCurrent(forecast: Forecast): boolean
  /** Reject after cancellation or writer-lease loss. */
  assertOpen(): void
}

/**
 * Execute eligible paper forecasts with fresh prices and independent ledger risk checks.
 * @param options - Explicit timing policy and runtime-owned facilities.
 * @param attempts - Current Strategy decisions with their immutable first-forecast anchors.
 * @param signal - Cancellation for delayed execution and public-data requests.
 * @returns after retained rejections and admitted financial receipts are durable.
 */
export async function executePaperForecasts(
  options: PaperExecutionOptions, attempts: readonly PaperAttempt[], signal: AbortSignal,
): Promise<void> {
  const { config, ledger, journal, data } = options
  if (ledger.view().status !== 'running') return
  for (const { candidate, forecast, primaryForecast, market } of attempts) {
    signal.throwIfAborted()
    if (!options.isCurrent(forecast)) continue
    const original = options.observation(forecast.observation.observationId)
    if (market.eventId !== original.market.eventId || market.conditionId !== original.market.conditionId) {
      throw new Error('Current market ownership differs from the forecast evidence')
    }
    const identity = JSON.stringify([primaryForecast.candidateId, primaryForecast.observation.observationId])
    const id = brandString<TradeIntentId>(createHash('sha256').update(identity).digest('hex'))
    if (ledger.view().trades.some(trade => trade.intent.id === id)) continue
    if (forecast.receivedAt > Date.now() || Date.now() - forecast.receivedAt >= config.maxForecastAgeMs) continue
    const wait = Math.max(0, forecast.receivedAt + config.paperExecutionDelayMs - Date.now())
    if (wait > 0) await delay(wait, undefined, { signal })
    const book = await data.book(original.book.tokenId, signal)
    const fees = await data.feeParameters(original.market.conditionId, signal)
    if (!options.isCurrent(forecast)) continue
    const current = { ...original, market, book, fees }
    const now = Date.now()
    const timestamps = [market.observedAt, book.timestamp, book.observedAt, fees.observedAt]
    if (timestamps.some(at => at > now || now - at > config.maxObservationAgeMs)) {
      throw new Error('Observation is stale or dated in the future')
    }
    if (Date.parse(market.endDate) <= now || !market.acceptingOrders || market.closed) {
      throw new Error('Market is not open for prospective trading')
    }
    const validUntil = Math.min(forecast.receivedAt + config.maxForecastAgeMs,
      ...timestamps.map(at => at + config.maxObservationAgeMs), Date.parse(market.endDate),
      forecast.observation.eventEndsAt, primaryForecast.observation.eventEndsAt)
    if (now >= validUntil) continue
    const account = ledger.view()
    const sizing = sizePurchase(candidate, forecast, current, account, true, true)
    const assessment: TradeAssessment = {
      algorithm: 'fractional-kelly-v1', at: now, accountSequence: account.sequence, equityMicros: account.equityMicros,
      forecastObservationId: forecast.observation.observationId, forecastReceivedAt: forecast.receivedAt,
      forecastRevision: forecastRevision(forecast),
      probability: forecast.probability, uncertainty: forecast.uncertainty,
      minEdge: candidate.minEdge, kellyFraction: candidate.kellyFraction, sizing,
    }
    if (sizing.quote === null || sizing.checks.some(check => check.passed !== true)) {
      const fingerprint = createHash('sha256').update(JSON.stringify([
        id, forecast.observation.observationId, forecast.receivedAt, forecastRevision(forecast), account.sequence, book.hash, sizing,
      ])).digest('hex')
      await journal.append({
        decision: { at: assessment.at, kind: 'trade', outcome: 'rejected', summary: 'trade.rejected',
          question: market.question, amountMicros: sizing.quote?.totalCostMicros ?? null,
          observationId: null, candidateId: candidate.id, sessionId: null },
        assessment, checks: sizing.checks, pricing: sizing.quote, explanation: '',
        references: [{ kind: 'intent', value: id }, { kind: 'forecastObservation', value: forecast.observation.observationId },
          { kind: 'bookHash', value: book.hash }, { kind: 'bookObservedAt', value: String(book.observedAt) }],
      }, brandString<DecisionId>(`journal:rejection:${fingerprint}`))
      continue
    }
    const { quantity, quote } = sizing
    options.assertOpen()
    const execution = createObservation(market, book, fees, quantity, config.paperSlippageBps)
    if (execution === null) continue
    await options.retainObservation(execution)
    if (!options.isCurrent(forecast)) continue
    await ledger.execute({
      id, controlRevision: account.controlRevision,
      strategyVersion: brandString<StrategyVersion>(forecast.candidateId), evidenceRef: brandString<EvidenceRef>(execution.id),
      marketId: original.market.id, conditionId: original.market.conditionId, eventId: original.market.eventId,
      tokenId: book.tokenId, quantity, costMicros: quote.totalCostMicros, observedAt: book.observedAt,
      validUntil, assessment,
    }, () => {
      signal.throwIfAborted()
      if (!options.isCurrent(forecast)) throw new Error('Forecast was replaced before paper execution')
    })
  }
}
