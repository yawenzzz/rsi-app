/** Durable orchestration with synthetic prospective outcomes and isolated public-data transport. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { resolveConfig } from '../../src/runtime/config.ts'
import { MarketDataClient } from '../../src/runtime/data/market.ts'
import type { TokenId } from '../../src/runtime/data/market.ts'
import { quotePurchase } from '../../src/runtime/execution/quotes.ts'
import { RsiRuntime } from '../../src/runtime/runtime.ts'
import { createObservation, observationSchema, runtimeStateSchema } from '../../src/runtime/runtime-state.ts'
import { runtimeDomain } from '../../src/runtime/runtime-state.ts'
import type { ResearchDriver } from '../../src/runtime/runtime.ts'
import type { Candidate } from '../../src/runtime/strategy/experiment-types.ts'
import type { Observation, RuntimeState } from '../../src/runtime/runtime-state.ts'
import { queryOverview } from '../../src/runtime/queries/overview.ts'
import { queryOpportunities, queryOpportunity } from '../../src/runtime/queries/opportunities.ts'
import { queryRisk, queryPosition } from '../../src/runtime/queries/portfolio.ts'
import { queryStrategies, queryStrategy } from '../../src/runtime/queries/strategies.ts'
import { queryDecisions, queryDecision } from '../../src/runtime/queries/decisions.ts'
import type { DecisionId, OpportunityQuery } from '../../src/runtime/queries/types.ts'
import type { TradeIntentId } from '../../src/runtime/execution/ledger-types.ts'
import { observeHealth } from '../../src/runtime/runtime/health.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  try {
    for (const dispose of cleanups.splice(0).reverse()) await dispose()
  } finally {
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})

async function engine(options: {
  researchDriver?: ResearchDriver
  maxAge?: number
  maxForecastAge?: number
  maxObservations?: number
  maxDecisionRecords?: number
  statusLimit?: number
  autoTick?: boolean
  researchEnabled?: boolean
  maxRunsPerDay?: number
  researchIntervalMs?: number
  paperExecutionDelayMs?: number
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-engine-'))
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  let now = 1_800_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const endDate = new Date(now + 86_400_000).toISOString()
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const config = resolveConfig({
    objective: 'Synthetic prospective paper execution fixture', autoTick: options.autoTick ?? false, tickIntervalMs: 100,
    writerLeasePath: join(root, 'writer-lease'),
    maxObservationAgeMs: options.maxAge ?? 60_000, paperExecutionDelayMs: options.paperExecutionDelayMs ?? 1, paperSlippageBps: 0,
    maxForecastAgeMs: options.maxForecastAge ?? 3_600_000,
    maxObservations: options.maxObservations ?? 2000, statusLimit: options.statusLimit ?? 100,
    maxDecisionRecords: options.maxDecisionRecords ?? 50_000,
    data: { gammaUrl: 'https://gamma.engine.test', clobUrl: 'https://clob.engine.test', maxMarkets: 100 },
    ledger: {
      initialCapitalMicros: 100_000_000, perEventLimitMicros: 1_000_000,
      totalExposureLimitMicros: 5_000_000, maxDrawdownMicros: 2_000_000,
    },
    experiments: { maxCandidates: 2, minResolvedEvents: 30 },
    research: {
      enabled: options.researchEnabled ?? options.researchDriver !== undefined, cwd: root,
      maxRunsPerDay: options.maxRunsPerDay ?? 1, intervalMs: options.researchIntervalMs ?? 1,
    },
  })
  const resolved = new Map<number, number>()
  const calls: URL[] = []
  const books = new Map<string, number>()
  let markets = [1]
  let price = 0.1
  let marketOpen = true
  let marketPatch: Record<string, unknown> = {}
  let bookPatch: Record<string, unknown> = {}
  let feePatch: Record<string, unknown> = {}
  let discoveryFailure: unknown
  let stateWriteFailures = 0
  let stateWriteFailureAt: number | undefined
  let writerHeld = true
  let onBook: ((token: string, count: number, signal: AbortSignal) => Promise<void>) | undefined
  const row = (index: number) => ({
    id: `market-${index}`, conditionId: `condition-${index}`, events: [{ id: `event-${index}` }],
    question: `Synthetic event ${index}?`, description: 'Synthetic authoritative fixture outcome.',
    resolutionSource: 'https://synthetic.engine.test/outcomes', endDate,
    clobTokenIds: JSON.stringify([`yes-${index}`, `no-${index}`]), outcomes: '["Yes","No"]',
    active: true, closed: false, acceptingOrders: marketOpen, feesEnabled: false, ...marketPatch,
  })
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    calls.push(url)
    if (url.pathname === '/markets') {
      const condition = url.searchParams.get('condition_ids')
      if (condition === null) {
        if (discoveryFailure !== undefined) throw discoveryFailure
        return Response.json(markets.map(row))
      }
      const index = Number(condition.slice('condition-'.length))
      const payout = resolved.get(index)
      return Response.json([{ ...row(index), conditionId: condition, closed: payout !== undefined,
        umaResolutionStatus: payout === undefined ? 'proposed' : 'resolved',
        outcomePrices: JSON.stringify(payout === undefined ? ['0.5', '0.5'] : [String(payout), String(1 - payout)]),
      }])
    }
    if (url.pathname.startsWith('/clob-markets/')) return Response.json({ mbf: 0, tbf: 0, fd: { r: 0, e: 1, to: true }, ...feePatch })
    if (url.pathname === '/book') {
      const token = url.searchParams.get('token_id') as string
      const count = (books.get(token) ?? 0) + 1
      books.set(token, count)
      await onBook?.(token, count, init?.signal as AbortSignal)
      const index = Number(token.split('-')[1])
      return Response.json({
        market: `condition-${index}`, asset_id: token, timestamp: String(now), hash: `book-${token}-${now}-${price}`,
        bids: [{ price: String(price - 0.01), size: '1000' }], asks: [{ price: String(price), size: '1000' }],
        min_order_size: '1', tick_size: '0.01', neg_risk: false, ...bookPatch,
      })
    }
    throw new Error(`Unrecognized fixture request ${url}`)
  }
  const errors: unknown[] = []
  const deps = {
    storageDomain: ctx.storageDomain, data: new MarketDataClient(config.data, fetcher),
    releases: null,
    assertWriter() { if (!writerHeld) throw new Error('Writer lease lost') },
    reportError(error: unknown) { errors.push(error) },
    ...(options.researchDriver === undefined ? {} : { researchDriver: options.researchDriver }),
  }
  const kv = ctx.storage.backend.get('json').kv!
  const openUnit = kv.open.bind(kv)
  vi.spyOn(kv, 'open').mockImplementation(async (descriptor) => {
    const unit = await openUnit(descriptor)
    const putRecord = unit.putRecord.bind(unit)
    vi.spyOn(unit, 'putRecord').mockImplementation(async (table, key, value) => {
      if (descriptor.name === runtimeDomain.name && table === 'state' && stateWriteFailureAt !== undefined) {
        stateWriteFailureAt--
        if (stateWriteFailureAt === 0) {
          stateWriteFailureAt = undefined
          throw new Error('Injected runtime state write failure')
        }
      }
      if (descriptor.name === runtimeDomain.name && table === 'state' && stateWriteFailures > 0) {
        stateWriteFailures--
        throw new Error('Injected runtime state write failure')
      }
      await putRecord(table, key, value)
    })
    return unit
  })
  let runtime = await RsiRuntime.open(config, deps)
  cleanups.push(async () => { await runtime.close() })
  return {
    root, config, calls, resolved, errors, deps, ctx,
    get runtime() { return runtime },
    get now() { return now },
    advance(ms: number) { now += ms },
    setMarkets(values: number[]) { markets = values },
    setPrice(value: number) { price = value },
    setMarketOpen(value: boolean) { marketOpen = value },
    patchMarket(value: typeof marketPatch) { marketPatch = value },
    patchBook(value: typeof bookPatch) { bookPatch = value },
    patchFees(value: typeof feePatch) { feePatch = value },
    failDiscovery(value: unknown) { discoveryFailure = value },
    failStateWrites(count: number) { stateWriteFailures = count },
    failStateAt(write: number) { stateWriteFailureAt = write },
    waitState(predicate: (state: RuntimeState) => boolean) {
      const receipt = Promise.withResolvers<RuntimeState>()
      const stop = ctx.on('domain/changed', (change) => {
        if (change.domain !== runtimeDomain.name || change.table !== 'state' || change.operation !== 'put') return
        const state = runtimeStateSchema.parse(change.value)
        if (predicate(state)) { stop(); receipt.resolve(state) }
      })
      return receipt.promise
    },
    interceptBook(hook: typeof onBook) { books.clear(); onBook = hook },
    loseWriter() { writerHeld = false },
    async reopen() {
      await runtime.close()
      runtime = await RsiRuntime.open(config, deps)
      return runtime
    },
  }
}

describe('operator research directives', () => {
  it('projects research quotas and collection controls without inventing model response evidence', async () => {
    const fixture = await engine()
    await fixture.runtime.registerCandidate({ name: 'Pending evidence', thesis: 'Prospective fixture without results.',
      minEdge: 0.05, kellyFraction: 0.1 })
    const source = fixture.runtime.consoleSource()
    source.config = structuredClone(source.config)
    source.config.autoTick = true
    source.config.research.enabled = true
    source.config.research.maxRunsPerDay = 2
    source.state.nextTickAt = source.now + 1000
    expect(queryOverview(source)).toMatchObject({ nextResearchAt: source.now, nextTickAt: source.now + 1000, champion: null })
    source.state.researchRuns = [{ id: 'pending-run', sessionId: 'native-session', state: 'running',
      day: new Date(source.now).toISOString().slice(0, 10), startedAt: source.now, finishedAt: null, error: null }]
    expect(queryOverview(source).nextResearchAt).toBe(source.now + source.config.research.intervalMs)
    expect(queryDecisions(source, { search: '', kinds: ['research'], cursor: null, limit: 10 }).items[0]?.outcome).toBe('running')
    source.config.research.maxRunsPerDay = 1
    expect(queryOverview(source).nextResearchAt).toBe(Date.parse(`${source.state.researchRuns[0]!.day}T00:00:00Z`) + 86_400_000)
    source.state.researchRuns[0] = { ...source.state.researchRuns[0]!, state: 'completed', finishedAt: source.now }
    expect(queryOverview(source).health.find(item => item.component === 'model')?.state).toBe('unknown')
    source.operations = { revision: 1, stopped: true, reason: 'Fixture stop', changedAt: source.now }
    expect(queryOverview(source)).toMatchObject({ nextResearchAt: null, nextTickAt: null })
    expect(queryOverview(source).health.find(item => item.component === 'scheduler')?.state).toBe('paused')
    expect(() => queryDecision(source, brandString<DecisionId>('release:unconfigured'))).toThrow('Unknown release validation record')
  })

  it('retains independent API results across restart and does not blame uncalled providers', async () => {
    const fixture = await engine()
    fixture.failDiscovery(new Error('Gamma unavailable'))
    await expect(fixture.runtime.tick()).rejects.toThrow('Gamma unavailable')
    expect(queryOverview(fixture.runtime.consoleSource()).health.slice(0, 2)).toMatchObject([
      { component: 'gamma', state: 'degraded', error: 'Gamma unavailable' }, { component: 'clob', state: 'unknown', error: null },
    ])
    fixture.failDiscovery(undefined)
    fixture.advance(1)
    fixture.patchBook({ asset_id: 'wrong-token' })
    await fixture.runtime.tick()
    const measured = queryOverview(fixture.runtime.consoleSource()).health.slice(0, 2)
    expect(measured).toMatchObject([{ component: 'gamma', state: 'healthy' }, { component: 'clob', state: 'degraded' }])
    await fixture.reopen()
    expect(queryOverview(fixture.runtime.consoleSource()).health.slice(0, 2)).toEqual(measured)
    fixture.patchBook({})
    await fixture.runtime.tick()
    expect(queryOverview(fixture.runtime.consoleSource()).health.slice(0, 2).every(item => item.state === 'healthy')).toBe(true)
    const source = fixture.runtime.consoleSource()
    source.state.lastTickError = 'Unrelated workflow failure'
    expect(queryOverview(source).health.slice(0, 2).every(item => item.state === 'healthy')).toBe(true)
    fixture.advance(fixture.config.maxObservationAgeMs + 1)
    expect(queryOverview(fixture.runtime.consoleSource()).health.slice(0, 2).every(item => item.state === 'degraded')).toBe(true)
  })

  it('keeps a successful model response healthy when subsequent research work fails', async () => {
    const fixture = await engine({ researchDriver: async (_run, _signal, sessionReady, modelResult) => {
      await sessionReady(SessionId('measured-model-session'))
      await modelResult?.(observeHealth(null, Date.now(), null))
      throw new Error('Research tool failed')
    } })
    const failed = fixture.waitState(state => state.researchRuns.at(-1)?.state === 'failed')
    await fixture.runtime.tick()
    await failed
    expect(queryOverview(fixture.runtime.consoleSource()).health.find(item => item.component === 'model'))
      .toMatchObject({ state: 'healthy', error: null, lastSuccessAt: fixture.now })
  })

  it('rejects a directive that became stale while pausing the executor', async () => {
    const fixture = await engine()
    const pause = fixture.runtime.ledger.control.bind(fixture.runtime.ledger)
    const paused = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(fixture.runtime.ledger, 'control').mockImplementationOnce(async (request) => {
      const account = await pause(request)
      paused.resolve(undefined)
      await release.promise
      return account
    })
    const first = fixture.runtime.changeObjective(0, 'Delayed objective')
    const rejected = expect(first).rejects.toThrow('Research directive revision is stale')
    await paused.promise
    await fixture.runtime.changeObjective(0, 'Current objective')
    release.resolve(undefined)
    await rejected
    expect(fixture.runtime.status()).toMatchObject({ objective: 'Current objective', directiveRevision: 1, status: 'paused' })
  })

  it('persists pause and objective revisions without resetting the paper account', async () => {
    const fixture = await engine()
    await fixture.runtime.pauseResearch(true)
    expect(fixture.runtime.status().research.paused).toBe(true)
    const next = await fixture.runtime.changeObjective(0, 'Investigate weather forecasts')
    expect(next).toMatchObject({ objective: 'Investigate weather forecasts', directiveRevision: 1, status: 'paused' })
    await expect(fixture.runtime.changeObjective(0, 'Obsolete directive')).rejects.toThrow('stale')
    await expect(fixture.runtime.changeObjective(1, '  ')).rejects.toThrow()
    await fixture.reopen()
    expect(fixture.runtime.status()).toMatchObject({
      objective: 'Investigate weather forecasts', directiveRevision: 1, research: { paused: true },
      account: { cashMicros: 100_000_000, purchases: 0 },
    })
    await fixture.runtime.pauseResearch(false)
    expect(fixture.runtime.status().research.paused).toBe(false)
  })

  it('lets a research agent pause its own admissions without awaiting its own run', async () => {
    const fixture: Awaited<ReturnType<typeof engine>> = await engine({ researchDriver: async () => {
      await fixture.runtime.pauseResearch(true)
      return { sessionId: 'cancelled-research' }
    } })
    const done = fixture.waitState(state => state.researchRuns.some(run => run.state === 'failed'))
    await fixture.runtime.tick()
    await done
    expect(fixture.runtime.status().research.paused).toBe(true)
    expect(fixture.runtime.status().research.runs).toHaveLength(1)
    await fixture.runtime.tick()
    expect(fixture.runtime.status().research.runs).toHaveLength(1)
  })
})

type Engine = Awaited<ReturnType<typeof engine>>

function observationFor(fixture: Engine, tokenId: string) {
  const observation = fixture.runtime.status().observations.findLast(item => item.tokenId === tokenId)
  if (observation === undefined) throw new Error(`Fixture observation missing for ${tokenId}`)
  return fixture.runtime.observation(observation.id)
}

async function seedEligible(fixture: Engine, options: { secondCandidate?: boolean; liveProbability?: number } = {}): Promise<Candidate> {
  fixture.setMarkets(Array.from({ length: 40 }, (_, index) => index + 1))
  await fixture.runtime.tick()
  const candidate = await fixture.runtime.registerCandidate({
    name: 'synthetic-positive', thesis: 'Synthetic fixture outcomes only, not observed trading performance.',
    minEdge: 0.05, kellyFraction: 0.1,
  })
  const candidates = [candidate]
  if (options.secondCandidate) candidates.push(await fixture.runtime.registerCandidate({
    name: 'second-synthetic-positive', thesis: candidate.thesis, minEdge: 0.05, kellyFraction: 0.1,
  }))
  for (let index = 1; index <= 40; index++) {
    for (const member of candidates) {
      await fixture.runtime.forecast(observationFor(fixture, `yes-${index}`).id, {
        candidateId: member.id, probability: 0.9, uncertainty: 0.05, evidence: [],
      })
    }
    fixture.resolved.set(index, 1)
  }
  fixture.advance(10)
  fixture.setMarkets([1000])
  await fixture.runtime.tick()
  expect(fixture.runtime.experiments.rank()[0]?.status).toBe('paper-eligible')
  for (const member of candidates) {
    await fixture.runtime.forecast(observationFor(fixture, 'yes-1000').id, {
      candidateId: member.id, probability: options.liveProbability ?? 0.9, uncertainty: 0.05, evidence: [],
    })
  }
  fixture.advance(5)
  await fixture.runtime.control({ expectedRevision: 0, action: 'resume', reason: 'Synthetic execution fixture' })
  return candidate
}

const opportunityQuery: OpportunityQuery = {
  search: '', category: null, state: null, minLiquidityMicros: 0,
  maxHorizonMs: null, maxAgeMs: null, order: 'edge', cursor: null, limit: 2,
}

describe('console projections and emergency control', () => {
  it('keeps category choices outside filtered pages and continues by token identity after quote updates', async () => {
    const fixture = await engine()
    fixture.patchMarket({ category: 'Macro' })
    await fixture.runtime.tick()
    fixture.setMarkets([2])
    fixture.patchMarket({ category: 'Weather' })
    await fixture.runtime.tick()
    const query: OpportunityQuery = { ...opportunityQuery, category: 'Macro', order: 'deadline', limit: 1 }
    const first = queryOpportunities(fixture.runtime.consoleSource(), query)
    expect(first).toMatchObject({ categories: ['Macro', 'Weather'], total: 2, unfilteredTotal: 4, offset: 0 })
    fixture.setMarkets([1])
    fixture.patchMarket({ category: 'Macro' })
    fixture.setPrice(0.2)
    fixture.advance(10)
    await fixture.runtime.tick()
    const next = queryOpportunities(fixture.runtime.consoleSource(), { ...query, cursor: first.nextCursor })
    expect(next.offset).toBe(1)
    expect(next.items[0]?.tokenId).not.toBe(first.items[0]?.tokenId)
    expect(next.items[0]?.executionCostMicros).toBe(200_000)
  })

  it('retains evidence annotations and projects the recorded uncertainty range without classifying older evidence', async () => {
    const fixture = await engine()
    await fixture.runtime.tick()
    const candidate = await fixture.runtime.registerCandidate({ name: 'Evidence annotations', thesis: 'Synthetic supporting and opposing records.',
      minEdge: 0.05, kellyFraction: 0.1 })
    const observation = observationFor(fixture, 'yes-1')
    await expect(fixture.runtime.forecast(observation.id, { candidateId: candidate.id, probability: 0.9, uncertainty: 0.2,
      evidence: [{ url: 'https://fixture.test/invalid', text: 'Invalid annotation', stance: 'rumor' }] })).rejects.toThrow()
    await fixture.runtime.forecast(observation.id, { candidateId: candidate.id, probability: 0.9, uncertainty: 0.2,
      evidence: [
        { url: 'https://fixture.test/support', text: 'Supporting record', stance: 'supports' },
        { url: 'https://fixture.test/against', text: 'Opposing record', stance: 'contradicts' },
        { url: 'https://fixture.test/context', text: 'Context record', stance: 'context' },
        { url: 'https://fixture.test/unclassified', text: 'Unclassified record' },
      ] })
    await fixture.reopen()
    const detail = queryOpportunity(fixture.runtime.consoleSource(), observation.id)
    expect(detail.probabilityRange?.low).toBeCloseTo(0.7)
    expect(detail.probabilityRange?.high).toBe(1)
    expect(detail.evidence.map(item => item.stance)).toEqual(['supports', 'contradicts', 'context', null])
    expect(fixture.runtime.experiments.view().forecasts[0]?.evidence[3]).not.toHaveProperty('stance')
  })

  it('projects pending candidate evaluations and stable forecast references from retained evidence', async () => {
    const fixture = await engine()
    await fixture.runtime.tick()
    const parent = await fixture.runtime.registerCandidate({ name: 'Parent', thesis: 'Prospective parent.', minEdge: 0.05, kellyFraction: 0.1 })
    const child = await fixture.runtime.registerCandidate({ name: 'Child', thesis: 'Prospective child.', minEdge: 0.05,
      kellyFraction: 0.1, parentId: parent.id })
    const first = queryStrategies(fixture.runtime.consoleSource())
    expect(first.find(row => row.id === child.id)).toMatchObject({ parentId: parent.id, queueState: 'awaiting-forecasts',
      pendingEvents: 0, nextEventAt: null, maxDrawdownMicros: null, requiredEvents: 30 })
    const observation = observationFor(fixture, 'yes-1')
    await fixture.runtime.forecast(observation.id, { candidateId: parent.id, probability: 0.9, uncertainty: 0.05, evidence: [] })
    const source = fixture.runtime.consoleSource()
    const view = queryStrategy(source, parent.id)
    expect(view.strategy).toMatchObject({ queueState: 'awaiting-outcomes', pendingEvents: 1,
      nextEventAt: Date.parse(observation.market.endDate) })
    expect(view.strategy.checks).toHaveLength(5)
    expect(view.strategy.checks.find(check => check.code === 'independence')?.passed).toBeNull()
    expect(queryDecision(source, view.forecasts[0]!.id).decision).toMatchObject({ kind: 'forecast', candidateId: parent.id })
    const missing = queryStrategy({ ...source, observations: [] }, parent.id)
    expect(missing.forecasts[0]).toMatchObject({ question: observation.market.id, outcome: observation.book.tokenId })
    expect(() => queryStrategy(source, brandString<Candidate['id']>('unknown-candidate'))).toThrow('Unknown strategy')
    fixture.setMarkets([2])
    await fixture.runtime.tick()
    await fixture.runtime.forecast(observationFor(fixture, 'yes-2').id, {
      candidateId: parent.id, probability: 0.9, uncertainty: 0.05, evidence: [],
    })
    expect(queryStrategy(fixture.runtime.consoleSource(), parent.id).strategy).toMatchObject({
      pendingEvents: 2, nextEventAt: Date.parse(observation.market.endDate),
    })
  })

  it('retains a rejected prospective strategy without inventing financial drawdown', async () => {
    const fixture = await engine()
    fixture.setMarkets(Array.from({ length: 30 }, (_, index) => index + 1))
    await fixture.runtime.tick()
    const candidate = await fixture.runtime.registerCandidate({ name: 'Unsuccessful', thesis: 'Synthetic failed outcomes.',
      minEdge: 0.05, kellyFraction: 0.1 })
    for (let index = 1; index <= 30; index++) {
      await fixture.runtime.forecast(observationFor(fixture, `yes-${index}`).id, {
        candidateId: candidate.id, probability: 0.9, uncertainty: 0.05, evidence: [],
      })
      fixture.resolved.set(index, 0)
    }
    fixture.advance(10)
    await fixture.runtime.tick()
    expect(queryStrategy(fixture.runtime.consoleSource(), candidate.id).strategy).toMatchObject({
      role: 'rejected', queueState: null, maxDrawdownMicros: null, realizedProfitMicros: 0,
    })
  })

  it('attributes a strategy drawdown from settlement cash flows against initial account capital', async () => {
    const fixture = await engine()
    const candidate = await seedEligible(fixture)
    await fixture.runtime.tick()
    fixture.resolved.set(1000, 1)
    fixture.advance(10)
    fixture.setMarkets([1001])
    await fixture.runtime.tick()
    await fixture.runtime.forecast(observationFor(fixture, 'yes-1001').id, {
      candidateId: candidate.id, probability: 0.9, uncertainty: 0.05, evidence: [],
    })
    fixture.advance(5)
    await fixture.runtime.tick()
    fixture.resolved.set(1001, 0)
    fixture.advance(10)
    await fixture.runtime.tick()
    expect(queryStrategy(fixture.runtime.consoleSource(), candidate.id).strategy).toMatchObject({
      realizedProfitMicros: 8_000_000, committedCostMicros: 0, maxDrawdownMicros: 1_000_000, maxDrawdownFraction: 0.01,
      queueState: null, pendingEvents: 0,
    })
  })

  it('publishes a running research Session and keeps its identity on failure', async () => {
    const release = Promise.withResolvers<undefined>()
    const fixture = await engine({ researchDriver: async (_run, _signal, publish) => {
      await publish(SessionId('active-research'))
      await release.promise
      throw new Error('Synthetic research failed')
    } })
    cleanups.push(async () => { release.resolve(undefined) })
    const linked = fixture.waitState(state => state.researchRuns.some(run => run.sessionId === 'active-research' || run.state === 'failed'))
    const failed = fixture.waitState(state => state.researchRuns.some(run => run.state === 'failed'))
    await fixture.runtime.tick()
    await linked
    expect(fixture.runtime.status().research.runs[0]).toMatchObject({ state: 'running', sessionId: 'active-research' })
    release.resolve(undefined)
    await failed
    expect(fixture.runtime.status().research.runs[0]).toMatchObject({ state: 'failed', sessionId: 'active-research' })
    await fixture.reopen()
    expect(fixture.runtime.status().research.runs[0]?.sessionId).toBe('active-research')
  })

  it('rejects a research driver that replaces an already published Session identity', async () => {
    const fixture = await engine({ researchDriver: async (_run, _signal, publish) => {
      await publish(SessionId('first-research'))
      return { sessionId: 'different-research' }
    } })
    const failed = fixture.waitState(state => state.researchRuns.some(run => run.state === 'failed'))
    await fixture.runtime.tick()
    await failed
    expect(fixture.runtime.status().research.runs[0]).toMatchObject({ state: 'failed', sessionId: 'first-research',
      error: 'Research run already identifies a different Session' })
  })

  it('retains rejected sizing without a debit and deduplicates unchanged decisions across restart', async () => {
    const fixture = await engine()
    await seedEligible(fixture)
    fixture.patchBook({ asks: [{ price: '0.125', size: '1' }, { price: '0.25', size: '1000' }] })
    await fixture.runtime.tick()
    const rejection = queryRisk(fixture.runtime.consoleSource()).recentRejections[0]!
    expect(rejection.decision).toMatchObject({ kind: 'trade', outcome: 'rejected', summary: 'trade.rejected' })
    expect(rejection.assessment?.sizing).toMatchObject({ budgetMicros: 1_000_000, quote: { totalCostMicros: 1_875_000 } })
    expect(rejection.checks.filter(check => check.passed === false).map(check => check.code)).toEqual(['budget', 'event'])
    expect(fixture.runtime.status().account).toMatchObject({ purchases: 0, cashMicros: 100_000_000 })
    await fixture.runtime.tick()
    await fixture.reopen()
    await fixture.runtime.tick()
    const repeated = queryRisk(fixture.runtime.consoleSource()).recentRejections
    expect(repeated).toHaveLength(1)
    expect(repeated[0]).toEqual(rejection)
  })

  it('keeps entry sizing in the original receipt across later forecasts, controls and restart', async () => {
    const fixture = await engine()
    const candidate = await seedEligible(fixture)
    await fixture.runtime.tick()
    const receipt = fixture.runtime.ledger.view().trades[0]!
    const entry = structuredClone(receipt.intent.assessment)
    expect(entry).toMatchObject({
      algorithm: 'fractional-kelly-v1', probability: 0.9, uncertainty: 0.05, equityMicros: 100_000_000,
      minEdge: candidate.minEdge, kellyFraction: candidate.kellyFraction,
      sizing: { budgetMicros: 1_000_000, quantity: receipt.intent.quantity, quote: { totalCostMicros: receipt.intent.costMicros } },
    })
    expect(entry?.sizing.checks.every(check => check.passed)).toBe(true)
    await fixture.runtime.control({ expectedRevision: 1, action: 'pause', reason: 'Inspect original entry evidence' })
    const later = await fixture.runtime.registerCandidate({ name: 'Later policy', thesis: 'A different later estimate.', minEdge: 0.05, kellyFraction: 0.2 })
    await fixture.runtime.forecast(observationFor(fixture, 'yes-1000').id, {
      candidateId: later.id, probability: 0.99, uncertainty: 0.01, evidence: [],
    })
    await fixture.reopen()
    const source = fixture.runtime.consoleSource()
    expect(queryPosition(source, receipt.intent.tokenId).lots[0]?.assessment).toEqual(entry)
    const decision = queryDecision(source, brandString<DecisionId>(`trade:${receipt.intent.id}`))
    expect(decision.assessment).toEqual(entry)
    expect(decision.checks).toEqual(entry?.sizing.checks)
    expect(decision.pricing?.totalCostMicros).toBe(receipt.intent.costMicros)
    if (decision.assessment !== undefined) decision.assessment.probability = 0
    expect(queryDecision(fixture.runtime.consoleSource(), decision.decision.id).assessment).toEqual(entry)
  })

  it('keeps absent observations and forecasts distinct from zero account balances', async () => {
    const fixture = await engine()
    const source = fixture.runtime.consoleSource()
    expect(queryOverview(source)).toMatchObject({ observations: 0, forecasts: 0, champion: null, positions: 0, todayProfitMicros: 0 })
    expect(queryOverview(source).health.filter(item => item.component === 'gamma' || item.component === 'clob')
      .every(item => item.state === 'unknown')).toBe(true)
    expect(queryRisk(source)).toMatchObject({ equityMicros: 100_000_000, cashMicros: 100_000_000, positions: [], categories: [] })
    expect(queryStrategies(source)).toEqual([])
    expect(queryOpportunities(source, opportunityQuery)).toEqual({
      items: [], total: 0, nextCursor: null, categories: [], offset: 0, unfilteredTotal: 0,
    })
    expect(queryDecisions(source, { search: '', kinds: [], cursor: null, limit: 10 }).items).toEqual([])
  })

  it('filters and pages latest tokens while detail preserves the exact observation', async () => {
    const fixture = await engine()
    fixture.setMarkets([1, 2, 3])
    fixture.patchMarket({ category: 'Macro' })
    await fixture.runtime.tick()
    const observation = observationFor(fixture, 'yes-1')
    const candidate = await fixture.runtime.registerCandidate({ name: 'Forecast', thesis: 'Fixture evidence', minEdge: 0.1, kellyFraction: 0.25 })
    await fixture.runtime.forecast(observation.id, { candidateId: candidate.id, probability: 0.9, uncertainty: 0.1,
      evidence: [{ url: 'https://fixture.test/evidence', text: 'Recorded source' }] })
    const source = fixture.runtime.consoleSource()
    const first = queryOpportunities(source, opportunityQuery)
    expect(first.total).toBe(6)
    expect(first.items[0]).toMatchObject({ tokenId: 'yes-1', agentProbability: 0.9, category: 'Macro', plannedCostMicros: 0 })
    const second = queryOpportunities(source, { ...opportunityQuery, cursor: first.nextCursor })
    expect(second.items.every(item => !first.items.some(previous => previous.observationId === item.observationId))).toBe(true)
    expect(() => queryOpportunities(source, { ...opportunityQuery, search: 'another', cursor: first.nextCursor })).toThrow('another query')
    expect(queryOpportunities(source, { ...opportunityQuery, search: 'event 2', category: 'Macro', order: 'liquidity' }).total).toBe(2)
    expect(queryOpportunities(source, { ...opportunityQuery, category: 'Other' }).total).toBe(0)
    expect(queryOpportunities(source, { ...opportunityQuery, minLiquidityMicros: 1_000_000_000 }).total).toBe(0)
    expect(queryOpportunities(source, { ...opportunityQuery, maxHorizonMs: 1, order: 'deadline' }).total).toBe(0)
    expect(queryOpportunity(source, observation.id)).toMatchObject({
      opportunity: { observationId: observation.id, marketProbability: 0.095 }, bookHash: observation.book.hash,
      evidence: [{ text: 'Recorded source' }], uncertainty: 0.1,
    })
    expect(queryOpportunity(source, observation.id).sizing?.checks.find(check => check.code === 'eligible')?.passed).toBe(false)
    expect(queryDecisions(source, { search: '', kinds: ['forecast'], cursor: null, limit: 10 }).items).toHaveLength(1)
    expect(() => queryOpportunity(source, 'unknown')).toThrow('Unknown')
    fixture.advance(60_001)
    const stale = fixture.runtime.consoleSource()
    expect(queryOpportunities(stale, { ...opportunityQuery, state: 'stale', order: 'newest' }).total).toBe(6)
    expect(queryOpportunities(stale, { ...opportunityQuery, maxAgeMs: 1 }).total).toBe(0)
  })

  it('derives strategy attribution, cost-basis equity and receipt detail from actual execution', async () => {
    const fixture = await engine()
    const candidate = await seedEligible(fixture)
    await fixture.runtime.tick()
    const source = fixture.runtime.consoleSource()
    const position = queryRisk(source).positions[0]
    expect(position).toMatchObject({ tokenId: 'yes-1000', costMicros: 1_000_000, quantity: 10 })
    if (position === undefined) throw new Error('Fixture failed to create a position')
    expect(queryPosition(source, position.tokenId).lots[0]).toMatchObject({ candidateId: candidate.id, costMicros: 1_000_000 })
    expect(queryStrategy(source, candidate.id)).toMatchObject({ strategy: { role: 'champion', committedCostMicros: 1_000_000 } })
    expect(queryStrategy(source, candidate.id).scores).toHaveLength(40)
    const trade = queryDecisions(source, { search: '', kinds: ['trade'], cursor: null, limit: 10 }).items[0]
    if (trade === undefined) throw new Error('Fixture lost the purchase receipt')
    const detail = queryDecision(source, trade.id)
    expect(detail.pricing).toMatchObject({ totalCostMicros: 1_000_000, quantity: 10 })
    expect(detail.references.some(item => item.kind === 'cashAfterMicros' && item.value === '99000000')).toBe(true)
    fixture.advance(10)
    fixture.resolved.set(1000, 1)
    await fixture.runtime.tick()
    const settled = fixture.runtime.consoleSource()
    expect(queryRisk(settled)).toMatchObject({ equityMicros: 109_000_000, realizedProfitMicros: 9_000_000, positions: [] })
    expect(queryRisk(settled).equity.at(-1)).toMatchObject({ equityMicros: 109_000_000, realizedProfitMicros: 9_000_000 })
    expect(queryStrategy(settled, candidate.id).strategy.realizedProfitMicros).toBe(9_000_000)
    expect(queryOverview(settled).todayProfitMicros).toBe(9_000_000)
    expect(() => queryPosition(settled, position.tokenId)).toThrow('Unknown open position')
    expect(() => queryDecision(settled, brandString<DecisionId>('missing'))).toThrow('Unknown decision')
  })

  it('orders multiple settlements and preserves receipts lacking entry assessments or candidate metadata', async () => {
    const fixture = await engine()
    const candidate = await seedEligible(fixture)
    await fixture.runtime.tick()
    fixture.setMarkets([1000, 1001])
    await fixture.runtime.tick()
    await fixture.runtime.forecast(observationFor(fixture, 'yes-1001').id, {
      candidateId: candidate.id, probability: 0.9, uncertainty: 0.05, evidence: [],
    })
    await fixture.runtime.tick()
    const source = fixture.runtime.consoleSource()
    expect(queryRisk(source).events).toHaveLength(2)
    const trade = source.account.trades[0]!
    const { assessment: _, ...legacyIntent } = trade.intent
    const legacy = { ...source, research: { ...source.research, candidates: [] },
      account: { ...source.account, trades: source.account.trades.map(item => item === trade ? { ...item, intent: legacyIntent } : item) } }
    const detail = queryPosition(legacy, trade.intent.tokenId)
    expect(detail.lots[0]?.assessment).toBeNull()
    expect(detail.position.strategies).toEqual([{ id: candidate.id, name: candidate.id }])
    expect(queryRisk(legacy).latestSizing?.decisionId).toBe(`trade:${source.account.trades.at(-1)!.intent.id}`)
    const decisionId = brandString<DecisionId>(`trade:${trade.intent.id}`)
    expect(queryDecision(legacy, decisionId)).toMatchObject({ pricing: { totalCostMicros: trade.intent.costMicros } })
    const references = queryDecision(legacy, decisionId).references
    expect(references).toContainEqual({ kind: 'candidate', value: candidate.id })
    expect(references.find(item => item.kind === 'forecast')?.value).toMatch(/^forecast:/)
    const withoutResearch = queryDecision({ ...legacy, research: { ...legacy.research, forecasts: [] } }, decisionId)
    expect(withoutResearch.references.some(item => item.kind === 'forecast')).toBe(false)
    expect(queryDecision({ ...legacy, observations: [] }, decisionId)).toMatchObject({ pricing: null, decision: { question: null } })
    fixture.resolved.set(1000, 1)
    await fixture.runtime.tick()
    fixture.advance(10)
    fixture.resolved.set(1001, 0)
    await fixture.runtime.tick()
    const settled = fixture.runtime.consoleSource()
    settled.account.settlements.reverse()
    expect(queryRisk(settled).equity.map(point => point.equityMicros)).toEqual([100_000_000, 109_000_000, 108_000_000])
    expect(queryRisk(settled).equity.at(-1)?.drawdownMicros).toBe(1_000_000)
    const unknownSources = queryDecisions({ ...settled, observations: [] }, {
      kinds: ['trade', 'forecast', 'settlement'], search: '', cursor: null, limit: 100,
    })
    expect(unknownSources.items.every(item => item.question === null)).toBe(true)
    expect(unknownSources.items.filter(item => item.kind === 'settlement')).toHaveLength(2)
    expect(queryRisk(settled).historicalDrawdownFraction).toBeCloseTo(1 / 109)
    fixture.setMarkets([1002])
    await fixture.runtime.tick()
    await fixture.runtime.forecast(observationFor(fixture, 'yes-1002').id, {
      candidateId: candidate.id, probability: 0.9, uncertainty: 0.05, evidence: [],
    })
    await fixture.runtime.tick()
    const purchase = fixture.runtime.ledger.view().trades.at(-1)!
    fixture.advance(10)
    fixture.resolved.set(1002, 1)
    await fixture.runtime.tick()
    const recovered = queryRisk(fixture.runtime.consoleSource())
    expect(recovered.drawdownMicros).toBe(0)
    expect(recovered.historicalDrawdownMicros).toBe(1_000_000)
    expect(recovered.historicalDrawdownFraction).toBeCloseTo(1 / 109)
    expect(recovered.latestSizing).toMatchObject({ decisionId: `trade:${purchase.intent.id}`, equityMicros: 108_000_000 })
  })

  it('reports held-token evidence gaps and capacity without interpreting missing data as normal risk', async () => {
    const fixture = await engine()
    await seedEligible(fixture)
    await fixture.runtime.tick()
    const source = fixture.runtime.consoleSource()
    expect(queryRisk(source).status).toEqual({ state: 'attention', reasons: ['event-capacity'] })
    source.account.config.perEventLimitMicros = 2_000_000
    expect(queryRisk(source).status).toEqual({ state: 'normal', reasons: [] })
    const tokenId = source.account.positions[0]!.tokenId
    const current = source.observations.findLast(item => item.book.tokenId === tokenId)!
    source.observations.push({ ...current, book: { ...current.book, observedAt: current.book.observedAt - 1 } })
    expect(queryPosition(source, tokenId).position.latestObservedAt).toBe(current.book.observedAt)
    const missing = { ...source, observations: [] }
    expect(queryRisk(missing).status).toEqual({ state: 'unknown', reasons: ['observation-missing'] })
    expect(queryPosition(missing, tokenId).position).toMatchObject({ latestProbability: null, risk: { state: 'unknown' } })
    expect(queryRisk({ ...source, now: source.now + source.config.maxObservationAgeMs }).status.state).toBe('normal')
    expect(queryRisk({ ...source, now: source.now + source.config.maxObservationAgeMs + 1 }).status)
      .toEqual({ state: 'attention', reasons: ['observation-stale'] })
    for (const changed of [
      { ...current, market: { ...current.market, observedAt: source.now + 1 } },
      { ...current, book: { ...current.book, timestamp: source.now - source.config.maxObservationAgeMs - 1 } },
      { ...current, fees: { ...current.fees, observedAt: source.now + 1 } },
    ]) {
      expect(queryRisk({ ...source, observations: [changed] }).status.reasons).toEqual(['observation-stale'])
    }
    for (const market of [{ ...current.market, closed: true }, { ...current.market, endDate: new Date(source.now).toISOString() }]) {
      expect(queryRisk({ ...source, observations: [{ ...current, market }] }).status.reasons).toEqual(['awaiting-settlement'])
    }
    for (const market of [{ ...current.market, active: false }, { ...current.market, acceptingOrders: false }]) {
      expect(queryRisk({ ...source, observations: [{ ...current, market }] }).status.reasons).toEqual(['market-unavailable'])
    }
    source.account.config.totalExposureLimitMicros = source.account.committedCostMicros
    source.account.config.maxDrawdownMicros = source.account.peakEquityMicros - source.account.cashMicros
    expect(queryRisk(source).status).toEqual({ state: 'attention', reasons: ['exposure-capacity', 'drawdown-capacity'] })
    expect(queryOverview(source).risk.status).toEqual(queryRisk(source).status)
  })

  it('aggregates both outcome holdings against their shared event limit', async () => {
    const fixture = await engine()
    await seedEligible(fixture)
    await fixture.runtime.tick()
    const source = fixture.runtime.consoleSource()
    const position = source.account.positions[0]!
    source.account.config.perEventLimitMicros = 2 * position.costMicros
    source.account.positions.push({ ...position, tokenId: brandString<TokenId>('no-1000') })
    source.account.committedCostMicros += position.costMicros
    source.account.cashMicros -= position.costMicros
    source.account.config.maxDrawdownMicros = 3 * position.costMicros
    const value = queryRisk(source)
    expect(value.events).toEqual([{ id: position.eventId, costMicros: 2 * position.costMicros }])
    expect(value.positions.map(item => item.risk.reasons)).toEqual([['event-capacity'], ['event-capacity']])
    expect(value.status.reasons).toEqual(['event-capacity'])
  })

  it('persists emergency stop across restart and rejects alternate research and buy entry paths', async () => {
    const fixture = await engine()
    await seedEligible(fixture)
    await fixture.runtime.tick()
    const receipt = fixture.runtime.ledger.view().trades[0]
    if (receipt === undefined) throw new Error('Fixture lost its purchase')
    await fixture.runtime.changeOperations(0, true, 'Emergency test')
    expect(() => fixture.runtime.tick()).toThrow('emergency-stopped')
    await expect(fixture.runtime.control({ expectedRevision: fixture.runtime.status().controlRevision, action: 'resume', reason: 'Bypass' }))
      .rejects.toThrow('emergency-stopped')
    await expect(fixture.runtime.pauseResearch(false)).rejects.toThrow('emergency-stopped')
    await expect(fixture.runtime.ledger.execute({ ...receipt.intent, id: brandString<TradeIntentId>('blocked-purchase') }))
      .rejects.toThrow('emergency-stopped')
    await expect(fixture.runtime.registerCandidate({ name: 'Blocked', thesis: 'Blocked proposal', minEdge: 0.1, kellyFraction: 0.1 }))
      .rejects.toThrow('emergency-stopped')
    await fixture.reopen()
    expect(fixture.runtime.operations.view()).toMatchObject({ stopped: true, revision: 1, reason: 'Emergency test' })
    expect(() => fixture.runtime.tick()).toThrow('emergency-stopped')
    await expect(fixture.runtime.changeOperations(0, false, 'Stale')).rejects.toThrow('stale')
    await fixture.runtime.changeOperations(1, false, 'Recover')
    expect(fixture.runtime.status()).toMatchObject({ status: 'paused', research: { paused: false } })
    expect(fixture.runtime.operations.view().stopped).toBe(false)
  })

  it('serializes recovery behind a stop whose executor cancellation is still settling', async () => {
    const fixture = await engine()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const control = fixture.runtime.ledger.control.bind(fixture.runtime.ledger)
    vi.spyOn(fixture.runtime.ledger, 'control').mockImplementationOnce(async (request) => {
      entered.resolve(undefined)
      await release.promise
      return control(request)
    })
    const stopping = fixture.runtime.changeOperations(0, true, 'Stop')
    await entered.promise
    const recovering = fixture.runtime.changeOperations(1, false, 'Resume')
    expect(fixture.runtime.operations.view().stopped).toBe(true)
    release.resolve(undefined)
    await stopping
    await recovering
    expect(fixture.runtime.operations.view()).toMatchObject({ stopped: false, revision: 2 })
    expect(fixture.runtime.status().research.paused).toBe(false)
  })
})

describe('prospective runtime execution', () => {
  it('uses only retained quote evidence, sizes by aggregate risk, and executes a forecast once across ticks and restart', async () => {
    const fixture = await engine()
    await seedEligible(fixture)
    const before = fixture.runtime.ledger.view()
    const one = fixture.runtime.tick()
    expect(fixture.runtime.tick()).toBe(one)
    await one
    const after = fixture.runtime.ledger.view()
    expect(after.trades).toHaveLength(1)
    expect(after.trades[0]?.intent).toMatchObject({ quantity: 10, costMicros: 1_000_000, tokenId: 'yes-1000' })
    expect(after.cashMicros).toBe(before.cashMicros - 1_000_000)
    await fixture.runtime.tick()
    expect(fixture.runtime.ledger.view().trades).toHaveLength(1)
    await fixture.reopen()
    await fixture.runtime.tick()
    expect(fixture.runtime.ledger.view()).toEqual(after)
  })

  it('rechecks a pause committed while fresh execution data is in flight', async () => {
    const fixture = await engine()
    await seedEligible(fixture)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    fixture.interceptBook(async (token, count) => {
      if (token === 'yes-1000' && count === 2) { entered.resolve(undefined); await release.promise }
    })
    const outcome = fixture.runtime.tick().then(() => null, (error: unknown) => error)
    try {
      await entered.promise
      await fixture.runtime.control({ expectedRevision: 1, action: 'pause', reason: 'Stop during quote fetch' })
    } finally {
      release.resolve(undefined)
    }
    expect(await outcome).toBeInstanceOf(Error)
    expect(fixture.runtime.ledger.view()).toMatchObject({ status: 'paused', cashMicros: 100_000_000, trades: [] })
  })

  it('refuses a forecast that expires while execution data is being fetched', async () => {
    const fixture = await engine({ maxForecastAge: 1000 })
    await seedEligible(fixture)
    fixture.interceptBook(async (token, count) => {
      if (token === 'yes-1000' && count === 2) fixture.advance(997)
    })
    await Promise.allSettled([fixture.runtime.tick()])
    expect(fixture.runtime.ledger.view().trades).toEqual([])
  })

  it('requires current market order acceptance before executing a previously admitted forecast', async () => {
    const fixture = await engine()
    await seedEligible(fixture)
    fixture.setMarketOpen(false)
    await fixture.runtime.tick()
    expect(fixture.runtime.ledger.view().trades).toEqual([])
    fixture.setMarketOpen(true)
    await fixture.runtime.tick()
    expect(fixture.runtime.ledger.view().trades).toHaveLength(1)
  })

  it('retains the actual execution depth and fees when the quote differs from the forecast', async () => {
    const fixture = await engine()
    await seedEligible(fixture)
    fixture.interceptBook(async (token, count) => {
      if (token === 'yes-1000' && count === 2) fixture.setPrice(0.2)
    })
    await fixture.runtime.tick()
    const receipt = fixture.runtime.ledger.view().trades[0]
    expect(receipt).toBeDefined()
    const evidence = fixture.runtime.observation(receipt!.intent.evidenceRef)
    expect(evidence.book.asks[0]?.price).toBe(0.2)
    expect(quotePurchase(evidence.book, evidence.fees, receipt!.intent.quantity, fixture.config.paperSlippageBps)?.costMicros)
      .toBe(receipt!.intent.costMicros)
    await fixture.reopen()
    expect(fixture.runtime.observation(receipt!.intent.evidenceRef)).toEqual(evidence)
  })

  it('recovers a crash between research settlement and account settlement without paying twice', async () => {
    const fixture = await engine()
    await seedEligible(fixture)
    await fixture.runtime.tick()
    const forecast = fixture.runtime.experiments.view().forecasts.find(item => item.observation.tokenId === 'yes-1000')!
    fixture.advance(5)
    // This is the durable prefix immediately before the second owner commits its payout.
    await fixture.runtime.experiments.settle({
      eventId: forecast.observation.eventId, marketId: forecast.observation.marketId, tokenId: forecast.observation.tokenId,
      payout: 0.5, resolvedAt: fixture.now,
      source: new URL('/markets', fixture.config.data.gammaUrl).href,
    })
    fixture.resolved.set(1000, 0.5)
    await fixture.reopen()
    fixture.resolved.set(1000, 1)
    await expect(fixture.runtime.tick()).rejects.toThrow(/conflict|different|changed|immutable|payout/i)
    expect(fixture.runtime.ledger.view().cashMicros).toBe(99_000_000)
    fixture.resolved.set(1000, 0.5)
    await fixture.runtime.tick()
    const settled = fixture.runtime.ledger.view()
    expect(settled).toMatchObject({ cashMicros: 104_000_000, realizedProfitMicros: 4_000_000, positions: [] })
    expect(settled.settlements).toHaveLength(1)
    await fixture.reopen()
    await fixture.runtime.tick()
    expect(fixture.runtime.ledger.view()).toEqual(settled)
  })

  it('refuses to settle a durable position whose independent observation store lost its market evidence', async () => {
    const fixture = await engine()
    await seedEligible(fixture)
    await fixture.runtime.tick()
    const forecast = fixture.runtime.experiments.view().forecasts.find(item => item.observation.tokenId === 'yes-1000')!
    fixture.advance(5)
    await fixture.runtime.experiments.settle({
      eventId: forecast.observation.eventId, marketId: forecast.observation.marketId, tokenId: forecast.observation.tokenId,
      payout: 0.5, resolvedAt: fixture.now, source: new URL('/markets', fixture.config.data.gammaUrl).href,
    })
    await fixture.runtime.close()
    // Independent domain loss can leave a valid account file without the data needed to reconcile it.
    const domain = await fixture.deps.storageDomain.open(runtimeDomain)
    for (const [id, observation] of domain.table('observations').entries()) {
      if (observation.market.id === forecast.observation.marketId) await domain.table('observations').delete(id)
    }
    await domain.close()
    fixture.setMarkets([])
    await fixture.reopen()
    await expect(fixture.runtime.tick()).rejects.toThrow(/Paper position has no retained market evidence/)
    expect(fixture.runtime.ledger.view()).toMatchObject({ cashMicros: 99_000_000, settlements: [] })
  })

  it('refuses a changed durable quote instead of using its fabricated low price', async () => {
    const fixture = await engine()
    await fixture.runtime.tick()
    const retained = observationFor(fixture, 'yes-1')
    await fixture.runtime.close()
    const path = join(fixture.root, 'rsi_runtime.json')
    const document = JSON.parse(await readFile(path, 'utf8')) as { tables: { observations: Record<string, Observation> } }
    document.tables.observations[retained.id]!.averageCostMicros = 1
    await writeFile(path, `${JSON.stringify(document)}\n`)
    await expect(fixture.reopen()).rejects.toThrow()
  })

  it('proves retained costs, baseline, and market ownership from the hashed public observations', async () => {
    const fixture = await engine()
    await fixture.runtime.tick()
    const source = observationFor(fixture, 'yes-1')
    const original = createObservation(source.market, source.book, source.fees, 5, 25)
    expect(original).not.toBeNull()
    expect(observationSchema.parse(original)).toEqual(original)
    const mutations: Array<[string, (value: Observation) => void]> = [
      ['content hash', (value) => { value.id = 'f'.repeat(64) }],
      ['cost differs', (value) => { value.costMicros++ }],
      ['cost differs', (value) => { value.averageCostMicros++ }],
      ['cost differs', (value) => { value.book.asks.length = 0 }],
      ['baseline differs', (value) => { value.baselineProbability = 0.5 }],
      ['baseline differs', (value) => { value.book.bids.length = 0 }],
      ['ownership differ', (value) => { value.book.tokenId = brandString<TokenId>('unowned-token') }],
    ]
    for (const [message, mutate] of mutations) {
      const value = structuredClone(original!)
      mutate(value)
      const result = observationSchema.safeParse(value)
      expect(result.success).toBe(false)
      if (!result.success) expect(result.error.message).toContain(message)
    }
    expect(createObservation(source.market, { ...source.book, asks: [] }, source.fees, 5, 0)).toBeNull()
    expect(createObservation(source.market, { ...source.book, bids: [] }, source.fees, 5, 0)).toBeNull()
    expect(() => createObservation({ ...source.market, tokens: [] }, source.book, source.fees, 5, 0)).toThrow(/ownership/)
  })

  it('cancels and joins collection during close and rejects commands after writer loss', async () => {
    const fixture = await engine()
    const entered = Promise.withResolvers<undefined>()
    fixture.interceptBook(async (_token, _count, signal) => {
      entered.resolve(undefined)
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('Transport aborted', { cause: signal.reason })) }, { once: true })
      })
    })
    const result = fixture.runtime.tick().then(() => null, (error: unknown) => error)
    await entered.promise
    await fixture.runtime.close()
    expect(await result).toBeInstanceOf(Error)
    expect(() => fixture.runtime.tick()).toThrow(/stopped/)
    await fixture.reopen()
    fixture.loseWriter()
    await expect(fixture.runtime.registerCandidate({})).rejects.toThrow(/Writer lease lost/)
  })

  it('cancels one caller tick without closing the runtime or preventing a later collection', async () => {
    const fixture = await engine()
    const caller = new AbortController()
    const entered = Promise.withResolvers<undefined>()
    fixture.interceptBook(async (_token, _count, signal) => {
      entered.resolve(undefined)
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('Caller cancelled transport')) }, { once: true })
      })
    })
    const cancelled = fixture.runtime.tick(caller.signal).then(() => null, (error: unknown) => error)
    await entered.promise
    caller.abort(new Error('Caller cancelled this tick'))
    expect(await cancelled).toMatchObject({ message: 'Caller cancelled this tick' })
    fixture.interceptBook(undefined)
    expect(await fixture.runtime.tick()).toMatchObject({ observations: 2, skipped: 0 })
    expect(fixture.runtime.ledger.view().cashMicros).toBe(100_000_000)
  })

  it('rejects changed event and condition ownership before sizing from current metadata', async () => {
    const fixture = await engine()
    await seedEligible(fixture)
    fixture.patchMarket({ events: [{ id: 'different-event' }] })
    await expect(fixture.runtime.tick()).rejects.toThrow(/Current market ownership/)
    fixture.patchMarket({ conditionId: 'different-condition' })
    await expect(fixture.runtime.tick()).rejects.toThrow(/Current market ownership/)
    expect(fixture.runtime.ledger.view().trades).toEqual([])
  })

  it('skips forecast fills for inadequate current depth, edge, fee cost, and executable midpoint', async () => {
    const fixture = await engine()
    await seedEligible(fixture)
    const scenarios = [
      { asks: [] },
      { asks: [{ price: '1', size: '1000' }] },
      { asks: [{ price: '0.84', size: '1000' }] },
      { asks: [{ price: '0.1', size: '1' }] },
      { asks: [{ price: '0.1', size: '1' }, { price: '0.2', size: '1000' }] },
      { bids: [] },
    ]
    for (const patch of scenarios) {
      fixture.patchBook({})
      fixture.interceptBook(async (token, count) => {
        if (token === 'yes-1000' && count === 2) fixture.patchBook(patch)
      })
      await fixture.runtime.tick()
      expect(fixture.runtime.ledger.view().trades, JSON.stringify(patch)).toEqual([])
    }
  })

  it('rechecks the advantage of all requested shares even when their total debit fits the budget', async () => {
    const fixture = await engine()
    await seedEligible(fixture, { liveProbability: 0.4 })
    fixture.interceptBook(async (token, count) => {
      if (token === 'yes-1000' && count === 2) fixture.patchBook({
        asks: [{ price: '0.29', size: '1' }, { price: '0.32', size: '1000' }],
      })
    })
    await fixture.runtime.tick()
    expect(fixture.runtime.ledger.view().trades).toEqual([])
  })

  it('shares the event exposure limit across independently eligible candidates', async () => {
    const fixture = await engine()
    await seedEligible(fixture, { secondCandidate: true })
    expect(fixture.runtime.experiments.rank().filter(candidate => candidate.status === 'paper-eligible')).toHaveLength(2)
    await fixture.runtime.tick()
    expect(fixture.runtime.ledger.view()).toMatchObject({ committedCostMicros: 1_000_000, cashMicros: 99_000_000 })
    expect(fixture.runtime.ledger.view().trades).toHaveLength(1)
  })

  it('requires room for retained execution evidence before debiting paper capital', async () => {
    const fixture = await engine({ maxObservations: 84 })
    await seedEligible(fixture)
    await expect(fixture.runtime.tick()).rejects.toThrow(/Execution evidence capacity/)
    expect(fixture.runtime.ledger.view().trades).toEqual([])
  })

  it('discards forecasts already expired before fresh collection begins', async () => {
    const fixture = await engine({ maxForecastAge: 1000 })
    await seedEligible(fixture)
    fixture.advance(1001)
    await fixture.runtime.tick()
    expect(fixture.runtime.ledger.view().trades).toEqual([])
  })

  it('refreshes expired quote evidence while retaining a still-valid forecast', async () => {
    const fixture = await engine({ maxAge: 1000, maxForecastAge: 10_000 })
    await seedEligible(fixture)
    fixture.advance(1001)
    await fixture.runtime.tick()
    expect(fixture.runtime.ledger.view().trades).toHaveLength(1)
    const trade = fixture.runtime.ledger.view().trades[0]!
    expect(trade.intent.observedAt - trade.intent.assessment!.forecastReceivedAt).toBeGreaterThan(1000)
  })

  it('uses prospective revisions for execution without changing qualification or buying an event twice', async () => {
    const fixture = await engine()
    await seedEligible(fixture)
    const anchor = fixture.runtime.experiments.view().forecasts.find(item => item.observation.tokenId === 'yes-1000')!
    const ranks = fixture.runtime.experiments.rank()
    await fixture.runtime.forecast(anchor.observation.observationId, {
      candidateId: anchor.candidateId, probability: 0.01, uncertainty: 0, evidence: [],
    })
    await fixture.runtime.tick()
    expect(fixture.runtime.ledger.view().trades).toEqual([])
    expect(fixture.runtime.experiments.rank()).toEqual(ranks)
    const observation = observationFor(fixture, 'yes-1000')
    await fixture.runtime.forecast(observation.id, {
      candidateId: anchor.candidateId, probability: 0.95, uncertainty: 0, evidence: [],
    })
    await fixture.runtime.tick()
    expect(fixture.runtime.ledger.view().trades).toHaveLength(1)
    expect(fixture.runtime.ledger.view().trades[0]!.intent.assessment)
      .toMatchObject({ probability: 0.95, forecastRevision: 2 })
    await fixture.runtime.forecast(observationFor(fixture, 'yes-1000').id, {
      candidateId: anchor.candidateId, probability: 0.96, uncertainty: 0, evidence: [],
    })
    await fixture.runtime.tick()
    expect(fixture.runtime.ledger.view().trades).toHaveLength(1)
    expect(fixture.runtime.experiments.rank()).toEqual(ranks)
  })

  it('does not execute resolved forecasts even if discovery still calls their market active', async () => {
    const fixture = await engine()
    await seedEligible(fixture)
    fixture.resolved.set(1000, 1)
    await fixture.runtime.tick()
    expect(fixture.runtime.experiments.view().settlements).toHaveLength(41)
    expect(fixture.runtime.ledger.view().trades).toEqual([])
  })

  it('keeps unproven candidates in cash and applies the configured delay to admitted paper execution', async () => {
    const fixture = await engine({ paperExecutionDelayMs: 20 })
    await fixture.runtime.tick()
    const candidate = await fixture.runtime.registerCandidate({ name: 'unproven', thesis: 'No outcome evidence', minEdge: 0.05, kellyFraction: 0.1 })
    await fixture.runtime.forecast(observationFor(fixture, 'yes-1').id, {
      candidateId: candidate.id, probability: 0.9, uncertainty: 0.05, evidence: [],
    })
    await fixture.runtime.control({ expectedRevision: 0, action: 'resume', reason: 'Paper fixture' })
    await fixture.runtime.tick()
    expect(fixture.runtime.ledger.view().trades).toEqual([])
    await fixture.runtime.close()
    const eligible = await engine({ paperExecutionDelayMs: 20 })
    await seedEligible(eligible)
    await eligible.runtime.tick()
    expect(eligible.runtime.ledger.view().trades).toHaveLength(1)
  })
})

describe('durable autonomous research allowance', () => {
  it('researches durable upstream failures without converting the tick to success or bypassing the daily cap', async () => {
    const diagnostics: Array<{ error: string | null; runs: number }> = []
    const fixture = await engine({ researchDriver: async () => {
      const state = fixture.runtime.status()
      diagnostics.push({ error: state.lastTickError, runs: state.research.runs.length })
      return { sessionId: 'upstream-failure-investigation' }
    } })
    fixture.failDiscovery(new Error('Public data endpoint is unavailable'))
    const completed = fixture.waitState(state => state.researchRuns[0]?.state === 'completed')
    await expect(fixture.runtime.tick()).rejects.toThrow('Public data endpoint is unavailable')
    await completed
    expect(diagnostics).toEqual([{ error: 'Public data endpoint is unavailable', runs: 1 }])
    expect(fixture.runtime.status().research.runs[0]).toMatchObject({
      state: 'completed', sessionId: 'upstream-failure-investigation',
    })
    await fixture.reopen()
    fixture.advance(100)
    await expect(fixture.runtime.tick()).rejects.toThrow('Public data endpoint is unavailable')
    expect(diagnostics).toHaveLength(1)
    expect(fixture.runtime.status().research.runs).toHaveLength(1)
    expect(fixture.runtime.ledger.view().cashMicros).toBe(100_000_000)
  })

  it('counts failed and interrupted runs against the same daily allowance after restart', async () => {
    const entered = Promise.withResolvers<undefined>()
    let starts = 0
    const fixture = await engine({ researchDriver: async () => {
      starts++
      entered.resolve(undefined)
      throw new Error('Synthetic model failure')
    } })
    fixture.setMarkets([])
    await fixture.runtime.tick()
    await entered.promise
    await fixture.runtime.close()
    expect(fixture.errors).toHaveLength(1)
    const path = join(fixture.root, 'rsi_runtime.json')
    const document = JSON.parse(await readFile(path, 'utf8')) as { tables: { state: { state: RuntimeState } } }
    expect(document.tables.state.state.researchRuns[0]?.state).toBe('failed')
    const run = document.tables.state.state.researchRuns[0]!
    run.state = 'running'
    run.finishedAt = null
    run.error = null
    await writeFile(path, `${JSON.stringify(document)}\n`)
    fixture.advance(100)
    await fixture.reopen()
    await fixture.runtime.tick()
    expect(starts).toBe(1)
    expect(fixture.runtime.status().research.runs[0]?.state).toBe('interrupted')
  })

  it('retains multiple completed and failed runs while enforcing the minimum interval', async () => {
    let runs = 0
    const fixture = await engine({ maxRunsPerDay: 4, researchIntervalMs: 100, researchDriver: async () => {
      runs++
      if (runs === 2) throw new Error('Second synthetic research failed')
      return { sessionId: `research-session-${runs}` }
    } })
    fixture.setMarkets([])
    const first = fixture.waitState(state => state.researchRuns[0]?.state === 'completed')
    await fixture.runtime.tick()
    expect((await first).researchRuns[0]).toMatchObject({ sessionId: 'research-session-1', state: 'completed' })
    await fixture.reopen()
    await fixture.runtime.tick()
    expect(runs).toBe(1)
    fixture.advance(100)
    const second = fixture.waitState(state => state.researchRuns[1]?.state === 'failed')
    await fixture.runtime.tick()
    expect((await second).researchRuns.map(run => run.state)).toEqual(['completed', 'failed'])
    await fixture.reopen()
    fixture.advance(100)
    const third = fixture.waitState(state => state.researchRuns[2]?.state === 'completed')
    await fixture.runtime.tick()
    expect((await third).researchRuns.map(run => run.state)).toEqual(['completed', 'failed', 'completed'])
  })

  it('does not start research without a driver or without a durable admission receipt', async () => {
    const missing = await engine({ researchEnabled: true })
    missing.setMarkets([])
    await expect(missing.runtime.tick()).rejects.toThrow(/no configured driver/)
    await missing.runtime.close()
    let starts = 0
    const fixture = await engine({ researchDriver: async () => { starts++; return { sessionId: 'unused' } } })
    fixture.setMarkets([])
    fixture.failStateAt(2)
    const reported = Promise.withResolvers<undefined>()
    const originalReport = fixture.deps.reportError.bind(fixture.deps)
    fixture.deps.reportError = (error) => { originalReport(error); reported.resolve(undefined) }
    await fixture.runtime.tick()
    await reported.promise
    expect(starts).toBe(0)
    expect(fixture.runtime.status().research.runs).toEqual([])
    expect(fixture.errors[0]).toMatchObject({ message: 'Injected runtime state write failure' })
  })

  it('admits only one active research run and joins its cancellation', async () => {
    let starts = 0
    const entered = Promise.withResolvers<undefined>()
    const fixture = await engine({ maxRunsPerDay: 4, researchDriver: async (_run, signal) => {
      starts++
      entered.resolve(undefined)
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('Research cancelled')) }, { once: true })
      })
      return { sessionId: 'cancelled' }
    } })
    fixture.setMarkets([])
    await fixture.runtime.tick()
    await entered.promise
    fixture.advance(100)
    await fixture.runtime.tick()
    expect(starts).toBe(1)
    await fixture.runtime.close()
    expect(fixture.errors[0]).toMatchObject({ message: 'Research cancelled' })
  })

  it('does not launch research when shutdown races with the durable tick receipt', async () => {
    let starts = 0
    const fixture = await engine({ researchDriver: async () => { starts++; return { sessionId: 'unused' } } })
    fixture.setMarkets([])
    let closing: Promise<void> | undefined
    fixture.ctx.on('domain/changed', (change) => {
      if (change.domain === runtimeDomain.name && change.table === 'state' && change.operation === 'put') {
        closing = fixture.runtime.close()
      }
    })
    await fixture.runtime.tick()
    await closing
    expect(starts).toBe(0)
  })
})

describe('runtime collection failure containment', () => {
  it('bounds duplicate resource requests and preserves their identities after reload', async () => {
    const fixture = await engine()
    const [one, duplicate] = await Promise.all([
      fixture.runtime.requestResource('data', 'Official feed access', 10),
      fixture.runtime.requestResource('data', 'Official feed access', 10),
    ])
    expect(duplicate).toEqual(one)
    expect(await fixture.runtime.requestResource('data', 'Official feed access', 10)).toEqual(one)
    await fixture.runtime.requestResource('compute', 'Larger research worker', 20)
    await expect(fixture.runtime.requestResource('wallet', 'Dedicated paper wallet', 0)).rejects.toThrow(/capacity/)
    await fixture.reopen()
    expect(fixture.runtime.status().requests).toHaveLength(2)
    expect(() => fixture.runtime.observation('unknown')).toThrow(/Unknown observation/)
  })

  it('releases every acquired domain when initialization fails at each durable owner', async () => {
    const fixture = await engine()
    await fixture.runtime.close()
    const changedCapital = structuredClone(fixture.config)
    changedCapital.ledger.initialCapitalMicros = 101_000_000
    await expect(RsiRuntime.open(changedCapital, fixture.deps)).rejects.toThrow(/original allocation/)
    const changedEvaluation = structuredClone(fixture.config)
    changedEvaluation.experiments.maxCandidates = 3
    await expect(RsiRuntime.open(changedEvaluation, fixture.deps)).rejects.toThrow(/persisted configuration/)
    const domain = await fixture.deps.storageDomain.open(runtimeDomain)
    await domain.table('state').delete('state')
    await domain.close()
    fixture.failStateWrites(1)
    await expect(fixture.reopen()).rejects.toThrow(/state write failure/)
    await fixture.reopen()
    expect(fixture.runtime.status()).toMatchObject({ observationCount: 0, status: 'paused' })
  })

  it('retains the previous tick receipt when its state write fails and normalizes external non-Error failures', async () => {
    const fixture = await engine()
    fixture.setMarkets([])
    fixture.failStateWrites(1)
    await expect(fixture.runtime.tick()).rejects.toThrow(/state write failure/)
    expect(fixture.runtime.status().lastTickError).toBeNull()
    fixture.failDiscovery('Unstructured upstream failure')
    await expect(fixture.runtime.tick()).rejects.toThrow('Unstructured upstream failure')
    expect(fixture.runtime.status().lastTickError).toBe('Unstructured upstream failure')
    fixture.failDiscovery(undefined)
    await fixture.runtime.tick()
    expect(fixture.runtime.status().lastTickError).toBeNull()
  })

  it('skips ended, unfillable, and unsupported-cost markets without inventing observations', async () => {
    const fixture = await engine()
    fixture.patchMarket({ endDate: new Date(fixture.now).toISOString() })
    expect(await fixture.runtime.tick()).toMatchObject({ observations: 0, skipped: 1 })
    fixture.patchMarket({})
    fixture.patchBook({ asks: [] })
    expect(await fixture.runtime.tick()).toMatchObject({ observations: 0, skipped: 2 })
    fixture.patchBook({ bids: [] })
    expect(await fixture.runtime.tick()).toMatchObject({ observations: 0, skipped: 2 })
    fixture.patchBook({})
    fixture.setPrice(1)
    expect(await fixture.runtime.tick()).toMatchObject({ observations: 0, skipped: 2 })
    fixture.setPrice(0.1)
    fixture.patchFees({ mbf: 1 })
    expect(await fixture.runtime.tick()).toMatchObject({ observations: 0, skipped: 2 })
    expect(fixture.runtime.status().observationCount).toBe(0)
  })

  it('rejects foreign books and stale or future snapshots while capping per-tick diagnostics', async () => {
    const fixture = await engine({ statusLimit: 1 })
    fixture.setMarkets([1, 2])
    fixture.patchBook({ market: 'foreign-condition' })
    const foreign = await fixture.runtime.tick()
    expect(foreign).toMatchObject({ observations: 0, skipped: 2 })
    expect(foreign.errors).toEqual(['Book belongs to another market'])
    fixture.patchBook({ timestamp: String(fixture.now - fixture.config.maxObservationAgeMs - 1) })
    expect((await fixture.runtime.tick()).errors).toEqual(['Observation is stale or dated in the future'])
    fixture.patchBook({ timestamp: String(fixture.now + 1) })
    expect((await fixture.runtime.tick()).errors).toEqual(['Observation is stale or dated in the future'])
  })

  it('stops retaining observations at capacity and denies newly expired markets after data latency', async () => {
    const fixture = await engine({ maxObservations: 1 })
    expect(await fixture.runtime.tick()).toMatchObject({ observations: 1, skipped: 1 })
    expect(fixture.runtime.status().lastTickError).toMatch(/Observation capacity/)
    fixture.patchMarket({ endDate: new Date(fixture.now + 1).toISOString() })
    fixture.interceptBook(async () => { fixture.advance(2) })
    expect((await fixture.runtime.tick()).errors).toEqual(['Market is not open for prospective trading'])
    expect(fixture.runtime.status().observationCount).toBe(1)
  })

  it('runs the opt-in timer once, reports failures, reschedules, and cancels the active timer tick on close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fixture = await engine({ autoTick: true })
    fixture.failDiscovery(new Error('First timer collection failed'))
    const reported = Promise.withResolvers<undefined>()
    const report = fixture.deps.reportError.bind(fixture.deps)
    fixture.deps.reportError = (error) => { report(error); reported.resolve(undefined) }
    fixture.runtime.start()
    fixture.runtime.start()
    await vi.advanceTimersByTimeAsync(0)
    await reported.promise
    await Promise.resolve()
    expect(fixture.errors).toHaveLength(1)
    expect(fixture.calls.filter(url => url.pathname === '/markets')).toHaveLength(1)
    fixture.failDiscovery(undefined)
    const entered = Promise.withResolvers<undefined>()
    fixture.interceptBook(async (_token, _count, signal) => {
      entered.resolve(undefined)
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('Timer tick cancelled')) }, { once: true })
      })
    })
    fixture.advance(fixture.config.tickIntervalMs)
    await vi.advanceTimersByTimeAsync(fixture.config.tickIntervalMs)
    await entered.promise
    await fixture.runtime.close()
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('contains synchronous lease loss on timer dispatch and stops future automatic admission', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fixture = await engine({ autoTick: true })
    const closed = Promise.withResolvers<undefined>()
    const close = fixture.runtime.close.bind(fixture.runtime)
    vi.spyOn(fixture.runtime, 'close').mockImplementation(async () => { await close(); closed.resolve(undefined) })
    fixture.runtime.start()
    fixture.loseWriter()
    await vi.advanceTimersByTimeAsync(0)
    await closed.promise
    expect(fixture.errors[0]).toMatchObject({ message: 'Writer lease lost' })
    expect(fixture.calls).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
