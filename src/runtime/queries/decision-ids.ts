/** Stable references and chronological ordering for primary forecasts and their revisions. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ExperimentState, Forecast } from '../strategy/experiment-types.ts'
import { forecastRevision } from '../strategy/forecasts.ts'
import type { DecisionId } from './types.ts'

/**
 * Identify an exact forecast while preserving the first estimate's existing reference.
 * @param forecast - Retained candidate and event ownership.
 * @returns the exact reference accepted by decision inspection.
 */
export function forecastDecisionId(forecast: Forecast): DecisionId {
  const revision = forecastRevision(forecast)
  const suffix = revision === 0 ? '' : `:revision:${revision}`
  return brandString<DecisionId>(`forecast:${forecast.candidateId}:${forecast.observation.eventId}${suffix}`)
}

/**
 * Order all retained estimates by receipt time and revision, including non-trading predictions.
 * @param state - Complete primary and revision evidence.
 * @returns oldest-first records with deterministic ties across events.
 */
export function forecastHistory(state: ExperimentState): Forecast[] {
  return [...state.forecasts, ...state.forecastRevisions].sort((a, b) => a.receivedAt - b.receivedAt
    || forecastRevision(a) - forecastRevision(b) || forecastDecisionId(a).localeCompare(forecastDecisionId(b)))
}
