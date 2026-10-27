import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import {
  MemoryMediaPool, MemoryStorageBackend,
} from './helpers/memory-backend.ts'
import { PaperLedger } from '../../src/runtime/execution/ledger.ts'
import { ledgerConfigSchema, ledgerStateSchema } from '../../src/runtime/execution/ledger-schema.ts'
import { sizePurchase } from '../../src/runtime/trading/sizing.ts'
import type { TradeAssessment } from '../../src/runtime/trading/types.ts'
import { observation } from './fixtures/observations.ts'
import type { ConditionId, EventId, MarketId, TokenId } from '../../src/runtime/data/market.ts'
import type {
  EvidenceRef, LedgerConfig, LedgerState, ResolutionRef, StrategyVersion, TokenSettlement,
  TradeIntent, TradeIntentId,
} from '../../src/runtime/execution/ledger-types.ts'

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})

const config: LedgerConfig = {
  initialCapitalMicros: 100_000_000,
  perEventLimitMicros: 10_000_000,
  totalExposureLimitMicros: 20_000_000,
  maxDrawdownMicros: 30_000_000,
  maxAuditEntries: 5,
}

function intent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return {
    id: brandString<TradeIntentId>('purchase-1'), controlRevision: 1,
    strategyVersion: brandString<StrategyVersion>('candidate-1'), evidenceRef: brandString<EvidenceRef>('observation-1'),
    marketId: brandString<MarketId>('market-1'), eventId: brandString<EventId>('event-1'),
    conditionId: brandString<ConditionId>('condition-1'), tokenId: brandString<TokenId>('token-1'),
    quantity: 10, costMicros: 4_000_000, observedAt: 900, validUntil: 1100,
    ...overrides,
  }
}

function resolution(overrides: Partial<TokenSettlement> = {}): TokenSettlement {
  return {
    resolutionRef: brandString<ResolutionRef>('resolution-1'), marketId: brandString<MarketId>('market-1'),
    eventId: brandString<EventId>('event-1'), conditionId: brandString<ConditionId>('condition-1'),
    tokenId: brandString<TokenId>('token-1'), final: true, payoutPerShareMicros: 1_000_000, resolvedAt: 950,
    ...overrides,
  }
}

async function harness(options: { pool?: MemoryMediaPool; config?: LedgerConfig; start?: boolean; assertWriter?: () => void } = {}) {
  const ctx = new Context()
  const backend = new MemoryStorageBackend(options.pool)
  const facility = new DomainFacility(ctx, { backend: 'memory' })
  disposers.push(async () => { await facility.closeAll(); await backend.close(); await ctx.fiber.dispose() })
  await ctx.plugin(Storage)
  ctx.effect(() => ctx.storage.backend.register('memory', backend))
  ctx.effect(() => ctx.storage.mount('domain', facility))
  const originalOpen = backend.kv.open.bind(backend.kv)
  let nextWrite: (() => Promise<void>) | undefined
  let writeCount = 0
  backend.kv.open = async (descriptor) => {
    const unit = await originalOpen(descriptor)
    const originalPut = unit.putRecord.bind(unit)
    unit.putRecord = async (table, key, value) => {
      const beforeWrite = nextWrite
      nextWrite = undefined
      await beforeWrite?.()
      await originalPut(table, key, value)
      writeCount += 1
    }
    return unit
  }
  const clock = { value: 1000, now() { return this.value } }
  const ledger = await PaperLedger.open(facility, options.config ?? config, clock, options.assertWriter)
  if (options.start !== false) await ledger.control({ expectedRevision: 0, action: 'resume', reason: 'Begin paper research.' })
  return {
    ledger, facility, pool: backend.pool, clock,
    writeCount: () => writeCount,
    blockNextWrite: () => {
      const entered = Promise.withResolvers<undefined>()
      const released = Promise.withResolvers<undefined>()
      nextWrite = async () => { entered.resolve(undefined); await released.promise }
      return { entered: entered.promise, release: () => { released.resolve(undefined) } }
    },
  }
}

function replaceStored(pool: MemoryMediaPool, value: unknown, key = 'paper'): void {
  pool.media.get('rsi_paper')!.tables.get('account')!.set(key, value)
}

