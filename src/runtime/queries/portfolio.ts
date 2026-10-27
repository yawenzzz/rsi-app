/** Read-only portfolio attribution and cost-basis equity reconstruction. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CandidateId } from '../strategy/experiment-schema.ts'
import type { TokenId } from '../data/market.ts'
import type { Observation } from '../runtime-state.ts'
import type { ConsoleSource } from './source.ts'
import type { EquityPoint, PositionDetail, PositionView, RiskView, RiskReason, RiskStatus } from './types.ts'
import type { DecisionId } from './types.ts'
import { queryCorrelations } from './correlations.ts'

/**
 * Reconstruct equity changes from final settlement receipts without implying live marks.
 * @param source - Committed account and research state.
 * @returns initial equity and each ordered settled change.
 */
export function equityHistory(source: ConsoleSource): EquityPoint[] {
  const account = source.account
  let profit = 0
  let peak = account.config.initialCapitalMicros
  const result: EquityPoint[] = [{ at: account.createdAt, equityMicros: peak, drawdownMicros: 0, realizedProfitMicros: 0 }]
  for (const receipt of [...account.settlements].sort((a, b) => a.sequence - b.sequence)) {
    profit += receipt.profitMicros
    const equity = account.config.initialCapitalMicros + profit
    peak = Math.max(peak, equity)
    result.push({ at: receipt.settledAt, equityMicros: equity, drawdownMicros: peak - equity, realizedProfitMicros: profit })
  }
  return result
}

/**
 * Associate each open token with source metadata and original strategy receipts.
 * @param source - Committed account, forecasts and observations.
 * @returns current positions; missing metadata remains explicit.
 */
export function positionViews(source: ConsoleSource): PositionView[] {
  const events = new Map<PositionView['eventId'], number>()
  for (const position of source.account.positions) events.set(position.eventId, (events.get(position.eventId) ?? 0) + position.costMicros)
  const latest = new Map<TokenId, Observation>()
  for (const observation of source.observations) {
    const previous = latest.get(observation.book.tokenId)
    if (previous === undefined || previous.book.observedAt <= observation.book.observedAt) latest.set(observation.book.tokenId, observation)
  }
  return source.account.positions.map((position) => {
    const observation = latest.get(position.tokenId)
    const reasons = accountRiskReasons(source)
    if ((events.get(position.eventId) as number) >= source.account.config.perEventLimitMicros) reasons.push('event-capacity')
    if (observation === undefined) reasons.push('observation-missing')
    else {
      const timestamps = [observation.market.observedAt, observation.book.observedAt,
        observation.book.timestamp, observation.fees.observedAt]
      if (timestamps.some(at => at > source.now || source.now - at > source.config.maxObservationAgeMs)) reasons.push('observation-stale')
      if (observation.market.closed || Date.parse(observation.market.endDate) <= source.now) reasons.push('awaiting-settlement')
      else if (!observation.market.active || !observation.market.acceptingOrders) reasons.push('market-unavailable')
    }
    const ids = [...new Set(source.account.trades.filter(trade => trade.intent.tokenId === position.tokenId)
      .map(trade => trade.intent.strategyVersion))]
    return {
      ...position, question: observation?.market.question ?? position.marketId,
      outcome: observation?.market.tokens.find(token => token.id === position.tokenId)?.outcome ?? position.tokenId,
      averageCostMicros: Math.ceil(position.costMicros / position.quantity),
      category: observation?.market.category ?? null, endsAt: observation === undefined ? null : Date.parse(observation.market.endDate),
      latestProbability: observation?.baselineProbability ?? null, latestObservedAt: observation?.book.observedAt ?? null,
      risk: riskStatus(reasons),
      strategies: ids.map((value) => {
        const id = brandString<CandidateId>(value)
        return { id, name: source.research.candidates.find(item => item.id === id)?.name ?? id }
      }),
    }
  })
}

function accountRiskReasons({ account }: ConsoleSource): RiskReason[] {
  const reasons: RiskReason[] = []
  if (account.committedCostMicros >= account.config.totalExposureLimitMicros) reasons.push('exposure-capacity')
  if (account.peakEquityMicros - account.cashMicros >= account.config.maxDrawdownMicros) reasons.push('drawdown-capacity')
  return reasons
}

