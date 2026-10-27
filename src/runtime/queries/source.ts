/** One synchronous read of the authoritative research, market and account owners. */
import type { Config } from '../config.ts'
import type { CandidateRank, ExperimentState } from '../strategy/experiment-types.ts'
import type { LedgerState } from '../execution/ledger-types.ts'
import type { Observation, RuntimeState } from '../runtime-state.ts'
import type { DecisionDetail } from './types.ts'
import type { OperationalState } from '../runtime/operations.ts'
import type { ReleaseRecordStore } from '../evolution/release-types.ts'

/** Internal query input; never returned as an unbounded Remote payload. */
export interface ConsoleSource {
  now: number
  config: Config
  state: RuntimeState
  account: LedgerState
  research: ExperimentState
  ranks: CandidateRank[]
  observations: Observation[]
  journal: DecisionDetail[]
  operations: OperationalState
  releases: Pick<ReleaseRecordStore, 'list' | 'get'> | null
}
