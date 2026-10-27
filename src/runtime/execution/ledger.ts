/** Single-process paper execution over one atomically persisted account record. @module */

import { isDeepStrictEqual } from 'node:util'
import type { Domain, DomainFacility, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { paperLedgerDomain, sameOwner, matchesAssessment } from './ledger-schema.ts'
import type {
  LedgerAuditEntry, LedgerClock, LedgerConfig, LedgerControl, LedgerState,
  PaperPosition, SettlementReceipt, TokenSettlement, TradeIntent, TradeReceipt,
} from './ledger-types.ts'

/**
 * Durable simulated purchases and final payouts. No wallet, network order, deposit,
 * withdrawal, or balance-adjustment operation exists. One process owns the domain;
 * the application must prevent multiple processes from opening the same account.
 */
export class PaperLedger {
  private readonly table: KvTable<'paper', LedgerState>

  private constructor(
    private readonly domain: Domain<typeof paperLedgerDomain>,
    private readonly clock: LedgerClock,
    private readonly assertWriter: () => void,
    private readonly assertExecutionAllowed: () => void,
  ) {
    this.table = domain.table('account')
  }

  /**
   * Restore a validated account or durably create a paused account. Configuration
   * must exactly match the original allocation on reopen; failed opens release the domain.
   * @param storageDomain - Mounted domain facility routed to a durable backend.
   * @param config - Validated fixed paper allocation and risk limits.
   * @param clock - Clock evaluated inside the write queue; defaults to wall-clock time.
   * @param assertWriter - Synchronous ownership check before account creation and each queued update; defaults to no check.
   * @param assertExecutionAllowed - Admission latch checked for a new queued purchase, after exact-retry lookup.
   * @returns the caller-owned ledger, which must be closed on disposal.
   */
  static async open(
    storageDomain: DomainFacility,
    config: LedgerConfig,
    clock: LedgerClock = { now: Date.now },
    assertWriter: () => void = () => {},
    assertExecutionAllowed: () => void = () => {},
  ): Promise<PaperLedger> {
    const domain = await storageDomain.open(paperLedgerDomain)
    try {
      const table = domain.table('account')
      const current = table.get('paper')
      if (table.size !== (current === undefined ? 0 : 1)) throw new Error('Paper account has unexpected records.')
      if (current === undefined) {
        assertWriter()
        await table.put('paper', {
          mode: 'paper', config: structuredClone(config), createdAt: clock.now(), sequence: 0,
          controlRevision: 0, status: 'paused', controlReason: 'Initial paper account is paused.',
          cashMicros: config.initialCapitalMicros, committedCostMicros: 0, realizedProfitMicros: 0,
          equityMicros: config.initialCapitalMicros, peakEquityMicros: config.initialCapitalMicros,
          drawdownMicros: 0, positions: [], trades: [], settlements: [], audit: [],
        })
      } else if (!isDeepStrictEqual(current.config, config)) {
        throw new Error('Paper account configuration differs from its original allocation; reopen with the stored configuration.')
      }
      return new PaperLedger(domain, clock, assertWriter, assertExecutionAllowed)
    } catch (error) {
      await domain.close()
      throw error
    }
  }

  /**
   * Read the latest durable account without exposing mutable stored objects.
   * @returns a detached account snapshot; closing the domain makes reads reject.
   */
  view(): LedgerState {
    return structuredClone(this.table.get('paper') as LedgerState)
  }

  /**
   * Atomically pause or resume using a control revision. Pausing blocks purchases
   * queued after it; an earlier committed purchase remains in the account.
   * @param control - Expected revision, requested state, and recorded reason.
   * @returns a detached account after the control update is durable.
   */
  async control(control: LedgerControl): Promise<LedgerState> {
    const request = structuredClone(control)
    const next = await this.table.update('paper', (current) => {
      this.assertWriter()
      requireRevision(current, request.expectedRevision)
      if (request.action === 'resume' && current.drawdownMicros >= current.config.maxDrawdownMicros) {
        throw new Error('Paper drawdown limit is reached; purchases cannot resume.')
      }
      const sequence = current.sequence + 1
      const controlRevision = current.controlRevision + 1
      return withAudit({
        ...current, sequence, controlRevision,
        status: request.action === 'pause' ? 'paused' : 'running', controlReason: request.reason,
      }, { kind: 'control', sequence, at: this.clock.now(), action: request.action, reason: request.reason, controlRevision })
    })
    return structuredClone(next)
  }

  /**
   * Commit a simulated fill, its full debit, position, and receipt in one write.
   * Exact idempotent retries return the original receipt; different payloads using
   * the same id reject. Writer ownership, risk, control, and freshness are checked at the queued write.
   * @param intent - Complete purchase proposal; share quantity and money must be safe integers.
   * @param assertAdmission - Optional synchronous caller check inside the write queue; exact retries bypass it.
   * @returns a detached receipt only after durability; failure leaves balances unchanged.
   */
  async execute(intent: TradeIntent, assertAdmission?: () => void): Promise<TradeReceipt> {
    const { assessment, ...fields } = structuredClone(intent)
    const request: TradeIntent = assessment === undefined ? fields : { ...fields, assessment }
    const next = await this.table.update('paper', (current) => {
      this.assertWriter()
      const previousReceipt = current.trades.find(receipt => receipt.intent.id === request.id)
      if (previousReceipt !== undefined) {
        if (!isDeepStrictEqual(previousReceipt.intent, request)) throw new Error('Paper intent id already identifies a different purchase.')
        return current
      }
      this.assertExecutionAllowed()
      assertAdmission?.()
      requireRevision(current, request.controlRevision)
      if (current.status !== 'running') throw new Error('Paper account is paused.')
      const now = this.clock.now()
      if (request.observedAt > now || request.validUntil <= now || request.observedAt >= request.validUntil) {
        throw new Error('Paper purchase observation is future-dated or expired.')
      }
      if (!matchesAssessment(request, current.sequence + 1, now)) throw new Error('Paper purchase conflicts with its recorded assessment.')
      if (!Number.isSafeInteger(request.quantity) || request.quantity <= 0
        || !Number.isSafeInteger(request.quantity * 1_000_000)
        || !Number.isSafeInteger(request.costMicros) || request.costMicros <= 0) {
        throw new Error('Paper purchase requires positive whole shares and positive safe-integer micro-dollar cost.')
      }
      if (current.settlements.some(receipt => receipt.settlement.tokenId === request.tokenId)) {
        throw new Error('Paper token is already settled.')
      }
      const previous = current.positions.find(position => position.tokenId === request.tokenId)
      if (previous !== undefined && !sameOwner(previous, request)) throw new Error('Paper token ownership does not match its position.')
      const position: PaperPosition = {
        marketId: request.marketId, eventId: request.eventId, conditionId: request.conditionId, tokenId: request.tokenId,
        quantity: (previous?.quantity ?? 0) + request.quantity,
        costMicros: (previous?.costMicros ?? 0) + request.costMicros,
      }
      if (!Number.isSafeInteger(position.quantity * 1_000_000)) throw new Error('Paper position share count exceeds safe-integer accounting.')
      const cashMicros = current.cashMicros - request.costMicros
      const committedCostMicros = current.committedCostMicros + request.costMicros
      const eventCostMicros = current.positions.filter(item => item.eventId === request.eventId)
        .reduce((total, item) => total + item.costMicros, request.costMicros)
      if (cashMicros < 0) throw new Error('Paper purchase exceeds available cash.')
      if (eventCostMicros > current.config.perEventLimitMicros) throw new Error('Paper purchase exceeds aggregate event exposure.')
      if (committedCostMicros > current.config.totalExposureLimitMicros) throw new Error('Paper purchase exceeds aggregate account exposure.')
      if (current.peakEquityMicros - cashMicros > current.config.maxDrawdownMicros) {
        throw new Error('Paper purchase exceeds remaining drawdown budget if open positions pay zero.')
      }
      const sequence = current.sequence + 1
      const receipt: TradeReceipt = { intent: request, sequence, executedAt: now, cashAfterMicros: cashMicros }
      const positions = previous === undefined
        ? [...current.positions, position]
        : current.positions.map(item => item.tokenId === request.tokenId ? position : item)
      return withAudit({
        ...current, sequence, cashMicros, committedCostMicros, positions, trades: [...current.trades, receipt],
      }, { kind: 'trade', sequence, at: now, intentId: request.id })
    })
    return structuredClone(next.trades.find(receipt => receipt.intent.id === request.id) as TradeReceipt)
  }

  /**
   * Apply a final external payout once per token, including while paused. Matching
   * retries return the original receipt while writer ownership holds; conflicting resolutions reject permanently.
   * @param settlement - Final resolution with exact market, event, condition, and token ownership.
   * @returns the detached durable payout receipt; absent positions and invalid payouts reject.
   */
  async settle(settlement: TokenSettlement): Promise<SettlementReceipt> {
    const request = structuredClone(settlement)
    const next = await this.table.update('paper', (current) => {
      this.assertWriter()
      const previous = current.settlements.find(receipt => receipt.settlement.tokenId === request.tokenId)
      if (previous !== undefined) {
        if (!isDeepStrictEqual(previous.settlement, request)) throw new Error('Paper token already has a different final settlement.')
        return current
      }
      const now = this.clock.now()
      if (request.resolvedAt > now || !Number.isSafeInteger(request.payoutPerShareMicros)
        || request.payoutPerShareMicros < 0 || request.payoutPerShareMicros > 1_000_000) {
        throw new Error('Paper settlement requires a final observed payout between zero and 1,000,000 micro dollars per share.')
      }
      const position = current.positions.find(item => item.tokenId === request.tokenId)
      if (position === undefined) throw new Error('Paper settlement has no open token position.')
      if (!sameOwner(position, request)) throw new Error('Paper resolution ownership does not match the position.')
      const payoutMicros = position.quantity * request.payoutPerShareMicros
      const cashMicros = current.cashMicros + payoutMicros
      const committedCostMicros = current.committedCostMicros - position.costMicros
      const profitMicros = payoutMicros - position.costMicros
      const realizedProfitMicros = current.realizedProfitMicros + profitMicros
      const equityMicros = cashMicros + committedCostMicros
      if (!Number.isSafeInteger(equityMicros) || !Number.isSafeInteger(realizedProfitMicros)) {
        throw new Error('Paper settlement exceeds safe-integer accounting.')
      }
      const peakEquityMicros = Math.max(current.peakEquityMicros, equityMicros)
      const sequence = current.sequence + 1
      const receipt: SettlementReceipt = {
        settlement: request, sequence, settledAt: now, quantity: position.quantity, costMicros: position.costMicros,
        payoutMicros, profitMicros, cashAfterMicros: cashMicros,
      }
      return withAudit({
        ...current, sequence, cashMicros, committedCostMicros, realizedProfitMicros, equityMicros, peakEquityMicros,
        drawdownMicros: peakEquityMicros - equityMicros,
        positions: current.positions.filter(item => item.tokenId !== request.tokenId),
        settlements: [...current.settlements, receipt],
      }, { kind: 'settlement', sequence, at: now, tokenId: request.tokenId })
    })
    return structuredClone(next.settlements.find(receipt => receipt.settlement.tokenId === request.tokenId) as SettlementReceipt)
  }

  /**
   * Reject new writes and await all already-queued durable operations before release.
   * @returns resolution when the domain is closed; repeated calls share teardown.
   */
  close(): Promise<void> {
    return this.domain.close()
  }
}

function requireRevision(state: LedgerState, expected: number): void {
  if (expected !== state.controlRevision) throw new Error('Paper control revision is stale; read the current account before retrying.')
}

function withAudit(state: LedgerState, entry: LedgerAuditEntry): LedgerState {
  return { ...state, audit: [...state.audit, entry].slice(-state.config.maxAuditEntries) }
}
