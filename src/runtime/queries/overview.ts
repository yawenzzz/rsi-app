/** Overview statistics derived from committed state, including explicit unknown health. */
import type { ConsoleSource } from './source.ts'
import type { HealthView, OverviewView } from './types.ts'
import type { HealthReceipt } from '../runtime/health.ts'
import { decisionViews } from './decisions.ts'
import { queryRisk } from './portfolio.ts'
import { queryStrategies } from './strategies.ts'

function providerHealth(component: HealthView['component'], receipt: HealthReceipt | null, now: number, maxAge: number | null): HealthView {
  const stale = receipt !== null && maxAge !== null && (receipt.observedAt > now || now - receipt.observedAt > maxAge)
  return { component, state: receipt === null ? 'unknown' : stale ? 'degraded' : receipt.state,
    lastSuccessAt: receipt?.lastSuccessAt ?? null, lastErrorAt: receipt?.lastErrorAt ?? null,
    error: receipt?.error ?? (stale ? 'Provider observations are stale or dated in the future' : null) }
}

/**
 * Build the dashboard summary from the same records used by all detail pages.
 * @param source - Synchronous authoritative snapshot.
 * @returns bounded dashboard facts with UTC-day research and profit counters.
 */
export function queryOverview(source: ConsoleSource): OverviewView {
  const day = new Date(source.now).toISOString().slice(0, 10)
  const dayStart = Date.parse(`${day}T00:00:00Z`)
  const { positions, events: _, categories: __, correlations: ___, recentRejections: ____,
    latestSizing: _____, ...risk } = queryRisk(source)
  const lastRun = source.state.researchRuns.at(-1)
  const runsToday = source.state.researchRuns.filter(run => run.day === day).length
  const researchPaused = source.state.researchPaused || !source.config.research.enabled || source.operations.stopped
  const nextResearchAt = researchPaused ? null : Math.max(source.now,
    lastRun === undefined ? 0 : lastRun.startedAt + source.config.research.intervalMs,
    runsToday >= source.config.research.maxRunsPerDay ? dayStart + 86_400_000 : 0)
  const model = providerHealth('model', source.state.health.model, source.now, null)
  if (researchPaused) model.state = 'paused'
  return {
    asOf: source.now, operations: source.operations, workspacePath: source.config.research.cwd, risk,
    todayProfitMicros: source.account.settlements.filter(item => item.settledAt >= dayStart)
      .reduce((sum, item) => sum + item.profitMicros, 0),
    observations: source.observations.length, candidates: source.research.candidates.length,
    forecasts: source.research.forecasts.length + source.research.forecastRevisions.length,
    eligible: source.ranks.filter(item => item.status === 'paper-eligible').length, positions: positions.length,
    champion: queryStrategies(source).find(item => item.role === 'champion') ?? null,
    activity: decisionViews(source).slice(0, source.config.statusLimit).map(item => item.decision),
    lastTickAt: source.state.lastTickAt, nextTickAt: source.config.autoTick && !source.operations.stopped ? source.state.nextTickAt : null,
    nextResearchAt, researchRunsToday: runsToday, researchRunsLimit: source.config.research.maxRunsPerDay,
    health: [
      ...(['gamma', 'clob'] as const).map(component =>
        providerHealth(component, source.state.health[component], source.now, source.config.maxObservationAgeMs)),
      model,
      { component: 'scheduler', state: source.config.autoTick && !source.operations.stopped ? 'healthy' : 'paused',
        lastSuccessAt: source.state.lastTickAt, lastErrorAt: null, error: null },
      { component: 'storage', state: 'healthy', lastSuccessAt: source.now, lastErrorAt: null, error: null },
    ],
  }
}
