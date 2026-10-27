/** Latest outcome-token opportunities with immutable source detail. */
import { opportunityQuerySchema } from './schemas.ts'
import type { Observation } from '../runtime-state.ts'
import type { Forecast } from '../strategy/experiment-types.ts'
import type { ConsoleSource } from './source.ts'
import type { OpportunityPage, OpportunityDetail, OpportunityQuery, OpportunityView } from './types.ts'
import { pageOf } from './pagination.ts'
import { explainQuote, explainSizing } from './pricing.ts'
import type { QuoteBreakdown } from './types.ts'
import { forecastRevision, latestForecasts, primaryForecast } from '../strategy/forecasts.ts'
import { forecastHistory } from './decision-ids.ts'

function latestForecast(source: ConsoleSource, observation: Observation): Forecast | undefined {
  return latestForecasts(source.research).filter(forecast => forecast.observation.tokenId === observation.book.tokenId)
    .sort((a, b) => a.receivedAt - b.receivedAt || forecastRevision(a) - forecastRevision(b)).at(-1)
}

function forecastIsFresh(source: ConsoleSource, forecast: Forecast): boolean {
  return forecast.receivedAt <= source.now && source.now - forecast.receivedAt < source.config.maxForecastAgeMs
    && source.now < forecast.observation.eventEndsAt
    && source.now < primaryForecast(source.research, forecast).observation.eventEndsAt
}

/**
 * Check all source clocks and the event's executable state.
 * @param source - Current query input.
 * @param observation - Retained executable observation.
 * @returns whether it is usable for a new prospective decision now.
 */
export function observationIsFresh(source: ConsoleSource, observation: Observation): boolean {
  const times = [observation.market.observedAt, observation.book.timestamp, observation.book.observedAt, observation.fees.observedAt]
  return times.every(at => at <= source.now && source.now - at <= source.config.maxObservationAgeMs)
    && Date.parse(observation.market.endDate) > source.now && observation.market.acceptingOrders && !observation.market.closed
}

/**
 * Project one retained observation, preserving null for unrecorded forecasts.
 * @param source - Current authoritative state.
 * @param observation - Source observation to project.
 * @returns the joined opportunity; planned cost is zero unless all execution checks pass.
 */
export function opportunityView(source: ConsoleSource, observation: Observation): OpportunityView {
  const forecast = latestForecast(source, observation)
  const candidate = source.research.candidates.find(item => item.id === forecast?.candidateId)
  const rank = source.ranks.find(item => item.candidateId === forecast?.candidateId)
  const settled = source.research.settlements.some(item => item.tokenId === observation.book.tokenId)
  const fresh = observationIsFresh(source, observation)
  const token = observation.market.tokens.find(member => member.id === observation.book.tokenId) as Observation['market']['tokens'][number]
  const sizing = candidate === undefined || forecast === undefined ? null
    : explainSizing(candidate, forecast, observation, source.account, rank?.status === 'paper-eligible',
      fresh && forecastIsFresh(source, forecast))
  return {
    observationId: observation.id, marketId: observation.market.id, eventId: observation.market.eventId,
    tokenId: observation.book.tokenId, question: observation.market.question,
    outcome: token.outcome,
    category: observation.market.category ?? null,
    marketProbability: observation.baselineProbability, agentProbability: forecast?.probability ?? null,
    probabilityGap: forecast === undefined ? null : forecast.probability - observation.baselineProbability,
    conservativeProbability: forecast === undefined ? null : Math.max(0, forecast.probability - forecast.uncertainty),
    netEdge: forecast === undefined ? null : forecast.probability - observation.averageCostMicros / 1_000_000,
    lowerConfidenceBound: rank?.lowerConfidenceBound ?? null,
    askLiquidityMicros: Math.floor(observation.book.asks.reduce((sum, level) => sum + level.price * level.size, 0) * 1_000_000),
    observedAt: observation.book.observedAt, endsAt: Date.parse(observation.market.endDate),
    candidateId: forecast?.candidateId ?? null, candidateName: candidate?.name ?? null,
    state: settled ? 'settled' : !fresh ? 'stale' : rank?.status ?? 'unforecasted',
    executionCostMicros: observation.averageCostMicros,
    plannedCostMicros: !source.operations.stopped && source.account.status === 'running' && sizing?.checks.every(check => check.passed === true)
      ? sizing.quote?.totalCostMicros ?? 0 : 0,
  }
}

