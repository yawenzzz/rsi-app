/** Forecast updates remain visible without rewriting qualification samples or trade attribution. */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { resolveConfig } from '../../src/runtime/config.ts'
import type { EvidenceRef, StrategyVersion, TradeIntentId } from '../../src/runtime/execution/ledger-types.ts'
import { decisionViews, queryDecision } from '../../src/runtime/queries/decisions.ts'
import { forecastDecisionId } from '../../src/runtime/queries/decision-ids.ts'
import { queryOpportunity } from '../../src/runtime/queries/opportunities.ts'
import { queryOverview } from '../../src/runtime/queries/overview.ts'
import type { ConsoleSource } from '../../src/runtime/queries/source.ts'
import { queryStrategies, queryStrategy } from '../../src/runtime/queries/strategies.ts'
import type { DecisionId } from '../../src/runtime/queries/types.ts'
import { candidateVersion } from '../../src/runtime/strategy/experiment-schema.ts'
import type { ResearchObservationId } from '../../src/runtime/strategy/experiment-schema.ts'
import type { PrimaryForecast } from '../../src/runtime/strategy/experiment-types.ts'
import { sizePurchase } from '../../src/runtime/trading/sizing.ts'
import { observation } from './fixtures/observations.ts'

function source(): ConsoleSource {
  const config = resolveConfig({ objective: 'Synthetic forecast projection',
    writerLeasePath: join(process.cwd(), 'synthetic-writer'), research: { cwd: process.cwd() },
    maxObservationAgeMs: 1000, maxForecastAgeMs: 20_000,
    ledger: { initialCapitalMicros: 100_000_000, perEventLimitMicros: 10_000_000,
      totalExposureLimitMicros: 20_000_000, maxDrawdownMicros: 30_000_000 } })
  const policy = { name: 'Prospective fixture', thesis: 'Synthetic evidence', minEdge: 0.05, kellyFraction: 0.1 }
  const candidate = { ...policy, id: candidateVersion(policy), registeredAt: 0 }
  return {
    now: 10_000, config, observations: [], journal: [], releases: null,
    operations: { stopped: false, revision: 0, reason: '', changedAt: 0 },
    state: { objective: config.objective, directiveRevision: 0, researchPaused: false, nextTickAt: 0,
      lastTickAt: null, lastTickError: null, health: { gamma: null, clob: null, model: null },
      researchRuns: [], resourceRequests: [] },
    account: { mode: 'paper', config: config.ledger, createdAt: 0, sequence: 1, controlRevision: 1,
      status: 'running', controlReason: 'Synthetic projection', cashMicros: 100_000_000,
      committedCostMicros: 0, realizedProfitMicros: 0, equityMicros: 100_000_000, peakEquityMicros: 100_000_000,
      drawdownMicros: 0, positions: [], trades: [], settlements: [], audit: [] },
    research: { config: config.experiments, candidates: [candidate], forecasts: [], forecastRevisions: [], settlements: [] },
    ranks: [{ candidateId: candidate.id, name: candidate.name, status: 'paper-eligible', forecastEvents: 1,
      resolvedEvents: 1, evaluatedEvents: 1, brierScore: 0.01, marketBrierScore: 0.5,
      meanNetAdvantage: 0.5, lowerConfidenceBound: 0.1 }],
  }
}

function forecast(input: ConsoleSource, token = 'event', probability = 0.8, at = 1000): PrimaryForecast {
  const evidence = observation(token, at, 0.25)
  input.observations.push(evidence)
  const value: PrimaryForecast = {
    candidateId: input.research.candidates[0]!.id, probability, uncertainty: 0, evidence: [], receivedAt: at,
    observation: { observationId: brandString<ResearchObservationId>(evidence.id), observedAt: at,
      eventId: evidence.market.eventId, marketId: evidence.market.id, tokenId: evidence.book.tokenId,
      eventEndsAt: Date.parse(evidence.market.endDate), costMicros: evidence.averageCostMicros,
      baselineProbability: evidence.baselineProbability },
  }
  input.research.forecasts.push(value)
  return value
}