function purchaseAssessment(state: LedgerState): TradeAssessment {
  return {
    algorithm: 'fractional-kelly-v1', at: 1000, accountSequence: state.sequence, equityMicros: state.equityMicros,
    forecastObservationId: brandString<TradeAssessment['forecastObservationId']>('original-forecast-observation'), forecastReceivedAt: 900,
    probability: 0.875, uncertainty: 0.125, minEdge: 0.05, kellyFraction: 0.25,
    sizing: sizePurchase({ minEdge: 0.05, kellyFraction: 0.25 }, { probability: 0.875, uncertainty: 0.125 },
      observation('token-1', 900, 0.5), state, true, true),
  }
}

describe('PaperLedger durable account', () => {
  it('preserves durable idempotent retries when entry evidence is explicitly undefined', async () => {
    const first = await harness()
    const request = intent({ assessment: undefined })
    const receipt = await first.ledger.execute(request)
    await first.ledger.close()
    const second = await harness({ pool: first.pool, start: false })
    expect(await second.ledger.execute(request)).toEqual(receipt)
    expect(second.ledger.view().trades).toHaveLength(1)
  })

  it('commits entry mathematics in the same durable record as the debit and retains it on reopen', async () => {
    const first = await harness()
    const assessment = purchaseAssessment(first.ledger.view())
    const request = intent({ assessment, quantity: assessment.sizing.quantity, costMicros: assessment.sizing.quote!.totalCostMicros })
    const original = structuredClone(assessment)
    const receipt = await first.ledger.execute(request)
    expect(receipt.intent.assessment).toEqual(original)
    assessment.probability = 0
    expect(first.ledger.view().trades[0]?.intent.assessment).toEqual(original)
    await first.ledger.close()
    const second = await harness({ pool: first.pool, start: false })
    expect(second.ledger.view().trades[0]?.intent.assessment).toEqual(original)
    expect(second.ledger.view().cashMicros).toBe(config.initialCapitalMicros - receipt.intent.costMicros)
  })

  it('refuses a stored assessment that claims an account sequence after its financial receipt', async () => {
    const fixture = await harness()
    const assessment = purchaseAssessment(fixture.ledger.view())
    await fixture.ledger.execute(intent({
      assessment, quantity: assessment.sizing.quantity, costMicros: assessment.sizing.quote!.totalCostMicros,
    }))
    const damaged = fixture.ledger.view()
    damaged.trades[0]!.intent.assessment!.accountSequence = damaged.sequence
    await fixture.ledger.close()
    replaceStored(fixture.pool, damaged)
    await expect(harness({ pool: fixture.pool, start: false })).rejects.toThrow()
  })

  it.each(['cost', 'quantity', 'rejected', 'sequence', 'future', 'components', 'checks', 'quote-quantity',
    'fraction', 'budget', 'forecast-time', 'probability', 'no-quote'] as const)(
    'rejects a conflicting %s assessment before publishing a purchase', async (kind) => {
      const { ledger } = await harness()
      const before = ledger.view()
      const assessment = purchaseAssessment(before)
      const request = intent({ assessment, quantity: assessment.sizing.quantity, costMicros: assessment.sizing.quote!.totalCostMicros })
      if (kind === 'cost') request.costMicros--
      if (kind === 'quantity') request.quantity--
      if (kind === 'rejected') assessment.sizing.checks[0]!.passed = false
      if (kind === 'sequence') assessment.accountSequence = 100
      if (kind === 'future') assessment.at = 1100
      if (kind === 'components') assessment.sizing.quote!.feeMicros++
      if (kind === 'checks') assessment.sizing.checks[0] = assessment.sizing.checks[1]!
      if (kind === 'quote-quantity') assessment.sizing.quantity--
      if (kind === 'fraction') assessment.sizing.fractionalKelly += 0.01
      if (kind === 'budget') assessment.sizing.budgetMicros = assessment.equityMicros
      if (kind === 'forecast-time') assessment.forecastReceivedAt = assessment.at + 1
      if (kind === 'probability') assessment.probability = 0.5
      if (kind === 'no-quote') assessment.sizing.quote = null
      await expect(ledger.execute(request)).rejects.toThrow()
      expect(ledger.view()).toEqual(before)
    },
  )

  it('rejects first account creation after losing the writer', async () => {
    const pool = new MemoryMediaPool()
    await expect(harness({
      pool, start: false, assertWriter: () => { throw new Error('writer lost') },
    }).then(() => undefined)).rejects.toThrow('writer lost')
    expect(pool.media.get('rsi_paper')!.tables.has('account')).toBe(false)
    const { ledger } = await harness({ pool, start: false })
    expect(ledger.view().sequence).toBe(0)
  })

  it.each(['execute', 'control', 'settle', 'execute-retry', 'settle-retry'] as const)(
    'rejects queued %s after losing the writer without touching the account',
    async (operation) => {
      let ownsWriter = true
      const { ledger, pool, blockNextWrite, writeCount } = await harness({
        assertWriter: () => { if (!ownsWriter) throw new Error('writer lost') },
      })
      await ledger.execute(intent())
      if (operation === 'settle-retry') await ledger.settle(resolution())
      const barrier = blockNextWrite()
      const earlier = ledger.control({ expectedRevision: 1, action: 'resume', reason: 'Authorized before writer loss.' })
      await barrier.entered
      const committedWrites = writeCount()
      const queued = {
        control: () => ledger.control({ expectedRevision: 2, action: 'pause', reason: 'Queued control.' }),
        execute: () => ledger.execute(intent({ id: brandString<TradeIntentId>('queued'), controlRevision: 2 })),
        'execute-retry': () => ledger.execute(intent()),
        settle: () => ledger.settle(resolution()),
        'settle-retry': () => ledger.settle(resolution()),
      }[operation]()
      const rejected = expect(queued).rejects.toThrow('writer lost')
      ownsWriter = false
      barrier.release()
      const accepted = await earlier
      await rejected
      expect(writeCount()).toBe(committedWrites + 1)
      expect(ledger.view()).toEqual(accepted)
      expect(pool.media.get('rsi_paper')!.tables.get('account')!.get('paper')).toEqual(accepted)
    },
  )

  it('creates a paused account and returns detached values', async () => {
    const { ledger } = await harness({ start: false })
    const view = ledger.view()
    expect(view).toMatchObject({ status: 'paused', controlRevision: 0, cashMicros: 100_000_000, mode: 'paper' })
    view.cashMicros = 0
    view.config.initialCapitalMicros = 1
    await expect(ledger.execute(intent({ controlRevision: 0 }))).rejects.toThrow('paused')
    expect(ledger.view().cashMicros).toBe(100_000_000)
    expect(ledgerStateSchema.safeParse(ledger.view()).success).toBe(true)
  })

  it('restores cash, purchases, controls, and exactly-once receipts from a real JSON backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-paper-ledger-'))
    disposers.push(() => rm(root, { recursive: true, force: true }))
    const ctx = new Context()
    const backend = new JsonStorageBackend(root)
    const facility = new DomainFacility(ctx, { backend: 'json' })
    disposers.push(async () => { await facility.closeAll(); await backend.close(); await ctx.fiber.dispose() })
    await ctx.plugin(Storage)
    ctx.effect(() => ctx.storage.backend.register('json', backend))
    ctx.effect(() => ctx.storage.mount('domain', facility))
    const ledger = await PaperLedger.open(facility, config, { now: () => 1000 })
    await ledger.control({ expectedRevision: 0, action: 'resume', reason: 'Begin paper research.' })
    const receipt = await ledger.execute(intent())
    await ledger.control({ expectedRevision: 1, action: 'pause', reason: 'Retain pause across restart.' })
    const before = ledger.view()
    await ledger.close()
    await expect(PaperLedger.open(facility, { ...config, initialCapitalMicros: 200_000_000 }))
      .rejects.toThrow('original allocation')
    const reopened = await PaperLedger.open(facility, config, { now: () => 5000 })
    expect(reopened.view()).toEqual(before)
    expect(await reopened.execute(intent())).toEqual(receipt)
    expect(reopened.view().cashMicros).toBe(96_000_000)
    await expect(reopened.execute(intent({ id: brandString<TradeIntentId>('next'), controlRevision: 2 })))
      .rejects.toThrow('paused')
  })

  it('retries simultaneous identical intents without a second debit and rejects changed payloads', async () => {
    const { ledger } = await harness()
    const receipts = await Promise.all([ledger.execute(intent()), ledger.execute(intent())])
    expect(receipts[0]).toEqual(receipts[1])
    receipts[0].intent.costMicros = 1
    expect(ledger.view().trades[0]!.intent.costMicros).toBe(4_000_000)
    await expect(ledger.execute(intent({ quantity: 11 }))).rejects.toThrow('different purchase')
    expect(ledger.view()).toMatchObject({ cashMicros: 96_000_000, committedCostMicros: 4_000_000, equityMicros: 100_000_000 })
    expect(ledger.view().trades).toHaveLength(1)
  })

  it('commits pause ahead of an overlapping purchase and rejects stale resume', async () => {
    const { ledger, blockNextWrite } = await harness()
    const barrier = blockNextWrite()
    const pausing = ledger.control({ expectedRevision: 1, action: 'pause', reason: 'Stop new exposure.' })
    await barrier.entered
    const purchasing = ledger.execute(intent()).catch((error: unknown) => error)
    expect(ledger.view().status).toBe('running')
    barrier.release()
    await pausing
    expect(await purchasing).toMatchObject({ message: 'Paper control revision is stale; read the current account before retrying.' })
    await expect(ledger.control({ expectedRevision: 1, action: 'resume', reason: 'Old request.' })).rejects.toThrow('stale')
    expect(ledger.view()).toMatchObject({ status: 'paused', cashMicros: 100_000_000, controlRevision: 2 })
  })

  it('retains an earlier purchase when a later pause is queued, then drains it on close', async () => {
    const { ledger, blockNextWrite } = await harness()
    const barrier = blockNextWrite()
    const purchasing = ledger.execute(intent())
    await barrier.entered
    const pausing = ledger.control({ expectedRevision: 1, action: 'pause', reason: 'Stop.' })
    const closing = ledger.close()
    const rejected = ledger.execute(intent({ id: brandString<TradeIntentId>('after-close') })).catch((error: unknown) => error)
    barrier.release()
    await purchasing
    expect(await pausing).toMatchObject({ status: 'paused', cashMicros: 96_000_000 })
    await closing
    await ledger.close()
    expect(await rejected).toMatchObject({ code: 'closed' })
    expect(() => ledger.view()).toThrow('closed')
  })

  it('checks expiry in the write queue and captures the proposal before caller mutation', async () => {
    const { ledger, blockNextWrite, clock } = await harness()
    const barrier = blockNextWrite()
    const first = ledger.execute(intent())
    await barrier.entered
    const proposal = intent({ id: brandString<TradeIntentId>('queued') })
    const queued = ledger.execute(proposal).catch((error: unknown) => error)
    proposal.validUntil = 10_000
    clock.value = 1100
    barrier.release()
    await first
    expect(await queued).toMatchObject({ message: 'Paper purchase observation is future-dated or expired.' })
    expect(ledger.view().trades).toHaveLength(1)
  })

  it('keeps memory and durable cash unchanged after failed control, purchase, or settlement writes', async () => {
    const { ledger, facility, pool } = await harness()
    for (const operation of [
      () => ledger.control({ expectedRevision: 1, action: 'pause', reason: 'Cannot persist.' }),
      () => ledger.execute(intent()),
    ]) {
      const before = ledger.view()
      pool.failNextWrites = 1
      await expect(operation()).rejects.toThrow('injected write failure')
      expect(ledger.view()).toEqual(before)
    }
    await ledger.execute(intent())
    const beforeSettlement = ledger.view()
    pool.failNextWrites = 1
    await expect(ledger.settle(resolution())).rejects.toThrow('injected write failure')
    expect(ledger.view()).toEqual(beforeSettlement)
    await ledger.close()
    const reopened = await PaperLedger.open(facility, config, { now: () => 1000 })
    expect(reopened.view()).toEqual(beforeSettlement)
    await reopened.settle(resolution())
    expect(reopened.view().cashMicros).toBe(106_000_000)
  })
})