function riskStatus(reasons: RiskReason[]): RiskStatus {
  return { state: reasons.some(reason => reason !== 'observation-missing') ? 'attention' : reasons.length === 0 ? 'normal' : 'unknown',
    reasons: [...new Set(reasons)] }
}

/**
 * Derive exact cost exposures and worst-case open-token loss from the ledger.
 * @param source - Synchronously read authoritative owners.
 * @returns account limits, exposure allocations, positions and cost-basis history.
 */
export function queryRisk(source: ConsoleSource): RiskView {
  const account = source.account
  const positions = positionViews(source)
  const equity = equityHistory(source)
  let historicalDrawdownMicros = 0
  let historicalDrawdownFraction = 0
  for (const point of equity) {
    historicalDrawdownMicros = Math.max(historicalDrawdownMicros, point.drawdownMicros)
    historicalDrawdownFraction = Math.max(historicalDrawdownFraction, point.drawdownMicros / (point.equityMicros + point.drawdownMicros))
  }
  let latestSizing: RiskView['latestSizing'] = null
  for (const trade of account.trades) {
    const assessment = trade.intent.assessment
    if (assessment !== undefined) latestSizing = {
      decisionId: brandString<DecisionId>(`trade:${trade.intent.id}`), at: assessment.at,
      rawKellyFraction: assessment.sizing.rawKellyFraction, fractionalKelly: assessment.sizing.fractionalKelly,
      budgetMicros: assessment.sizing.budgetMicros, equityMicros: assessment.equityMicros,
    }
  }
  const events = new Map<PositionView['eventId'], number>()
  const categories = new Map<string | null, number>()
  for (const position of positions) {
    events.set(position.eventId, (events.get(position.eventId) ?? 0) + position.costMicros)
    categories.set(position.category, (categories.get(position.category) ?? 0) + position.costMicros)
  }
  return {
    status: riskStatus([...accountRiskReasons(source), ...positions.flatMap(position => position.risk.reasons)]),
    historicalDrawdownMicros, historicalDrawdownFraction,
    latestSizing,
    initialCapitalMicros: account.config.initialCapitalMicros, cashMicros: account.cashMicros,
    committedCostMicros: account.committedCostMicros, realizedProfitMicros: account.realizedProfitMicros,
    equityMicros: account.equityMicros, drawdownMicros: account.drawdownMicros, peakEquityMicros: account.peakEquityMicros,
    worstCaseDrawdownMicros: account.peakEquityMicros - account.cashMicros,
    perEventLimitMicros: account.config.perEventLimitMicros, totalExposureLimitMicros: account.config.totalExposureLimitMicros,
    maxDrawdownMicros: account.config.maxDrawdownMicros, positions,
    events: [...events].map(([id, costMicros]) => ({ id, costMicros })).sort((a, b) => b.costMicros - a.costMicros),
    categories: [...categories].map(([name, costMicros]) => ({ name, costMicros })), equity,
    correlations: queryCorrelations(source),
    recentRejections: source.journal.filter(record => record.decision.kind === 'trade' && record.decision.outcome === 'rejected')
      .slice(-source.config.statusLimit).reverse(),
  }
}

/**
 * Fetch open-token lots from original committed financial receipts.
 * @param source - Current account and evidence.
 * @param tokenId - Stable token identity.
 * @returns matching holding and receipts; absent positions reject.
 */
export function queryPosition(source: ConsoleSource, tokenId: TokenId): PositionDetail {
  const position = positionViews(source).find(item => item.tokenId === tokenId)
  if (position === undefined) throw new Error('Unknown open position')
  return {
    position,
    lots: source.account.trades.filter(item => item.intent.tokenId === tokenId).map(item => ({
      intentId: item.intent.id, candidateId: brandString<CandidateId>(item.intent.strategyVersion), quantity: item.intent.quantity,
      costMicros: item.intent.costMicros, executedAt: item.executedAt, cashAfterMicros: item.cashAfterMicros,
      observationId: item.intent.evidenceRef,
      assessment: item.intent.assessment ?? null,
    })),
  }
}