describe('forecast projections', () => {
  it('shows the latest probability and sizes fresh quotes using the independent prediction lifetime', () => {
    const input = source()
    const primary = forecast(input)
    input.research.forecastRevisions.push({ ...primary, revision: 1, probability: 0.9, receivedAt: 2000 })
    const current = observation('event', input.now, 0.25)
    input.observations.push(current)
    const detail = queryOpportunity(input, current.id)
    expect(detail.opportunity).toMatchObject({ agentProbability: 0.9, conservativeProbability: 0.9 })
    expect(detail.opportunity.plannedCostMicros).toBeGreaterThan(0)
    expect(detail.sizing?.checks.find(check => check.code === 'fresh')?.passed).toBe(true)
    expect(detail.history.map(item => item.agentProbability)).toEqual([0.8, 0.9])
    input.research.forecastRevisions.push({ ...primary, revision: 2, probability: 0.1, receivedAt: 3000 })
    expect(queryOpportunity(input, current.id).opportunity).toMatchObject({ agentProbability: 0.1, plannedCostMicros: 0 })
  })

  it('rejects expired and future predictions in an otherwise fresh opportunity preview', () => {
    const input = source()
    input.now = 30_000
    const primary = forecast(input, 'event', 0.9, input.now)
    const latest = { ...primary, revision: 1 }
    input.research.forecastRevisions.push(latest)
    for (const receivedAt of [input.now + 1, input.now - input.config.maxForecastAgeMs]) {
      latest.receivedAt = receivedAt
      const detail = queryOpportunity(input, primary.observation.observationId)
      expect(detail.opportunity.plannedCostMicros).toBe(0)
      expect(detail.sizing?.checks.find(check => check.code === 'fresh')?.passed).toBe(false)
    }
  })

  it.each(['primary', 'revision'] as const)('preserves the %s event deadline when current metadata extends it', (version) => {
    const input = source()
    const primary = forecast(input, 'event', 0.9)
    const latest = { ...primary, revision: 1, receivedAt: 2000, observation: { ...primary.observation } }
    input.research.forecastRevisions.push(latest)
    const current = observation('event', input.now, 0.25)
    input.observations.push(current)
    const expired = version === 'primary' ? primary : latest
    expired.observation.eventEndsAt = input.now
    const detail = queryOpportunity(input, current.id)
    expect(detail.opportunity.plannedCostMicros).toBe(0)
    expect(detail.sizing?.checks.find(check => check.code === 'fresh')?.passed).toBe(false)
    expired.observation.eventEndsAt = input.now + 1
    expect(queryOpportunity(input, current.id).opportunity.plannedCostMicros).toBeGreaterThan(0)
  })

  it('keeps below-edge predictions in history but outside pending qualification and score prefixes', () => {
    const input = source()
    forecast(input, 'low-edge', 0.26)
    const primary = forecast(input, 'qualified', 0.75, 2000)
    input.research.forecastRevisions.push({ ...primary, revision: 1, probability: 0.1, receivedAt: 3000 })
    input.research.settlements.push({ eventId: primary.observation.eventId, marketId: primary.observation.marketId,
      tokenId: primary.observation.tokenId, payout: 1, resolvedAt: 5000, receivedAt: 5000, source: 'https://fixture.test/result' })
    expect(queryStrategies(input)[0]).toMatchObject({ pendingEvents: 0, nextEventAt: null })
    const detail = queryStrategy(input, primary.candidateId)
    expect(detail.scores).toEqual([{ at: 5000, brier: 0.0625, marketBrier: 0.5625, resolved: 1 }])
    expect(detail.forecasts.map(item => item.probability)).toEqual([0.1, 0.75, 0.26])
    expect(queryOverview(input).forecasts).toBe(3)
  })

  it('orders equal-time revisions numerically and resolves the exact update used by a trade', () => {
    const input = source()
    const primary = forecast(input, 'event', 0.8, input.now)
    input.research.forecastRevisions = Array.from({ length: 10 }, (_, index) =>
      ({ ...primary, revision: index + 1, probability: 0.8 + (index + 1) / 100 }))
    const revision = input.research.forecastRevisions[1]!
    const primaryId = `forecast:${primary.candidateId}:${primary.observation.eventId}`
    expect(decisionViews(input).map(item => item.decision.id))
      .toEqual([...Array.from({ length: 10 }, (_, index) => `${primaryId}:revision:${10 - index}`), primaryId])
    const current = input.observations[0]!
    const candidate = input.research.candidates[0]!
    const sizing = sizePurchase(candidate, revision, current, input.account, true, true)
    input.account.trades.push({ sequence: 2, executedAt: input.now,
      cashAfterMicros: input.account.cashMicros - sizing.quote!.totalCostMicros,
      intent: { id: brandString<TradeIntentId>('purchase'), controlRevision: 1,
        strategyVersion: brandString<StrategyVersion>(candidate.id), evidenceRef: brandString<EvidenceRef>(current.id),
        marketId: current.market.id, eventId: current.market.eventId, conditionId: current.market.conditionId,
        tokenId: current.book.tokenId, quantity: sizing.quantity, costMicros: sizing.quote!.totalCostMicros,
        observedAt: input.now, validUntil: input.now + 1000,
        assessment: { algorithm: 'fractional-kelly-v1', at: input.now, accountSequence: 1, equityMicros: input.account.equityMicros,
          forecastObservationId: revision.observation.observationId, forecastReceivedAt: revision.receivedAt, forecastRevision: 2,
          probability: revision.probability, uncertainty: revision.uncertainty,
          minEdge: candidate.minEdge, kellyFraction: candidate.kellyFraction, sizing } } })
    const tradeId = brandString<DecisionId>('trade:purchase')
    expect(queryDecision(input, tradeId).references).toContainEqual({ kind: 'forecast', value: forecastDecisionId(revision) })
    expect(queryDecision(input, forecastDecisionId(primary)).decision.id).toBe(primaryId)
    delete input.account.trades[0]!.intent.assessment!.forecastRevision
    expect(queryDecision(input, tradeId).references).toContainEqual({ kind: 'forecast', value: primaryId })
  })
})
