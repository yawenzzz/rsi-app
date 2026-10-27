/** Reproducible purchase calculations shared by execution and read-only previews. */
import type { ResearchObservationId } from '../strategy/experiment-schema.ts'

/** Cost components use integer micro dollars and sum to the executable quote. */
export interface QuoteBreakdown {
  quantity: number
  bookCostMicros: number
  feeMicros: number
  slippageMicros: number
  totalCostMicros: number
}

/** One reproducible exposure or strategy criterion. Null means insufficient evidence. */
export interface DecisionCheck {
  code: 'eligible' | 'fresh' | 'depth' | 'budget' | 'edge' | 'cash' | 'event' | 'exposure' | 'drawdown'
    | 'samples' | 'brier' | 'confidence' | 'account-drawdown' | 'independence'
  passed: boolean | null
  value: number | null
  limit: number | null
}

/** Proposed whole-share purchase with its exact quote and admission criteria. */
export interface SizingView {
  rawKellyFraction: number
  fractionalKelly: number
  budgetMicros: number
  quantity: number
  quote: QuoteBreakdown | null
  checks: DecisionCheck[]
}

/** Original prediction and account inputs retained with an executed purchase or rejection. */
export interface TradeAssessment {
  algorithm: 'fractional-kelly-v1'
  at: number
  accountSequence: number
  equityMicros: number
  forecastObservationId: ResearchObservationId
  forecastReceivedAt: number
  /** Exact update used for sizing; absent legacy assessments refer to the first estimate. */
  forecastRevision?: number | undefined
  probability: number
  uncertainty: number
  minEdge: number
  kellyFraction: number
  sizing: SizingView
}