describe('PaperLedger risk and final payouts', () => {
  it('aggregates purchases per event and across the account', async () => {
    const { ledger } = await harness()
    await ledger.execute(intent({ costMicros: 6_000_000 }))
    await ledger.execute(intent({ id: brandString<TradeIntentId>('second'), tokenId: brandString<TokenId>('token-2') }))
    await expect(ledger.execute(intent({ id: brandString<TradeIntentId>('third'), costMicros: 1 }))).rejects.toThrow('event exposure')
    await ledger.execute(intent({
      id: brandString<TradeIntentId>('other-event'), eventId: brandString<EventId>('event-2'),
      tokenId: brandString<TokenId>('token-3'), costMicros: 10_000_000,
    }))
    await expect(ledger.execute(intent({
      id: brandString<TradeIntentId>('over-total'), eventId: brandString<EventId>('event-3'),
      tokenId: brandString<TokenId>('token-4'), costMicros: 1,
    }))).rejects.toThrow('account exposure')
    expect(ledger.view().committedCostMicros).toBe(20_000_000)
  })

  it('requires exact token ownership and safe positive accounting units', async () => {
    const { ledger } = await harness()
    await ledger.execute(intent())
    await expect(ledger.execute(intent({ id: brandString<TradeIntentId>('wrong'), marketId: brandString<MarketId>('other') })))
      .rejects.toThrow('ownership')
    for (const overrides of [
      { quantity: 0 }, { quantity: 0.5 }, { quantity: Number.MAX_SAFE_INTEGER },
      { costMicros: 0 }, { costMicros: 0.1 }, { observedAt: 2000 },
    ]) {
      await expect(ledger.execute(intent({ id: brandString<TradeIntentId>('invalid'), ...overrides }))).rejects.toThrow()
    }
    await ledger.execute(intent({ id: brandString<TradeIntentId>('more') }))
    expect(ledger.view().positions).toEqual([expect.objectContaining({ quantity: 20, costMicros: 8_000_000 })])
    await ledger.execute(intent({
      id: brandString<TradeIntentId>('other-token'), tokenId: brandString<TokenId>('token-2'), costMicros: 1_000_000,
    }))
    await ledger.execute(intent({ id: brandString<TradeIntentId>('last'), costMicros: 1_000_000 }))
    expect(ledger.view().positions.map(position => position.costMicros)).toEqual([9_000_000, 1_000_000])
  })

  it('never spends above cash even with sufficient configured exposure', async () => {
    const largeLimits = {
      ...config, perEventLimitMicros: 100_000_000, totalExposureLimitMicros: 100_000_000, maxDrawdownMicros: 100_000_000,
    }
    const { ledger } = await harness({ config: largeLimits })
    await ledger.execute(intent({ costMicros: 60_000_000 }))
    await ledger.settle(resolution({ payoutPerShareMicros: 0 }))
    await expect(ledger.execute(intent({
      id: brandString<TradeIntentId>('after-loss'), tokenId: brandString<TokenId>('token-2'), costMicros: 50_000_000,
    }))).rejects.toThrow('available cash')
  })

  it('rejects aggregate share and settlement overflow without changing the account', async () => {
    const { ledger } = await harness()
    const quantity = Math.floor(Number.MAX_SAFE_INTEGER / 1_000_000)
    await ledger.execute(intent({ quantity, costMicros: 1 }))
    const before = ledger.view()
    await expect(ledger.execute(intent({ id: brandString<TradeIntentId>('overflow'), quantity: 1, costMicros: 1 })))
      .rejects.toThrow('share count')
    await expect(ledger.settle(resolution())).rejects.toThrow('safe-integer accounting')
    expect(ledger.view()).toEqual(before)
  })

  it('reserves remaining drawdown against open losses and preserves the peak after settlement', async () => {
    const { ledger } = await harness({ config: { ...config, maxDrawdownMicros: 5_000_000 } })
    await ledger.execute(intent())
    await expect(ledger.execute(intent({ id: brandString<TradeIntentId>('too-much'), costMicros: 2_000_000 })))
      .rejects.toThrow('drawdown budget')
    await ledger.settle(resolution())
    expect(ledger.view()).toMatchObject({ equityMicros: 106_000_000, peakEquityMicros: 106_000_000, drawdownMicros: 0 })
    await ledger.execute(intent({
      id: brandString<TradeIntentId>('loss'), tokenId: brandString<TokenId>('token-2'), costMicros: 5_000_000,
    }))
    await ledger.settle(resolution({ tokenId: brandString<TokenId>('token-2'), payoutPerShareMicros: 0 }))
    expect(ledger.view()).toMatchObject({ equityMicros: 101_000_000, peakEquityMicros: 106_000_000, drawdownMicros: 5_000_000 })
    await ledger.control({ expectedRevision: 1, action: 'pause', reason: 'Drawdown reached.' })
    await expect(ledger.control({ expectedRevision: 2, action: 'resume', reason: 'Try again.' })).rejects.toThrow('drawdown limit')
    expect(ledgerStateSchema.safeParse(ledger.view()).success).toBe(true)
  })

  it('settles split payouts exactly once while paused and retains receipts beyond the recent audit', async () => {
    const { ledger, facility } = await harness({ config: { ...config, maxAuditEntries: 2 } })
    await ledger.execute(intent())
    await ledger.control({ expectedRevision: 1, action: 'pause', reason: 'Pause purchases only.' })
    const split = resolution({ payoutPerShareMicros: 500_000 })
    const [first, second] = await Promise.all([ledger.settle(split), ledger.settle(split)])
    expect(first).toEqual(second)
    expect(first).toMatchObject({ quantity: 10, costMicros: 4_000_000, payoutMicros: 5_000_000, profitMicros: 1_000_000 })
    first.settlement.payoutPerShareMicros = 0
    expect(ledger.view()).toMatchObject({ cashMicros: 101_000_000, committedCostMicros: 0, realizedProfitMicros: 1_000_000 })
    expect(ledger.view().audit).toHaveLength(2)
    expect(ledger.view().trades).toHaveLength(1)
    await expect(ledger.settle(resolution())).rejects.toThrow('different final settlement')
    await ledger.control({ expectedRevision: 2, action: 'resume', reason: 'Continue.' })
    await expect(ledger.execute(intent({ id: brandString<TradeIntentId>('after-resolution'), controlRevision: 3 })))
      .rejects.toThrow('already settled')
    const before = ledger.view()
    await ledger.close()
    const reopened = await PaperLedger.open(facility, { ...config, maxAuditEntries: 2 }, { now: () => 1000 })
    expect(reopened.view()).toEqual(before)
  })

  it('refuses missing positions, mismatched final resolutions, and invalid payout values', async () => {
    const { ledger } = await harness()
    await expect(ledger.settle(resolution())).rejects.toThrow('no open token position')
    await ledger.execute(intent())
    for (const overrides of [
      { marketId: brandString<MarketId>('wrong') }, { eventId: brandString<EventId>('wrong') },
      { conditionId: brandString<ConditionId>('wrong') },
    ]) await expect(ledger.settle(resolution(overrides))).rejects.toThrow('ownership')
    for (const overrides of [
      { payoutPerShareMicros: -1 }, { payoutPerShareMicros: 1_000_001 }, { payoutPerShareMicros: 0.5 }, { resolvedAt: 1001 },
    ]) {
      await expect(ledger.settle(resolution(overrides))).rejects.toThrow('final observed payout')
    }
    expect(ledger.view().settlements).toHaveLength(0)
  })
})

