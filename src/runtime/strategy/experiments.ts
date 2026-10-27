/** Atomic prospective research registration and repeated-look-safe paper eligibility. */
import assert from 'node:assert/strict'
import type { Domain, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import {
  candidateInputSchema, candidateVersion, experimentConfigSchema, forecastInputSchema,
  forecastObservationSchema, researchDomain, researchSettlementSchema,
} from './experiment-schema.ts'
import type {
  Candidate, CandidateInput, CandidateRank, ExperimentConfig, ExperimentState,
  Forecast, ForecastInput, ForecastObservation, ResearchSettlement,
} from './experiment-types.ts'
import { qualificationForecasts } from './forecasts.ts'

/**
 * Owns a single research record. Returned records are detached snapshots; writes
 * resolve after durability, and rejected writes never change visible evidence.
 */
export class Experiments {
  private constructor(
    private readonly domain: Domain<typeof researchDomain>,
    private readonly clock: () => number,
    private readonly mutationGuard: () => void,
    private readonly admissionGuard: () => void,
  ) {}

  /**
   * Open or initialize prospective research. A changed evaluator configuration rejects.
   * @param storageDomain - Host's sole domain facility for this state root.
   * @param config - Explicit thresholds, permanently bound to this research record.
   * @param clock - Runtime UTC milliseconds; models cannot supply forecast creation dates.
   * @param mutationGuard - Host authority checked inside every queued mutation.
   * @param admissionGuard - Additional admission control for candidates and forecasts; settlements remain independent.
   * @returns opened registry; the caller owns close.
   */
  static async open(
    storageDomain: DomainFacility, config: ExperimentConfig, clock: () => number = Date.now, mutationGuard: () => void = () => {},
    admissionGuard: () => void = () => {},
  ): Promise<Experiments> {
    const validated = experimentConfigSchema.parse(config)
    const domain = await storageDomain.open(researchDomain)
    try {
      const table = domain.table('research')
      const current = table.get('state')
      if (!current) {
        mutationGuard()
        await table.put('state', { config: validated, candidates: [], forecasts: [], forecastRevisions: [], settlements: [] })
      } else if (JSON.stringify(current.config) !== JSON.stringify(validated)) {
        throw new Error('research evaluation configuration differs from the persisted configuration')
      }
      return new Experiments(domain, clock, mutationGuard, admissionGuard)
    } catch (error) {
      await domain.close()
      throw error
    }
  }

  /**
   * Read all prospective evidence, including unsuccessful candidates.
   * @returns detached durable snapshot.
   */
  view(): ExperimentState {
    const state = this.domain.table('research').get('state')
    assert(state)
    return structuredClone(state)
  }

  /**
   * Register immutable candidate content; identical content returns its existing version.
   * @param input - Candidate policy and hypothesis; changed content consumes another slot.
   * @returns durably registered candidate.
   */
  async registerCandidate(input: CandidateInput): Promise<Candidate> {
    const policy = candidateInputSchema.parse(input)
    const id = candidateVersion(policy)
    const next = await this.domain.table('research').update('state', (current) => {
      this.mutationGuard()
      this.admissionGuard()
      if (current.candidates.some(candidate => candidate.id === id)) return current
      if (policy.parentId !== undefined && !current.candidates.some(candidate => candidate.id === policy.parentId)) {
        throw new Error('Candidate parent must be a registered earlier version')
      }
      if (current.candidates.length >= current.config.maxCandidates) throw new Error('research candidate budget exhausted')
      if (Buffer.byteLength(policy.name + policy.thesis) > current.config.maxEvidenceBytes) throw new Error('candidate text exceeds the evidence byte budget')
      return { ...current, candidates: [...current.candidates, { ...policy, id, registeredAt: this.now() }] }
    })
    const candidate = next.candidates.find(item => item.id === id)
    assert(candidate)
    return structuredClone(candidate)
  }

  /**
   * Retain the first estimate and append subsequent estimates for the same outcome.
   * @param input - Model-owned estimate only, validated independently of runtime fields.
   * @param observation - Trusted stored book cost, midpoint, event identity, and deadline.
   * @returns a durable primary or numbered revision; settled events reject every update.
   */
  async recordForecast(input: ForecastInput, observation: ForecastObservation): Promise<Forecast> {
    const estimate = forecastInputSchema.parse(input)
    const quote = forecastObservationSchema.parse(observation)
    const next = await this.domain.table('research').update('state', (current) => {
      this.mutationGuard()
      this.admissionGuard()
      const receivedAt = this.now()
      const candidate = current.candidates.find(item => item.id === estimate.candidateId)
      if (!candidate) throw new Error('forecast candidate is not registered')
      if (receivedAt < candidate.registeredAt || receivedAt >= quote.eventEndsAt || quote.observedAt > receivedAt) throw new Error('forecast must precede the event deadline and follow its observation and candidate registration')
      if (candidate.maxEventHorizonMs !== undefined && quote.eventEndsAt - receivedAt > candidate.maxEventHorizonMs) {
        throw new Error('Forecast scheduled event end exceeds the candidate event horizon')
      }
      if (current.settlements.some(item => item.eventId === quote.eventId)) throw new Error('event already has a known settlement')
      const primary = current.forecasts.find(item => item.candidateId === estimate.candidateId
        && item.observation.eventId === quote.eventId)
      if (current.forecasts.length + current.forecastRevisions.length >= current.config.maxForecasts) throw new Error('research forecast budget exhausted')
      if (Buffer.byteLength(JSON.stringify(estimate.evidence)) > current.config.maxEvidenceBytes) throw new Error('forecast evidence exceeds the byte budget')
      const forecast = { ...estimate, observation: quote, receivedAt }
      if (primary === undefined) return { ...current, forecasts: [...current.forecasts, forecast] }
      if (primary.observation.marketId !== quote.marketId || primary.observation.tokenId !== quote.tokenId) {
        throw new Error('Forecast revision must preserve its primary market and token')
      }
      const previous = current.forecastRevisions.findLast(item => item.candidateId === estimate.candidateId
        && item.observation.eventId === quote.eventId)
      if (receivedAt < (previous ?? primary).receivedAt || receivedAt >= primary.observation.eventEndsAt) {
        throw new Error('Forecast revision must follow its previous estimate and precede the primary event deadline')
      }
      return { ...current, forecastRevisions: [...current.forecastRevisions, { ...forecast, revision: (previous?.revision ?? 0) + 1 }] }
    })
    const forecast = next.forecastRevisions.findLast(item => item.candidateId === estimate.candidateId
      && item.observation.eventId === quote.eventId)
      ?? next.forecasts.find(item => item.candidateId === estimate.candidateId && item.observation.eventId === quote.eventId)
    assert(forecast)
    return structuredClone(forecast)
  }

  /**
   * Record a trusted token payout. An identical settlement is idempotent; corrections reject.
   * @param input - Runtime resolution evidence, including explicit fractional payouts.
   * @returns resolution after persistence; no existing forecast or payout is replaced.
   */
  async settle(input: ResearchSettlement): Promise<void> {
    const settlement = researchSettlementSchema.parse(input)
    await this.domain.table('research').update('state', (current) => {
      this.mutationGuard()
      const existing = current.settlements.find(item => item.marketId === settlement.marketId && item.tokenId === settlement.tokenId)
      if (existing) {
        const { receivedAt: _, ...evidence } = existing
        if (JSON.stringify(evidence) !== JSON.stringify(settlement)) throw new Error('token settlement is immutable')
        return current
      }
      const forecasts = current.forecasts.filter(item =>
        item.observation.marketId === settlement.marketId && item.observation.tokenId === settlement.tokenId)
      if (!forecasts.length) throw new Error('settlement token has no registered forecast')
      const receivedAt = this.now()
      if (settlement.resolvedAt > receivedAt) throw new Error('settlement resolution cannot be in the future')
      if (forecasts.some(item => item.observation.eventId !== settlement.eventId)) throw new Error('settlement event does not match the forecast event')
      if ([...current.forecasts, ...current.forecastRevisions].some(item =>
        item.observation.eventId === settlement.eventId && item.receivedAt >= settlement.resolvedAt)) throw new Error('settlement reveals a non-prospective event forecast')
      return { ...current, settlements: [...current.settlements, { ...settlement, receivedAt }] }
    })
  }

  /**
   * Score admission-order prefixes of primary estimates meeting their captured minimum edge.
   * Revisions and below-edge primaries never alter the qualification sample.
   * At sample size n, alpha/(maxCandidates*n*(n+1)) bounds that look; the sum
   * across all candidates and all sample sizes is at most confidenceAlpha.
   * @returns every candidate, best lower bound first; no eligible candidate means cash.
   */
  rank(): CandidateRank[] {
    const state = this.view()
    return state.candidates.map((candidate): CandidateRank => {
      const forecasts = qualificationForecasts(state, candidate.id)
      const samples = forecasts.map(forecast => ({
        forecast,
        outcome: state.settlements.find(item =>
          item.marketId === forecast.observation.marketId && item.tokenId === forecast.observation.tokenId),
      }))
      let n = 0
      let brier = 0
      let baseline = 0
      let net = 0
      for (const { forecast, outcome } of samples) {
        if (!outcome) break
        n++
        const payout = outcome.payout
        brier += (forecast.probability - payout) ** 2
        baseline += (forecast.observation.baselineProbability - payout) ** 2
        net += payout - forecast.observation.costMicros / 1_000_000
      }
      const lower = n === 0 ? null
        : net / n - Math.sqrt(2 * Math.log(state.config.maxCandidates * n * (n + 1) / state.config.confidenceAlpha) / n)
      return {
        candidateId: candidate.id,
        name: candidate.name,
        status: n < state.config.minResolvedEvents ? 'collecting'
          : lower !== null && lower > 0 && brier < baseline ? 'paper-eligible' : 'rejected',
        forecastEvents: forecasts.length,
        resolvedEvents: samples.filter(sample => sample.outcome !== undefined).length,
        evaluatedEvents: n,
        brierScore: n === 0 ? null : brier / n,
        marketBrierScore: n === 0 ? null : baseline / n,
        meanNetAdvantage: n === 0 ? null : net / n,
        lowerConfidenceBound: lower,
      }
    }).sort((a, b) =>
      (b.lowerConfidenceBound ?? -Infinity) - (a.lowerConfidenceBound ?? -Infinity) || a.candidateId.localeCompare(b.candidateId))
  }

  /**
   * Reject new writes and drain already queued research transitions.
   * @returns resolution after the domain is released; repeated calls share teardown.
   */
  close(): Promise<void> {
    return this.domain.close()
  }

  private now(): number {
    const value = this.clock()
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('research clock must return nonnegative UTC milliseconds')
    return value
  }
}
