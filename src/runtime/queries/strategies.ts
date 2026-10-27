/** Strategy comparison derived from immutable prospective evidence and receipt attribution. */
import type { CandidateId } from '../strategy/experiment-schema.ts'
import type { Candidate } from '../strategy/experiment-types.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StrategyVersion } from '../execution/ledger-types.ts'
import type { ConsoleSource } from './source.ts'
import type { StrategyDetail, StrategyView } from './types.ts'
import { forecastDecisionId, forecastHistory } from './decision-ids.ts'
import { qualificationForecasts } from '../strategy/forecasts.ts'

/**
 * Join ranked evidence, proposal lineage and actual strategy cash flows.
 * @param source - Authoritative read input.
 * @returns every candidate; champion denotes the current best eligible rank.
 */
export function queryStrategies(source: ConsoleSource): StrategyView[] {
  const champion = source.ranks.find(rank => rank.status === 'paper-eligible')?.candidateId
  return source.ranks.map((rank) => {
    const candidate = source.research.candidates.find(item => item.id === rank.candidateId) as Candidate
    const trades = source.account.trades.filter(item => item.intent.strategyVersion === brandString<StrategyVersion>(candidate.id))
    const settlements = new Map(source.account.settlements.map(item => [item.settlement.tokenId, item]))
    const cashChanges = new Map<number, number>()
    let profit = 0
    let committed = 0
    for (const trade of trades) {
      const settlement = settlements.get(trade.intent.tokenId)
      if (settlement === undefined) committed += trade.intent.costMicros
      else cashChanges.set(settlement.sequence, (cashChanges.get(settlement.sequence) ?? 0)
        + trade.intent.quantity * settlement.settlement.payoutPerShareMicros - trade.intent.costMicros)
    }
    let peak = 0
    let drawdown = 0
    for (const [, change] of [...cashChanges].sort((a, b) => a[0] - b[0])) {
      profit += change
      peak = Math.max(peak, profit)
      drawdown = Math.max(drawdown, peak - profit)
    }
    const resolvedTokens = new Set(source.research.settlements.map(item => item.tokenId))
    const pending = qualificationForecasts(source.research, candidate.id).filter(item => !resolvedTokens.has(item.observation.tokenId))
    const nextEventAt = pending.reduce<number | null>((at, item) =>
      at === null ? item.observation.eventEndsAt : Math.min(at, item.observation.eventEndsAt), null)
    return {
      id: candidate.id, name: candidate.name, thesis: candidate.thesis, registeredAt: candidate.registeredAt,
      parentId: candidate.parentId ?? null, sourceCommit: candidate.sourceCommit ?? null,
      role: rank.status === 'rejected' ? 'rejected' : rank.candidateId === champion ? 'champion' : 'challenger',
      minEdge: candidate.minEdge, kellyFraction: candidate.kellyFraction, maxEventHorizonMs: candidate.maxEventHorizonMs ?? null,
      metrics: rank, realizedProfitMicros: profit, committedCostMicros: committed,
      maxDrawdownMicros: trades.length === 0 ? null : drawdown,
      maxDrawdownFraction: trades.length === 0 ? null : drawdown / source.account.config.initialCapitalMicros,
      requiredEvents: source.config.experiments.minResolvedEvents, pendingEvents: pending.length, nextEventAt,
      queueState: rank.status !== 'collecting' ? null : pending.length > 0 ? 'awaiting-outcomes' : 'awaiting-forecasts',
      checks: [
        { code: 'samples', passed: rank.evaluatedEvents >= source.config.experiments.minResolvedEvents,
          value: rank.evaluatedEvents, limit: source.config.experiments.minResolvedEvents },
        { code: 'confidence', passed: rank.lowerConfidenceBound === null ? null : rank.lowerConfidenceBound > 0,
          value: rank.lowerConfidenceBound, limit: 0 },
        { code: 'brier', passed: rank.brierScore === null || rank.marketBrierScore === null ? null : rank.brierScore < rank.marketBrierScore,
          value: rank.brierScore, limit: rank.marketBrierScore },
        { code: 'account-drawdown', passed: source.account.drawdownMicros <= source.account.config.maxDrawdownMicros,
          value: source.account.drawdownMicros, limit: source.account.config.maxDrawdownMicros },
        { code: 'independence', passed: null, value: null, limit: null },
      ],
    }
  })
}

/**
 * Reconstruct cumulative scores only over the same contiguous prefix used for eligibility.
 * @param source - Authoritative read input.
 * @param id - Candidate identity.
 * @returns the complete bounded strategy detail or rejects an unknown identity.
 */
export function queryStrategy(source: ConsoleSource, id: CandidateId): StrategyDetail {
  const strategy = queryStrategies(source).find(item => item.id === id)
  if (strategy === undefined) throw new Error('Unknown strategy')
  const forecasts = qualificationForecasts(source.research, id)
  const scores: StrategyDetail['scores'] = []
  let brier = 0
  let baseline = 0
  let at = 0
  for (const forecast of forecasts) {
    const settlement = source.research.settlements.find(item => item.tokenId === forecast.observation.tokenId)
    if (settlement === undefined) break
    brier += (forecast.probability - settlement.payout) ** 2
    baseline += (forecast.observation.baselineProbability - settlement.payout) ** 2
    at = Math.max(at, settlement.receivedAt)
    const resolved = scores.length + 1
    scores.push({ at, brier: brier / resolved, marketBrier: baseline / resolved, resolved })
  }
  return {
    strategy, scores,
    forecasts: forecastHistory(source.research).filter(item => item.candidateId === id)
      .slice(-source.config.statusLimit).reverse().map((forecast) => {
        const observation = source.observations.find(item => item.id === forecast.observation.observationId)
        return {
          id: forecastDecisionId(forecast),
          observationId: forecast.observation.observationId,
          question: observation?.market.question ?? forecast.observation.marketId,
          outcome: observation?.market.tokens.find(token => token.id === forecast.observation.tokenId)?.outcome
            ?? forecast.observation.tokenId,
          probability: forecast.probability, marketProbability: forecast.observation.baselineProbability,
          at: forecast.receivedAt, endsAt: forecast.observation.eventEndsAt,
        }
      }),
  }
}
