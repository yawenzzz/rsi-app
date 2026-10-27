/** Paper account records; money is integer micro dollars and shares are whole units. @module */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ConditionId, EventId, MarketId, TokenId } from '../data/market.ts'
import type { TradeAssessment } from '../trading/types.ts'

/** Caller-assigned idempotency key for one paper purchase. */
export type TradeIntentId = Branded<'rsi.trade-intent'>
/** Immutable version identifying the strategy that proposed a purchase. */
export type StrategyVersion = Branded<'rsi.strategy-version'>
/** Reference to the recorded forecast and its supporting observation. */
export type EvidenceRef = Branded<'rsi.evidence'>
/** Reference identifying an external final-resolution observation. */
export type ResolutionRef = Branded<'rsi.resolution'>

/** Fixed paper allocation and limits; changing any field on reopen rejects. */
export interface LedgerConfig {
  /** Initial simulated cash balance in integer micro dollars. */
  initialCapitalMicros: number
  /** Aggregate committed cost allowed per event; cannot exceed total exposure. */
  perEventLimitMicros: number
  /** Aggregate committed cost allowed across open positions; cannot exceed initial capital. */
  totalExposureLimitMicros: number
  /** Maximum peak-to-equity loss in micro dollars, including zero payout on open positions. */
  maxDrawdownMicros: number
  /** Bounds the recent activity view; financial receipts are never truncated. */
  maxAuditEntries: number
}

/** Purchase proposal carrying its data freshness and control authorization. */
export interface TradeIntent {
  id: TradeIntentId
  controlRevision: number
  strategyVersion: StrategyVersion
  evidenceRef: EvidenceRef
  marketId: MarketId
  eventId: EventId
  conditionId: ConditionId
  tokenId: TokenId
  quantity: number
  /** Full worst-case debit, including modeled fees and slippage. */
  costMicros: number
  /** Unix milliseconds of the observation used for the proposal. */
  observedAt: number
  /** Exclusive expiry in Unix milliseconds, checked in the write queue. */
  validUntil: number
  /** Original research and sizing evidence, committed atomically with the purchase when supplied. */
  assessment?: TradeAssessment | undefined
}

/** Durable purchase receipt retained for exact retries and account reconstruction. */
export interface TradeReceipt {
  intent: TradeIntent
  sequence: number
  executedAt: number
  cashAfterMicros: number
}

/** Cost basis of all unsettled purchases of one outcome token. */
export interface PaperPosition {
  marketId: MarketId
  eventId: EventId
  conditionId: ConditionId
  tokenId: TokenId
  quantity: number
  costMicros: number
}

/** Final payout admitted by the market-data consumer; no manual profit adjustment exists. */
export interface TokenSettlement {
  resolutionRef: ResolutionRef
  marketId: MarketId
  eventId: EventId
  conditionId: ConditionId
  tokenId: TokenId
  final: true
  /** Integer micro dollars paid per share, from zero through 1,000,000 inclusive. */
  payoutPerShareMicros: number
  /** Unix milliseconds of the final resolution. */
  resolvedAt: number
}

/** Durable one-time final payout for all shares of one token. */
export interface SettlementReceipt {
  settlement: TokenSettlement
  sequence: number
  settledAt: number
  quantity: number
  costMicros: number
  payoutMicros: number
  profitMicros: number
  cashAfterMicros: number
}

/** Recent activity; permanent financial evidence lives in the receipt arrays. */
export type LedgerAuditEntry = {
  sequence: number
  at: number
} & (
  | { kind: 'control'; action: 'pause' | 'resume'; reason: string; controlRevision: number }
  | { kind: 'trade'; intentId: TradeIntentId }
  | { kind: 'settlement'; tokenId: TokenId }
)

/** Detached paper account snapshot; equity carries open positions at cost, never forecasts. */
export interface LedgerState {
  mode: 'paper'
  config: LedgerConfig
  createdAt: number
  sequence: number
  controlRevision: number
  status: 'paused' | 'running'
  controlReason: string
  cashMicros: number
  committedCostMicros: number
  realizedProfitMicros: number
  equityMicros: number
  peakEquityMicros: number
  drawdownMicros: number
  positions: PaperPosition[]
  trades: TradeReceipt[]
  settlements: SettlementReceipt[]
  audit: LedgerAuditEntry[]
}

/** Compare-and-set control update; stale instructions reject without replacing newer control. */
export interface LedgerControl {
  expectedRevision: number
  action: 'pause' | 'resume'
  reason: string
}

/** Ledger clock; evaluated inside each queued operation. */
export interface LedgerClock {
  /** @returns current Unix milliseconds. */
  now(): number
}
