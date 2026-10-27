/** Compact model-visible research status, separate from full retained records. */

import type { CandidateRank } from './strategy/experiment-types.ts'
import type { LedgerState } from './execution/ledger-types.ts'
import type { EventId, MarketId, TokenId } from './data/market.ts'
import type { ResearchRun, RuntimeState } from './runtime-state.ts'

/** Compact collection outcome; complete source observations are fetched by identity. */
export interface TickResult {
  observations: number
  skipped: number
  errors: string[]
}

/** Latest retained observations selected for one bounded status response. */
export interface ObservationSummary {
  id: string
  marketId: MarketId
  eventId: EventId
  question: string
  tokenId: TokenId
  outcome: string
  averageCostMicros: number
  observedAt: number
  endDate: string
}

/** Paper-only status; open-position equity is explicitly carried at cost. */
export interface RsiStatus {
  mode: 'paper'
  status: LedgerState['status']
  controlRevision: number
  objective: string
  directiveRevision: number
  consolePollIntervalMs: number
  account: {
    initialCapitalMicros: number
    cashMicros: number
    committedCostMicros: number
    realizedProfitMicros: number
    costBasisEquityMicros: number
    positions: number
    purchases: number
    settlements: number
  }
  candidates: CandidateRank[]
  observations: ObservationSummary[]
  observationCount: number
  lastTickError: string | null
  research: { enabled: boolean; paused: boolean; runs: ResearchRun[] }
  requests: RuntimeState['resourceRequests']
}
