/** Browser-safe query records for the five RSI business pages. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CandidateRank } from '../strategy/experiment-types.ts'
import type { CandidateId } from '../strategy/experiment-schema.ts'
import type { MarketId, TokenId, EventId } from '../data/market.ts'
import type { OperationalState } from '../runtime/operations.ts'
import type { ReleaseRecord, ReleaseCheckResult, ReleaseCommit } from '../evolution/release-types.ts'
import type { DecisionCheck, QuoteBreakdown, SizingView, TradeAssessment } from '../trading/types.ts'
export type { DecisionCheck, QuoteBreakdown, SizingView } from '../trading/types.ts'

/** A stable immutable console event reference. */
export type DecisionId = Branded<'RsiDecisionId'>
/** Opaque continuation token scoped to one ordered query. */
export type ConsoleCursor = Branded<'RsiConsoleCursor'>
/** Console event categories; financial events come from committed ledger receipts. */
export type DecisionKind = 'data' | 'research' | 'forecast' | 'trade' | 'settlement' | 'release' | 'control'
/** Evidence-backed outcome of one recorded operation. */
export type DecisionOutcome = 'completed' | 'running' | 'failed' | 'rejected' | 'interrupted'

/** Bounded result page with stable cursor continuation. */
export interface ConsolePage<T> {
  items: T[]
  total: number
  nextCursor: ConsoleCursor | null
}

/** Outcome-token observations joined to the latest prospective forecast. */
export interface OpportunityView {
  observationId: string
  marketId: MarketId
  eventId: EventId
  tokenId: TokenId
  question: string
  outcome: string
  category: string | null
  marketProbability: number
  agentProbability: number | null
  probabilityGap: number | null
  conservativeProbability: number | null
  netEdge: number | null
  lowerConfidenceBound: number | null
  askLiquidityMicros: number
  observedAt: number
  endsAt: number
  candidateId: CandidateId | null
  candidateName: string | null
  state: 'unforecasted' | 'collecting' | 'paper-eligible' | 'rejected' | 'stale' | 'settled'
  executionCostMicros: number
  plannedCostMicros: number
}

/** Live opportunity page with unfiltered category choices and its current rank offset. */
export interface OpportunityPage extends ConsolePage<OpportunityView> {
  categories: string[]
  offset: number
  unfilteredTotal: number
}

/** Filters apply on the server before pagination; null fields leave the filter open. */
export interface OpportunityQuery {
  search: string
  category: string | null
  state: OpportunityView['state'] | null
  minLiquidityMicros: number
  maxHorizonMs: number | null
  maxAgeMs: number | null
  order: 'edge' | 'liquidity' | 'deadline' | 'newest'
  cursor: ConsoleCursor | null
  limit: number
}

/** Full retained source snapshot and forecast evidence for an opportunity drawer. */
export interface OpportunityDetail {
  opportunity: OpportunityView
  description: string
  resolutionSource: string
  bookHash: string
  bookTimestamp: number
  bids: Array<{
    price: number
    size: number
  }>
  asks: Array<{
    price: number
    size: number
  }>
  feeRate: number
  feeExponent: number
  slippageBps: number
  pricing: QuoteBreakdown
  /** Recorded platform fee divided by book cost; null when the book cost is zero. */
  effectiveFeeRate: number | null
  uncertainty: number | null
  /** Clipped range from the recorded probability plus/minus its reported uncertainty. */
  probabilityRange: { low: number; high: number } | null
  evidence: Array<{
    url: string
    text: string
    stance: 'supports' | 'contradicts' | 'context' | null
  }>
  sizing: SizingView | null
  history: Array<{
    at: number
    marketProbability: number
    agentProbability: number | null
  }>
}

/** Cost-basis account point reconstructed from immutable financial receipts. */
export interface EquityPoint {
  at: number
  equityMicros: number
  drawdownMicros: number
  realizedProfitMicros: number
}

/** Strategy metrics and immutable proposal content, with a derived rank role. */
export interface StrategyView {
  id: CandidateId
  name: string
  thesis: string
  registeredAt: number
  parentId: CandidateId | null
  sourceCommit: string | null
  role: 'champion' | 'challenger' | 'rejected'
  minEdge: number
  kellyFraction: number
  maxEventHorizonMs: number | null
  metrics: CandidateRank
  realizedProfitMicros: number
  committedCostMicros: number
  checks: DecisionCheck[]
  maxDrawdownMicros: number | null
  /** Strategy contribution drawdown divided by the fixed initial account capital. */
  maxDrawdownFraction: number | null
  requiredEvents: number
  pendingEvents: number
  nextEventAt: number | null
  queueState: 'awaiting-forecasts' | 'awaiting-outcomes' | null
}

/** Strategy-specific history consumed by charts and forecast receipts. */
export interface StrategyDetail {
  strategy: StrategyView
  scores: Array<{
    at: number
    brier: number
    marketBrier: number
    resolved: number
  }>
  forecasts: Array<{
    id: DecisionId
    observationId: string
    question: string
    outcome: string
    probability: number
    marketProbability: number
    at: number
    endsAt: number
  }>
}

