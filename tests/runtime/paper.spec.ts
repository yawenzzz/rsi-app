/** Paper execution preserves first-forecast purchase identity while using current research and prices. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryStorageBackend } from './helpers/memory-backend.ts'
import { DecisionJournal } from '../../src/runtime/decision/journal.ts'
import { PaperLedger } from '../../src/runtime/execution/ledger.ts'
import { executePaperForecasts } from '../../src/runtime/execution/paper.ts'
import type { PaperExecutionOptions } from '../../src/runtime/execution/paper.ts'
import { candidateVersion } from '../../src/runtime/strategy/experiment-schema.ts'
import type { ResearchObservationId } from '../../src/runtime/strategy/experiment-schema.ts'
import type { Candidate, ForecastRevision, PrimaryForecast } from '../../src/runtime/strategy/experiment-types.ts'
import type { Observation } from '../../src/runtime/runtime-state.ts'
import { observation } from './fixtures/observations.ts'

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  try {
    for (const dispose of disposers.splice(0).reverse()) await dispose()
  } finally {
    vi.restoreAllMocks()
  }
})

async function harness() {
  const now = 100_000
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const ctx = new Context()
  const backend = new MemoryStorageBackend()
  const facility = new DomainFacility(ctx, { backend: 'memory' })
  disposers.push(async () => { await facility.closeAll(); await backend.close(); await ctx.fiber.dispose() })
  await ctx.plugin(Storage)
  ctx.effect(() => ctx.storage.backend.register('memory', backend))
  ctx.effect(() => ctx.storage.mount('domain', facility))
  const open = backend.kv.open.bind(backend.kv)
  let beforeWrite: (() => Promise<void>) | undefined
  backend.kv.open = async (descriptor) => {
    const unit = await open(descriptor)
    const put = unit.putRecord.bind(unit)
    unit.putRecord = async (table, key, value) => {
      const block = beforeWrite
      beforeWrite = undefined
      await block?.()
      await put(table, key, value)
    }
    return unit
  }
  const ledger = await PaperLedger.open(facility, {
    initialCapitalMicros: 100_000_000, perEventLimitMicros: 10_000_000,
    totalExposureLimitMicros: 20_000_000, maxDrawdownMicros: 30_000_000, maxAuditEntries: 5,
  })
  await ledger.control({ expectedRevision: 0, action: 'resume', reason: 'Paper execution fixture' })
  const journal = await DecisionJournal.open(facility, 10, () => {})
  const evidence = new Map<string, Observation>()
  const primaryObservation = observation('event', now - 60_000, 0.25)
  const current = observation('event', now, 0.25)
  evidence.set(primaryObservation.id, primaryObservation)
  evidence.set(current.id, current)
  const policy = { name: 'Prospective fixture', thesis: 'Synthetic evidence', minEdge: 0.05, kellyFraction: 0.1 }
  const candidate: Candidate = { ...policy, id: candidateVersion(policy), registeredAt: 0 }
  const primaryForecast: PrimaryForecast = {
    candidateId: candidate.id, probability: 0.8, uncertainty: 0.05, evidence: [], receivedAt: primaryObservation.book.observedAt,
    observation: { observationId: brandString<ResearchObservationId>(primaryObservation.id), observedAt: primaryObservation.book.observedAt,
      eventId: primaryObservation.market.eventId, marketId: primaryObservation.market.id, tokenId: primaryObservation.book.tokenId,
      eventEndsAt: Date.parse(primaryObservation.market.endDate), costMicros: primaryObservation.averageCostMicros,
      baselineProbability: primaryObservation.baselineProbability },
  }
  const options: PaperExecutionOptions = {
    config: { maxObservationAgeMs: 1000, maxForecastAgeMs: 120_000, paperExecutionDelayMs: 0, paperSlippageBps: 0 },
    ledger, journal,
    data: { book: async () => current.book, feeParameters: async () => current.fees },
    observation: (id) => {
      const value = evidence.get(id)
      if (value === undefined) throw new Error('Unknown fixture observation')
      return value
    },
    retainObservation: async (value) => { evidence.set(value.id, value) },
    isCurrent: () => true,
    assertOpen: () => {},
  }
  return { now, options, current, candidate, primaryForecast, evidence,
    blockNextWrite: () => {
      const entered = Promise.withResolvers<undefined>()
      const released = Promise.withResolvers<undefined>()
      beforeWrite = async () => { entered.resolve(undefined); await released.promise }
      return { entered: entered.promise, release: () => { released.resolve(undefined) } }
    } }
}

describe('paper research execution', () => {
  it('refreshes prices for a prediction older than the quote lifetime', async () => {
    const fixture = await harness()
    await executePaperForecasts(fixture.options, [{ candidate: fixture.candidate, forecast: fixture.primaryForecast,
      primaryForecast: fixture.primaryForecast, market: fixture.current.market }], new AbortController().signal)
    const receipt = fixture.options.ledger.view().trades[0]
    expect(receipt).toMatchObject({ intent: { validUntil: fixture.now + 1000,
      assessment: { forecastReceivedAt: fixture.now - 60_000 } } })
    expect(fixture.evidence.get(receipt!.intent.evidenceRef)?.book.observedAt).toBe(fixture.now)
  })

  it('uses the latest forecast and buys at most once across subsequent revisions', async () => {
    const fixture = await harness()
    const latest: ForecastRevision = { ...fixture.primaryForecast, revision: 1, probability: 0.9, receivedAt: fixture.now,
      observation: { ...fixture.primaryForecast.observation,
        observationId: brandString<ResearchObservationId>(fixture.current.id), observedAt: fixture.now } }
    const attempt = { candidate: fixture.candidate, forecast: latest,
      primaryForecast: fixture.primaryForecast, market: fixture.current.market }
    await executePaperForecasts(fixture.options, [attempt], new AbortController().signal)
    const first = fixture.options.ledger.view()
    expect(first.trades[0]?.intent.assessment).toMatchObject({ probability: 0.9, forecastObservationId: fixture.current.id })
    const next = observation('event', fixture.now + 10, 0.25)
    fixture.evidence.set(next.id, next)
    vi.mocked(Date.now).mockReturnValue(fixture.now + 10)
    fixture.options.data = { book: async () => next.book, feeParameters: async () => next.fees }
    await executePaperForecasts(fixture.options, [{ ...attempt, market: next.market, forecast: {
      ...latest, revision: 2, probability: 0.95, receivedAt: fixture.now + 10,
      observation: { ...latest.observation, observationId: brandString<ResearchObservationId>(next.id), observedAt: fixture.now + 10 },
    } }], new AbortController().signal)
    expect(fixture.options.ledger.view()).toEqual(first)
  })

  it('refuses an expired prediction even when the current quote is fresh', async () => {
    const fixture = await harness()
    fixture.options.config.maxForecastAgeMs = 59_999
    await executePaperForecasts(fixture.options, [{ candidate: fixture.candidate, forecast: fixture.primaryForecast,
      primaryForecast: fixture.primaryForecast, market: fixture.current.market }], new AbortController().signal)
    expect(fixture.options.ledger.view().trades).toEqual([])
  })

  it('retains rejected forecast revisions separately while deduplicating retries of the same revision', async () => {
    const fixture = await harness()
    const primary = { ...fixture.primaryForecast, probability: 0.3, receivedAt: fixture.now }
    const attempt = { candidate: fixture.candidate, forecast: primary,
      primaryForecast: primary, market: fixture.current.market }
    const signal = new AbortController().signal
    await executePaperForecasts(fixture.options, [attempt], signal)
    await executePaperForecasts(fixture.options, [attempt], signal)
    const first = fixture.options.journal.view()
    expect(first).toHaveLength(1)
    const revision: ForecastRevision = { ...primary, revision: 1,
      evidence: [{ url: 'https://fixture.test/revision', text: 'Additional evidence preserves the probability estimate.' }] }
    await executePaperForecasts(fixture.options, [{ ...attempt, forecast: revision }], signal)
    await executePaperForecasts(fixture.options, [{ ...attempt, forecast: revision }], signal)
    const retained = fixture.options.journal.view()
    expect(retained).toHaveLength(2)
    expect(retained[0]).toEqual(first[0])
    expect(retained.map(entry => entry.assessment?.forecastRevision)).toEqual([0, 1])
    expect(retained[1]?.assessment?.sizing).toEqual(retained[0]?.assessment?.sizing)
    expect(fixture.options.ledger.view().trades).toEqual([])
  })

  it.each(['quote', 'evidence'] as const)('discards a prediction replaced while its %s operation is in flight', async (operation) => {
    const fixture = await harness()
    const entered = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    let current = true
    fixture.options.isCurrent = () => current
    if (operation === 'quote') {
      fixture.options.data.book = async () => {
        entered.resolve(undefined)
        await released.promise
        return fixture.current.book
      }
    } else {
      const retain = fixture.options.retainObservation.bind(fixture.options)
      fixture.options.retainObservation = async (value) => {
        await retain(value)
        entered.resolve(undefined)
        await released.promise
      }
    }
    const execution = executePaperForecasts(fixture.options, [{ candidate: fixture.candidate, forecast: fixture.primaryForecast,
      primaryForecast: fixture.primaryForecast, market: fixture.current.market }], new AbortController().signal)
    try {
      await entered.promise
      current = false
    } finally { released.resolve(undefined) }
    await execution
    expect(fixture.options.ledger.view()).toMatchObject({ trades: [], cashMicros: 100_000_000 })
  })

  it('rechecks the selected prediction inside the queued ledger mutation', async () => {
    const fixture = await harness()
    let current = true
    fixture.options.isCurrent = () => current
    const blocked = fixture.blockNextWrite()
    const control = fixture.options.ledger.control({ expectedRevision: 1, action: 'resume', reason: 'Queued control fixture' })
    const queued = Promise.withResolvers<undefined>()
    const execute = fixture.options.ledger.execute.bind(fixture.options.ledger)
    vi.spyOn(fixture.options.ledger, 'execute').mockImplementation((intent, check) => {
      const pending = execute(intent, check)
      queued.resolve(undefined)
      return pending
    })
    let execution: Promise<unknown> | undefined
    try {
      await blocked.entered
      execution = executePaperForecasts(fixture.options, [{ candidate: fixture.candidate, forecast: fixture.primaryForecast,
        primaryForecast: fixture.primaryForecast, market: fixture.current.market }], new AbortController().signal)
        .then(() => null, (error: unknown) => error)
      await queued.promise
      current = false
    } finally { blocked.release() }
    await control
    await expect(execution).resolves.toMatchObject({ message: 'Forecast was replaced before paper execution' })
    expect(fixture.options.ledger.view()).toMatchObject({ trades: [], cashMicros: 100_000_000 })
  })

  it('preserves the prediction deadline when current market metadata extends it', async () => {
    const fixture = await harness()
    const primary = { ...fixture.primaryForecast,
      observation: { ...fixture.primaryForecast.observation, eventEndsAt: fixture.now + 50 } }
    await executePaperForecasts(fixture.options, [{ candidate: fixture.candidate, forecast: primary,
      primaryForecast: primary, market: fixture.current.market }], new AbortController().signal)
    expect(fixture.options.ledger.view().trades[0]?.intent.validUntil).toBe(fixture.now + 50)
  })
})
