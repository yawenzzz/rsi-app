/** Primary sampling and prospective updates share immutable candidate/event ownership. */
import assert from 'node:assert/strict'
import type { CandidateId } from './experiment-schema.ts'
import type { ExperimentState, Forecast, PrimaryForecast } from './experiment-types.ts'

/**
 * Select qualification samples using only the first recorded estimate and cost.
 * @param state - Complete research evidence.
 * @param candidateId - Registered candidate whose immutable threshold applies.
 * @returns independent primary samples in admission order; updates never join the sample.
 */
export function qualificationForecasts(state: ExperimentState, candidateId: CandidateId): PrimaryForecast[] {
  const candidate = state.candidates.find(item => item.id === candidateId)
  assert(candidate)
  return state.forecasts.filter(forecast => forecast.candidateId === candidateId
    && Math.max(0, forecast.probability - forecast.uncertainty) - forecast.observation.costMicros / 1_000_000 >= candidate.minEdge)
}

/**
 * Select the newest retained estimate for each candidate and event.
 * @param state - Complete primary and revision evidence.
 * @returns current estimates in primary admission order, including below-edge estimates.
 */
export function latestForecasts(state: ExperimentState): Forecast[] {
  const latest = new Map<string, Forecast>()
  for (const forecast of [...state.forecasts, ...state.forecastRevisions]) {
    latest.set(JSON.stringify([forecast.candidateId, forecast.observation.eventId]), forecast)
  }
  return [...latest.values()]
}

/**
 * Resolve the immutable anchor used for one candidate/event purchase identity.
 * @param state - Complete research evidence.
 * @param forecast - A primary or revision belonging to the state.
 * @returns the unchanged primary; its observation identifies the existing purchase slot.
 */
export function primaryForecast(state: ExperimentState, forecast: Forecast): PrimaryForecast {
  const primary = state.forecasts.find(item => item.candidateId === forecast.candidateId
    && item.observation.eventId === forecast.observation.eventId)
  assert(primary)
  return primary
}

/**
 * Read a receipt's sequence without adding fields to retained primary records.
 * @param forecast - Prospective primary or revision.
 * @returns zero for the primary and a positive sequence for an update.
 */
export function forecastRevision(forecast: Forecast): number {
  return 'revision' in forecast ? forecast.revision : 0
}