/** Recorded conditions requiring attention to account capacity or held-token evidence. */
export type RiskReason = 'event-capacity' | 'exposure-capacity' | 'drawdown-capacity'
  | 'observation-missing' | 'observation-stale' | 'awaiting-settlement' | 'market-unavailable'

/** Capacity and observation checks; normal does not measure outcome probability or guarantee returns. */
export interface RiskStatus {
  state: 'normal' | 'attention' | 'unknown'
  reasons: RiskReason[]
}

/** Current token holding with original lot attribution from the ledger. */
export interface PositionView {
  tokenId: TokenId
  eventId: EventId
  marketId: MarketId
  question: string
  outcome: string
  quantity: number
  costMicros: number
  averageCostMicros: number
  category: string | null
  endsAt: number | null
  latestProbability: number | null
  latestObservedAt: number | null
  risk: RiskStatus
  strategies: Array<{
    id: CandidateId
    name: string
  }>
}

/** A held token's financial receipts; cash values are the original committed values. */
export interface PositionDetail {
  position: PositionView
  lots: Array<{
    intentId: string
    candidateId: CandidateId
    quantity: number
    costMicros: number
    executedAt: number
    cashAfterMicros: number
    observationId: string
    assessment: TradeAssessment | null
  }>
}

/** Shared account figures and limits for capital and overview pages. */
export interface RiskView {
  status: RiskStatus
  /** Greatest retained cost-basis decline; recovery does not erase historical drawdown. */
  historicalDrawdownMicros: number
  /** Greatest decline divided by the equity peak at that historical point. */
  historicalDrawdownFraction: number
  /** Most recent purchase with an original sizing assessment, even if the position has settled. */
  latestSizing: {
    decisionId: DecisionId
    at: number
    rawKellyFraction: number
    fractionalKelly: number
    budgetMicros: number
    equityMicros: number
  } | null
  initialCapitalMicros: number
  cashMicros: number
  committedCostMicros: number
  realizedProfitMicros: number
  equityMicros: number
  drawdownMicros: number
  peakEquityMicros: number
  worstCaseDrawdownMicros: number
  perEventLimitMicros: number
  totalExposureLimitMicros: number
  maxDrawdownMicros: number
  positions: PositionView[]
  events: Array<{
    id: EventId
    costMicros: number
  }>
  categories: Array<{
    name: string | null
    costMicros: number
  }>
  equity: EquityPoint[]
  correlations: CorrelationView
  recentRejections: DecisionDetail[]
}

/** Paired changes, rather than raw probability levels, determine each correlation. */
export interface CorrelationView {
  categories: string[]
  windowMs: number
  bucketMs: number
  minSamples: number
  cells: Array<{ row: string; column: string; samples: number; correlation: number | null }>
}

/** Committed validation evidence; each check uses the validator's acceptance rule. */
export interface ReleaseEvidenceView extends Omit<ReleaseRecord, 'checks'> {
  /** Hash of the original stored checks, excluding their derived passed fields. */
  evidenceHash: string
  checks: Array<ReleaseCheckResult & { passed: boolean }>
}

/** Compact timeline entry suitable for bounded activity feeds. */
export interface DecisionView {
  id: DecisionId
  at: number
  kind: DecisionKind
  outcome: DecisionOutcome
  summary: string
  question: string | null
  amountMicros: number | null
  observationId: string | null
  candidateId: CandidateId | null
  sessionId: string | null
  releaseCommit?: ReleaseCommit
}

/** Filtered, newest-first audit query. */
export interface DecisionQuery {
  search: string
  kinds: DecisionKind[]
  cursor: ConsoleCursor | null
  limit: number
}

/** One timeline event with evidence references and exact financial inputs. */
export interface DecisionDetail {
  decision: DecisionView
  references: Array<{
    kind: string
    value: string
  }>
  checks: DecisionCheck[]
  pricing: QuoteBreakdown | null
  explanation: string
  assessment?: TradeAssessment | undefined
  release?: ReleaseEvidenceView
}

/** A component's last observed health, without inferring success from mere presence. */
export interface HealthView {
  component: 'gamma' | 'clob' | 'model' | 'scheduler' | 'storage'
  state: 'healthy' | 'degraded' | 'unknown' | 'paused'
  lastSuccessAt: number | null
  lastErrorAt: number | null
  error: string | null
}

/** Light overview response; long histories are fetched by their owning page. */
export interface OverviewView {
  operations: OperationalState
  workspacePath: string
  asOf: number
  risk: Omit<RiskView, 'positions' | 'events' | 'categories' | 'correlations' | 'recentRejections' | 'latestSizing'>
  todayProfitMicros: number
  observations: number
  candidates: number
  forecasts: number
  eligible: number
  positions: number
  champion: StrategyView | null
  activity: DecisionView[]
  health: HealthView[]
  lastTickAt: number | null
  nextTickAt: number | null
  nextResearchAt: number | null
  researchRunsToday: number
  researchRunsLimit: number
}
