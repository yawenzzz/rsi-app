/** Shared research records inferred from the durable and model-input validators. */
import type { z } from 'zod'
import type {
  candidateInputSchema, experimentConfigSchema, experimentStateSchema,
  forecastInputSchema, forecastObservationSchema, researchSettlementSchema,
} from './experiment-schema.ts'
import type { CandidateId } from './experiment-schema.ts'

/** Fixed policy for candidate count, evidence size, and prospective promotion. */
export type ExperimentConfig = z.infer<typeof experimentConfigSchema>
/** Immutable candidate content before runtime identity and registration time are attached. */
export type CandidateInput = z.infer<typeof candidateInputSchema>
/** Model estimate with explicitly bounded uncertainty and recorded external evidence. */
export type ForecastInput = z.infer<typeof forecastInputSchema>
/** Runtime-owned quote and event deadline, never populated from unchecked model claims. */
export type ForecastObservation = z.infer<typeof forecastObservationSchema>
/** Settlement evidence admitted only by the runtime's trusted resolution path. */
export type ResearchSettlement = z.infer<typeof researchSettlementSchema>
/** Complete persisted research state, including unsuccessful candidate versions. */
export type ExperimentState = z.infer<typeof experimentStateSchema>
/** Frozen candidate version retained for all its future outcomes. */
export type Candidate = ExperimentState['candidates'][number]
/** Immutable first estimate for one candidate and independent event. */
export type PrimaryForecast = ExperimentState['forecasts'][number]
/** Subsequent estimate for the primary forecast's market and token. */
export type ForecastRevision = ExperimentState['forecastRevisions'][number]
/** Recorded prospective estimate; a primary has implicit revision zero. */
export type Forecast = PrimaryForecast | ForecastRevision

/** Prospective one-share diagnostics; eligibility authorizes paper trading only. */
export interface CandidateRank {
  /** Immutable candidate identity. */
  candidateId: CandidateId
  /** Stable candidate label. */
  name: string
  /** Eligibility after the current contiguous resolved sample prefix. */
  status: 'collecting' | 'paper-eligible' | 'rejected'
  /** Independent primary forecasts meeting the candidate's captured minimum edge. */
  forecastEvents: number
  /** Count of resolved events, including those behind an unresolved earlier event. */
  resolvedEvents: number
  /** Contiguous resolved prefix used for every reported score. */
  evaluatedEvents: number
  /** Mean squared error of raw probability against the fractional payout. */
  brierScore: number | null
  /** Mean squared error of the observed market midpoint against the same payouts. */
  marketBrierScore: number | null
  /** Mean payout less the captured executable cost for one whole share. */
  meanNetAdvantage: number | null
  /** Hoeffding lower bound with candidate correction and sample-size alpha spending. */
  lowerConfidenceBound: number | null
}