/**
 * Filter current token observations and paginate after sorting on stable tie breakers.
 * @param source - Current authoritative state.
 * @param request - Wire query, validated before use.
 * @returns a bounded newest-token result page.
 */
export function queryOpportunities(source: ConsoleSource, request: OpportunityQuery): OpportunityPage {
  const query = opportunityQuerySchema.parse(request)
  const latest = new Map<string, Observation>()
  for (const observation of source.observations) {
    const prior = latest.get(observation.book.tokenId)
    if (prior === undefined || prior.book.observedAt <= observation.book.observedAt) latest.set(observation.book.tokenId, observation)
  }
  const search = query.search.toLowerCase()
  const categories = [...new Set([...latest.values()].flatMap(item =>
    item.market.category === undefined ? [] : [item.market.category]))].sort()
  const rows = [...latest.values()].map(observation => opportunityView(source, observation)).filter(row =>
    (row.question + ' ' + row.outcome).toLowerCase().includes(search)
    && (query.category === null || row.category === query.category)
    && (query.state === null || row.state === query.state)
    && row.askLiquidityMicros >= query.minLiquidityMicros
    && (query.maxHorizonMs === null || row.endsAt - source.now <= query.maxHorizonMs)
    && (query.maxAgeMs === null || source.now - row.observedAt <= query.maxAgeMs))
  rows.sort((a, b) => {
    const difference = query.order === 'edge' ? (b.netEdge ?? -Infinity) - (a.netEdge ?? -Infinity)
      : query.order === 'liquidity' ? b.askLiquidityMicros - a.askLiquidityMicros
        : query.order === 'deadline' ? a.endsAt - b.endsAt : b.observedAt - a.observedAt
    return difference || a.tokenId.localeCompare(b.tokenId)
  })
  const { cursor: _, limit: __, ...filter } = query
  const page = pageOf(rows, row => row.tokenId, request.cursor, query.limit, filter)
  const first = page.items[0]
  return { ...page, categories, unfilteredTotal: latest.size,
    offset: first === undefined ? rows.length : rows.findIndex(row => row.tokenId === first.tokenId) }
}

/**
 * Read source data and evidence for one immutable observation.
 * @param source - Current authoritative state.
 * @param id - Observation reference retained by the server.
 * @returns the source detail; unknown IDs reject instead of silently showing another market.
 */
export function queryOpportunity(source: ConsoleSource, id: string): OpportunityDetail {
  const observation = source.observations.find(item => item.id === id)
  if (observation === undefined) throw new Error('Unknown opportunity observation')
  const forecast = latestForecast(source, observation)
  const candidate = source.research.candidates.find(item => item.id === forecast?.candidateId)
  const opportunity = opportunityView(source, observation)
  const pricing = explainQuote(observation, observation.quantity) as QuoteBreakdown
  const history = forecastHistory(source.research)
  return {
    opportunity, description: observation.market.description, resolutionSource: observation.market.resolutionSource,
    bookHash: observation.book.hash, bookTimestamp: observation.book.timestamp,
    bids: observation.book.bids, asks: observation.book.asks,
    feeRate: observation.fees.rate, feeExponent: observation.fees.exponent, slippageBps: observation.slippageBps,
    pricing, effectiveFeeRate: pricing.bookCostMicros === 0 ? null : pricing.feeMicros / pricing.bookCostMicros,
    uncertainty: forecast?.uncertainty ?? null,
    probabilityRange: forecast === undefined ? null : {
      low: Math.max(0, forecast.probability - forecast.uncertainty), high: Math.min(1, forecast.probability + forecast.uncertainty),
    },
    evidence: forecast?.evidence.map(item => ({ ...item, stance: item.stance ?? null })) ?? [],
    sizing: candidate === undefined || forecast === undefined ? null
      : explainSizing(candidate, forecast, observation, source.account, opportunity.state === 'paper-eligible',
        observationIsFresh(source, observation) && forecastIsFresh(source, forecast)),
    history: source.observations.filter(item => item.book.tokenId === observation.book.tokenId)
      .sort((a, b) => a.book.observedAt - b.book.observedAt).slice(-source.config.statusLimit).map((item) => {
        const known = history.findLast(value =>
          value.observation.tokenId === item.book.tokenId && value.receivedAt <= item.book.observedAt)
        return { at: item.book.observedAt, marketProbability: item.baselineProbability, agentProbability: known?.probability ?? null }
      }),
  }
}