describe('PaperLedger stored-state validation', () => {
  it('reconstructs multiple positions and rejects inconsistent receipt order, ownership, risk, and audit', async () => {
    const { ledger } = await harness()
    await ledger.execute(intent())
    await ledger.execute(intent({ id: brandString<TradeIntentId>('second') }))
    await ledger.execute(intent({
      id: brandString<TradeIntentId>('third'), tokenId: brandString<TokenId>('token-2'), eventId: brandString<EventId>('event-2'),
    }))
    await ledger.settle(resolution())
    const original = ledger.view()
    expect(ledgerStateSchema.safeParse(original).success).toBe(true)
    const corruptions: ((state: LedgerState) => void)[] = [
      (state) => { state.trades[0]!.sequence = state.sequence + 1 },
      (state) => { state.trades[1]!.intent.id = state.trades[0]!.intent.id },
      (state) => { state.trades[1]!.intent.marketId = brandString<MarketId>('wrong') },
      (state) => {
        state.trades[0]!.intent.quantity = Math.floor(Number.MAX_SAFE_INTEGER / 1_000_000)
        state.trades[1]!.intent.quantity = 1
      },
      (state) => { state.config.maxDrawdownMicros = 1 },
      (state) => { state.config.perEventLimitMicros = 1 },
      (state) => { state.config.perEventLimitMicros = 6_000_000; state.config.totalExposureLimitMicros = 6_000_000 },
      (state) => { state.settlements[0]!.settlement.marketId = brandString<MarketId>('wrong') },
      (state) => { state.settlements[0]!.settledAt = state.settlements[0]!.settlement.resolvedAt - 1 },
      (state) => { state.settlements[0]!.cashAfterMicros += 1 },
      (state) => { state.audit[0]!.sequence += 1 },
      (state) => { state.audit[1] = { kind: 'trade', sequence: 2, at: 1000, intentId: brandString<TradeIntentId>('missing') } },
      (state) => { state.audit[4] = { kind: 'settlement', sequence: 5, at: 1000, tokenId: brandString<TokenId>('missing') } },
      (state) => { state.audit[0] = { kind: 'control', sequence: 1, at: 1000, action: 'resume', reason: 'Bad revision.', controlRevision: 2 } },
    ]
    for (const corrupt of corruptions) {
      const state = structuredClone(original)
      corrupt(state)
      expect(ledgerStateSchema.safeParse(state).success).toBe(false)
    }
  })

  it('rejects unbalanced and malformed account records without resetting capital', async () => {
    const { ledger, facility, pool } = await harness()
    await ledger.execute(intent())
    await ledger.settle(resolution())
    const original = ledger.view()
    await ledger.close()
    const corruptions: ((state: LedgerState) => unknown)[] = [
      state => ({ ...state, mode: 'live' }),
      state => ({ ...state, cashMicros: state.cashMicros + 1 }),
      state => ({ ...state, equityMicros: state.equityMicros + 1 }),
      state => ({ ...state, peakEquityMicros: state.peakEquityMicros + 1 }),
      state => ({ ...state, sequence: state.sequence + 1 }),
      state => ({ ...state, audit: [] }),
      state => ({ ...state, trades: [...state.trades, state.trades[0]] }),
      state => ({ ...state, settlements: [{ ...state.settlements[0], payoutMicros: 1 }] }),
      state => ({
        ...state, settlements: [{ ...state.settlements[0], settlement: { ...state.settlements[0]!.settlement, final: false } }],
      }),
      state => ({ ...state, positions: [{ ...intent(), quantity: 2 }] }),
    ]
    for (const corrupt of corruptions) {
      replaceStored(pool, corrupt(structuredClone(original)))
      await expect(PaperLedger.open(facility, config)).rejects.toMatchObject({ code: 'invalid-record' })
    }
    replaceStored(pool, original)
    const reopened = await PaperLedger.open(facility, config)
    expect(reopened.view().cashMicros).toBe(106_000_000)
  })

  it('rejects unexpected singleton keys and releases failed initialization for retry', async () => {
    const { ledger, facility, pool } = await harness()
    const original = ledger.view()
    await ledger.close()
    replaceStored(pool, original, 'other')
    await expect(PaperLedger.open(facility, config)).rejects.toThrow('unexpected records')
    const records = pool.media.get('rsi_paper')!.tables.get('account')!
    records.clear()
    pool.failNextWrites = 1
    await expect(PaperLedger.open(facility, config)).rejects.toThrow('injected write failure')
    expect(records.size).toBe(0)
    const reopened = await PaperLedger.open(facility, config)
    expect(reopened.view().status).toBe('paused')
  })

  it('validates allocation ranges at the configuration parser', () => {
    expect(ledgerConfigSchema.safeParse(config).success).toBe(true)
    for (const overrides of [
      { initialCapitalMicros: 0 }, { maxAuditEntries: 0 }, { perEventLimitMicros: 30_000_000 },
      { totalExposureLimitMicros: 200_000_000 }, { maxDrawdownMicros: 200_000_000 },
    ]) expect(ledgerConfigSchema.safeParse({ ...config, ...overrides }).success).toBe(false)
  })
})
