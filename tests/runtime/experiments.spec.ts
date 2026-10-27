import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { Experiments } from '../../src/runtime/strategy/experiments.ts'
import { candidateVersion, experimentStateSchema } from '../../src/runtime/strategy/experiment-schema.ts'
import { forecastRevision, latestForecasts, primaryForecast, qualificationForecasts } from '../../src/runtime/strategy/forecasts.ts'
import type { CandidateId, ResearchObservationId } from '../../src/runtime/strategy/experiment-schema.ts'
import type { CandidateInput, ExperimentConfig, ExperimentState, ForecastObservation, ResearchSettlement } from '../../src/runtime/strategy/experiment-types.ts'
import type { EventId, MarketId, TokenId } from '../../src/runtime/data/market.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

const config: ExperimentConfig = {
  minResolvedEvents: 20, maxCandidates: 4, maxForecasts: 1000,
  confidenceAlpha: 0.05, maxEvidenceBytes: 1024,
}
const policy: CandidateInput = { name: 'weather', thesis: 'Prospective ensemble probabilities', minEdge: 0.05, kellyFraction: 0.1 }

async function harness(options: {
  config?: Partial<ExperimentConfig>
  pool?: MemoryMediaPool
  clock?: () => number
  mutationGuard?: () => void
} = {}) {
  const ctx = new Context()
  cleanup.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(options.pool)
  ctx.storage.backend.register('memory', backend)
  cleanup.push(async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  cleanup.push(async () => { await facility.closeAll() })
  let now = 1000
  const currentConfig = { ...config, ...options.config }
  const registry = await Experiments.open(facility, currentConfig, options.clock ?? (() => now), options.mutationGuard)
  return { registry, facility, pool: backend.pool, config: currentConfig, setTime: (value: number) => { now = value } }
}

function quote(index = 1): ForecastObservation {
  return {
    observationId: brandString<ResearchObservationId>(`observation-${index}`),
    observedAt: 1000,
    eventId: brandString<EventId>(`event-${index}`),
    marketId: brandString<MarketId>(`market-${index}`),
    tokenId: brandString<TokenId>(`token-${index}`),
    eventEndsAt: 2000,
    costMicros: 100_000,
    baselineProbability: 0.2,
  }
}

function outcome(index = 1, payout = 1): ResearchSettlement {
  const observed = quote(index)
  return {
    eventId: observed.eventId, marketId: observed.marketId, tokenId: observed.tokenId,
    payout, resolvedAt: 2000, source: 'https://polymarket.com/event/weather',
  }
}

function estimate(candidateId: CandidateId, probability = 0.9, uncertainty = 0.05) {
  return { candidateId, probability, uncertainty, evidence: [{ url: 'https://weather.gov/', text: 'Ensemble report' }] }
}

describe('prospective research registry', () => {
  it('retains every candidate version and consumes a bounded budget atomically', async () => {
    const { registry } = await harness({ config: { maxCandidates: 2 } })
    const [first, duplicate] = await Promise.all([registry.registerCandidate(policy), registry.registerCandidate({ ...policy })])
    expect(duplicate).toEqual(first)
    const second = await registry.registerCandidate({ ...policy, minEdge: 0.06 })
    expect(second.id).not.toBe(first.id)
    await expect(registry.registerCandidate({ ...policy, thesis: 'Another hypothesis' })).rejects.toThrow(/budget exhausted/)
    expect(registry.view().candidates.map(item => item.id)).toEqual([first.id, second.id])
    expect(registry.rank().map(item => item.status)).toEqual(['collecting', 'collecting'])
  })

  it('derives versions from all policy fields and does not retain mutable caller objects', async () => {
    const { registry } = await harness()
    const mutable = { ...policy, maxEventHorizonMs: 10_000 }
    const candidate = await registry.registerCandidate(mutable)
    mutable.thesis = 'Changed caller memory'
    candidate.minEdge = 0.99
    const detached = registry.view()
    detached.candidates.length = 0
    expect(registry.view().candidates[0]).toMatchObject({ thesis: policy.thesis, minEdge: policy.minEdge })
    expect(candidateVersion({ ...policy, maxEventHorizonMs: 10_000 })).not.toBe(candidateVersion({ ...policy, maxEventHorizonMs: 20_000 }))
  })

  it('preserves candidate ancestry and source revisions in immutable version identities', async () => {
    const { registry, setTime } = await harness()
    const parent = await registry.registerCandidate(policy)
    await expect(registry.registerCandidate({ ...policy, parentId: brandString<CandidateId>('f'.repeat(64)) }))
      .rejects.toThrow(/parent must be a registered/)
    setTime(1100)
    const derived = await registry.registerCandidate({ ...policy, parentId: parent.id })
    const source = await registry.registerCandidate({ ...policy, sourceCommit: 'a'.repeat(40) })
    const both = await registry.registerCandidate({ ...policy, parentId: derived.id, sourceCommit: 'a'.repeat(40) })
    expect(new Set([parent.id, derived.id, source.id, both.id]).size).toBe(4)
    const valid = registry.view()
    expect(experimentStateSchema.safeParse(valid).success).toBe(true)
    for (const corrupt of [
      (state: ExperimentState) => { state.candidates[0]!.registeredAt = 1200 },
      (state: ExperimentState) => { state.candidates.shift() },
      (state: ExperimentState) => { state.candidates[1]!.parentId = derived.id },
    ]) {
      const state = structuredClone(valid)
      corrupt(state)
      const parsed = experimentStateSchema.safeParse(state)
      expect(parsed.success).toBe(false)
      if (!parsed.success) expect(parsed.error.message).toContain('candidate parent is absent or newer')
    }
  })

  it('admits exactly one first forecast across correlated markets and concurrent requests', async () => {
    const { registry } = await harness()
    const candidate = await registry.registerCandidate(policy)
    const results = await Promise.allSettled([
      registry.recordForecast(estimate(candidate.id), quote()),
      registry.recordForecast(estimate(candidate.id, 0.95), { ...quote(2), eventId: quote().eventId }),
    ])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(registry.view().forecasts).toHaveLength(1)
    expect(registry.view().forecasts[0]).toMatchObject({ probability: 0.9, receivedAt: 1000 })
  })

  it('rejects model timestamps, historical deadlines, future observations, and unknown candidates', async () => {
    const { registry, setTime } = await harness()
    const candidate = await registry.registerCandidate(policy)
    await expect(registry.recordForecast(Object.assign(estimate(candidate.id), { receivedAt: 1 }), quote()))
      .rejects.toThrow(/Unrecognized key/)
    await expect(registry.recordForecast(estimate(candidate.id), { ...quote(), observedAt: 1001 }))
      .rejects.toThrow(/precede the event deadline/)
    await expect(registry.recordForecast(estimate(brandString<CandidateId>('f'.repeat(64))), quote()))
      .rejects.toThrow(/not registered/)
    setTime(999)
    await expect(registry.recordForecast(estimate(candidate.id), { ...quote(), observedAt: 900 })).rejects.toThrow(/registration/)
    setTime(2000)
    await expect(registry.recordForecast(estimate(candidate.id), quote())).rejects.toThrow(/precede the event deadline/)
    expect(registry.view().forecasts).toEqual([])
  })

  it('enforces evidence, forecast and quoted-cost admission limits', async () => {
    const { registry } = await harness({ config: { maxForecasts: 1 } })
    const candidate = await registry.registerCandidate(policy)
    await expect(registry.registerCandidate({ ...policy, thesis: 'x'.repeat(1025) })).rejects.toThrow(/text exceeds/)
    await expect(registry.recordForecast({ ...estimate(candidate.id), evidence: [{ url: 'https://weather.gov/', text: 'x'.repeat(1025) }] }, quote())).rejects.toThrow(/evidence exceeds/)
    await expect(registry.recordForecast(estimate(candidate.id), { ...quote(), costMicros: 0 })).rejects.toThrow()
    await expect(registry.recordForecast(estimate(candidate.id), { ...quote(), costMicros: 1_000_000 })).rejects.toThrow()
    await registry.recordForecast(estimate(candidate.id), quote())
    await expect(registry.recordForecast(estimate(candidate.id), quote(2))).rejects.toThrow(/forecast budget/)
  })

  it('retains below-edge primaries without adding later estimates to the qualification sample', async () => {
    const { registry } = await harness()
    const candidate = await registry.registerCandidate(policy)
    const primary = await registry.recordForecast(estimate(candidate.id, 0.1, 0.1), quote())
    await registry.recordForecast(estimate(candidate.id), quote())
    const state = registry.view()
    expect(state.forecasts).toEqual([primary])
    expect(state.forecastRevisions).toHaveLength(1)
    expect(qualificationForecasts(state, candidate.id)).toEqual([])
    expect(registry.rank()[0]).toMatchObject({ forecastEvents: 0, evaluatedEvents: 0, status: 'collecting' })
  })

  it('appends concurrent revisions while keeping primary scores and purchase identity immutable', async () => {
    const { registry, setTime } = await harness()
    const candidate = await registry.registerCandidate(policy)
    const first = await registry.recordForecast(estimate(candidate.id), quote())
    const other = await registry.recordForecast(estimate(candidate.id), quote(2))
    setTime(1200)
    const revised = { ...quote(), observationId: brandString<ResearchObservationId>('refreshed'), observedAt: 1100 }
    const revisions = await Promise.all([
      registry.recordForecast(estimate(candidate.id, 0.2, 0), revised),
      registry.recordForecast(estimate(candidate.id, 0.3, 0), revised),
    ])
    expect(revisions.map(forecastRevision)).toEqual([1, 2])
    const state = registry.view()
    expect(state.forecasts).toEqual([first, other])
    expect(state.forecastRevisions).toEqual(revisions)
    expect(latestForecasts(state)).toEqual([revisions[1], other])
    expect(primaryForecast(state, revisions[1])).toEqual(first)
    expect(forecastRevision(first)).toBe(0)
    setTime(2001)
    await registry.settle(outcome())
    expect(registry.rank()[0]).toMatchObject({ forecastEvents: 2, evaluatedEvents: 1, meanNetAdvantage: 0.9 })
    expect(registry.rank()[0]!.brierScore).toBeCloseTo(0.01)
    expect(experimentStateSchema.safeParse(registry.view()).success).toBe(true)
  })

  it('shares the forecast cap across primaries and updates without publishing failed writes', async () => {
    const { registry, pool } = await harness({ config: { maxForecasts: 2 } })
    const candidate = await registry.registerCandidate(policy)
    await registry.recordForecast(estimate(candidate.id), quote())
    pool.failNextWrites = 1
    await expect(registry.recordForecast(estimate(candidate.id, 0.6), quote())).rejects.toThrow(/injected/)
    expect(registry.view().forecastRevisions).toEqual([])
    await registry.recordForecast(estimate(candidate.id, 0.7), quote())
    await expect(registry.recordForecast(estimate(candidate.id, 0.8), quote())).rejects.toThrow(/forecast budget/)
    await expect(registry.recordForecast(estimate(candidate.id), quote(2))).rejects.toThrow(/forecast budget/)
    expect(registry.view().forecastRevisions[0]).toMatchObject({ revision: 1, probability: 0.7 })
  })

  it('rejects revisions that change outcomes, move backwards or extend an expired primary', async () => {
    const { registry, setTime } = await harness()
    const candidate = await registry.registerCandidate(policy)
    await registry.recordForecast(estimate(candidate.id), quote())
    await expect(registry.recordForecast(estimate(candidate.id), { ...quote(), tokenId: quote(2).tokenId }))
      .rejects.toThrow(/primary market and token/)
    setTime(1200)
    await registry.recordForecast(estimate(candidate.id, 0.7), quote())
    setTime(1100)
    await expect(registry.recordForecast(estimate(candidate.id, 0.6), quote())).rejects.toThrow(/previous estimate/)
    setTime(2000)
    await expect(registry.recordForecast(estimate(candidate.id, 0.6), { ...quote(), eventEndsAt: 3000 }))
      .rejects.toThrow(/primary event deadline/)
    expect(registry.view().forecastRevisions).toHaveLength(1)
  })

  it('restores existing primary-only records and persists subsequent revisions across restart', async () => {
    const { registry, facility, pool, config: fixed } = await harness()
    const candidate = await registry.registerCandidate(policy)
    await registry.recordForecast(estimate(candidate.id), quote())
    const { forecastRevisions: _, ...legacy } = registry.view()
    await registry.close()
    pool.media.get('rsi_research')!.tables.get('research')!.set('state', legacy)
    const reopened = await Experiments.open(facility, fixed, () => 1100)
    expect(reopened.view().forecastRevisions).toEqual([])
    await reopened.recordForecast(estimate(candidate.id, 0.6), quote())
    const before = reopened.view()
    await reopened.close()
    const restored = await Experiments.open(facility, fixed, () => 1200)
    expect(restored.view()).toEqual(before)
    expect(latestForecasts(restored.view())[0]).toMatchObject({ revision: 1, probability: 0.6 })
  })

  it('rejects settlement timestamps that reveal an outcome-informed revision', async () => {
    const { registry, setTime } = await harness()
    const candidate = await registry.registerCandidate(policy)
    await registry.recordForecast(estimate(candidate.id), quote())
    setTime(1500)
    await registry.recordForecast(estimate(candidate.id, 0.8), quote())
    setTime(2001)
    await expect(registry.settle({ ...outcome(), resolvedAt: 1400 })).rejects.toThrow(/non-prospective/)
    expect(registry.view().settlements).toEqual([])
    await registry.settle(outcome())
    await expect(registry.recordForecast(estimate(candidate.id), { ...quote(), eventEndsAt: 3000 }))
      .rejects.toThrow(/known settlement/)
  })

  it('refuses corrupted revision ownership, sequence, times and sample budgets on durable reads', async () => {
    const { registry, setTime } = await harness()
    const candidate = await registry.registerCandidate(policy)
    await registry.recordForecast(estimate(candidate.id), quote())
    setTime(1200)
    await registry.recordForecast(estimate(candidate.id, 0.7), quote())
    setTime(2001)
    await registry.settle(outcome())
    const valid = registry.view()
    const corruptions: Array<[string, (state: ExperimentState) => void]> = [
      ['no primary', (state) => { state.forecasts = [] }],
      ['market or token', (state) => { state.forecastRevisions[0]!.observation.tokenId = quote(2).tokenId }],
      ['not prospective', (state) => { state.forecastRevisions[0]!.receivedAt = 999 }],
      ['not prospective', (state) => { state.forecastRevisions[0]!.receivedAt = 2000 }],
      ['not contiguous', (state) => { state.forecastRevisions[0]!.revision = 2 }],
      ['forecast budget', (state) => { state.config.maxForecasts = 1 }],
      ['does not follow', (state) => { state.settlements[0]!.resolvedAt = 1100 }],
    ]
    for (const [message, corrupt] of corruptions) {
      const state = structuredClone(valid)
      corrupt(state)
      const parsed = experimentStateSchema.safeParse(state)
      expect(parsed.success, message).toBe(false)
      if (!parsed.success) expect(parsed.error.message).toContain(message)
    }
  })

  it('limits the scheduled event horizon at admission and on durable reopen', async () => {
    const { registry } = await harness()
    const candidate = await registry.registerCandidate({ ...policy, maxEventHorizonMs: 500 })
    await expect(registry.recordForecast(estimate(candidate.id), quote())).rejects.toThrow(/event horizon/)
    await registry.recordForecast(estimate(candidate.id), { ...quote(), eventEndsAt: 1500 })
    const state = registry.view()
    expect(experimentStateSchema.safeParse(state).success).toBe(true)
    state.forecasts[0]!.observation.eventEndsAt = 1501
    const parsed = experimentStateSchema.safeParse(state)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.message).toContain('event horizon')
  })

  it('locks fractional settlements and blocks outcome-informed replacement and new sibling predictions', async () => {
    const { registry, setTime } = await harness()
    const candidate = await registry.registerCandidate(policy)
    await registry.recordForecast(estimate(candidate.id), quote())
    setTime(2001)
    await registry.settle(outcome(1, 0.5))
    await registry.settle(outcome(1, 0.5))
    await expect(registry.settle(outcome(1, 1))).rejects.toThrow(/immutable/)
    await expect(registry.recordForecast(estimate(candidate.id, 0.5), { ...quote(), eventEndsAt: 4000 }))
      .rejects.toThrow(/known settlement/)
    const next = await registry.registerCandidate({ ...policy, name: 'new version' })
    await expect(registry.recordForecast(estimate(next.id), { ...quote(2), eventId: quote().eventId, eventEndsAt: 4000 }))
      .rejects.toThrow(/known settlement/)
    expect(registry.rank()[0]).toMatchObject({ evaluatedEvents: 1, meanNetAdvantage: 0.4 })
    expect(registry.view().settlements).toHaveLength(1)
  })

  it('rejects settlement evidence that precedes a forecast or names the wrong event or token', async () => {
    const { registry, setTime } = await harness()
    const candidate = await registry.registerCandidate(policy)
    await registry.recordForecast(estimate(candidate.id), quote())
    await expect(registry.settle(outcome(2))).rejects.toThrow(/no registered forecast/)
    await expect(registry.settle(outcome())).rejects.toThrow(/future/)
    setTime(2001)
    await expect(registry.settle({ ...outcome(), eventId: quote(2).eventId })).rejects.toThrow(/does not match/)
    await expect(registry.settle({ ...outcome(), resolvedAt: 1000 })).rejects.toThrow(/non-prospective/)
    expect(registry.view().settlements).toEqual([])
  })

  it('keeps failed writes out of memory and preserves the complete evidence across reopen', async () => {
    const { registry, facility, pool, config: fixed, setTime } = await harness()
    pool.failNextWrites = 1
    await expect(registry.registerCandidate(policy)).rejects.toThrow(/injected/)
    expect(registry.view().candidates).toEqual([])
    const candidate = await registry.registerCandidate(policy)
    pool.failNextWrites = 1
    await expect(registry.recordForecast(estimate(candidate.id), quote())).rejects.toThrow(/injected/)
    expect(registry.view().forecasts).toEqual([])
    await registry.recordForecast(estimate(candidate.id), quote())
    setTime(2001)
    pool.failNextWrites = 1
    await expect(registry.settle(outcome())).rejects.toThrow(/injected/)
    expect(registry.view().settlements).toEqual([])
    await registry.settle(outcome(1, 0))
    const before = registry.view()
    await registry.close()
    const reopened = await Experiments.open(facility, fixed, () => 2001)
    expect(reopened.view()).toEqual(before)
    expect(reopened.rank()[0]).toMatchObject({ meanNetAdvantage: -0.1, status: 'collecting' })
  })

  it('refuses evaluator reconfiguration and releases a failed initialization for retry', async () => {
    const { registry, facility, pool, config: fixed } = await harness()
    await registry.close()
    await expect(Experiments.open(facility, { ...fixed, maxCandidates: fixed.maxCandidates + 1 }))
      .rejects.toThrow(/persisted configuration/)
    const reopened = await Experiments.open(facility, fixed)
    await reopened.close()
    pool.media.get('rsi_research')!.tables.get('research')!.delete('state')
    pool.failNextWrites = 1
    await expect(Experiments.open(facility, fixed)).rejects.toThrow(/injected/)
    await expect(Experiments.open(facility, fixed)).resolves.toBeInstanceOf(Experiments)
  })

  it('refuses changed candidate contents and duplicated event evidence on durable reload', async () => {
    const { registry, facility, pool, config: fixed } = await harness()
    const candidate = await registry.registerCandidate(policy)
    await registry.recordForecast(estimate(candidate.id), quote())
    const state = registry.view()
    expect(experimentStateSchema.safeParse(state).success).toBe(true)
    const mutated = structuredClone(state)
    mutated.candidates[0]!.minEdge = 0.06
    expect(experimentStateSchema.safeParse(mutated).success).toBe(false)
    const duplicated = structuredClone(state)
    duplicated.forecasts.push(duplicated.forecasts[0]!)
    expect(experimentStateSchema.safeParse(duplicated).success).toBe(false)
    await registry.close()
    pool.media.get('rsi_research')!.tables.get('research')!.set('state', mutated)
    await expect(Experiments.open(facility, fixed)).rejects.toMatchObject({ code: 'invalid-record' })
  })

  it('rejects corrupted durable sample budgets, identities, timestamps, costs, and outcomes', async () => {
    const { registry, setTime } = await harness()
    const candidate = await registry.registerCandidate(policy)
    await registry.recordForecast(estimate(candidate.id), quote())
    setTime(2001)
    await registry.settle(outcome())
    const valid = registry.view()
    const corruptions: Array<[string, (state: ExperimentState) => void]> = [
      ['candidate budget', (state) => { state.candidates.push(...Array.from({ length: 4 }, () => state.candidates[0]!)) }],
      ['forecast budget', (state) => { state.forecasts.push(...Array.from({ length: 1000 }, () => state.forecasts[0]!)) }],
      ['duplicate candidate', (state) => { state.candidates.push(state.candidates[0]!) }],
      ['candidate text budget', (state) => { state.config.maxEvidenceBytes = 1 }],
      ['forecast evidence budget', (state) => { state.forecasts[0]!.evidence[0]!.text = 'x'.repeat(1025) }],
      ['registration', (state) => { state.candidates.length = 0 }],
      ['registration', (state) => { state.candidates[0]!.registeredAt = 1001 }],
      ['not prospective', (state) => { state.forecasts[0]!.receivedAt = 2000 }],
      ['not prospective', (state) => { state.forecasts[0]!.observation.observedAt = 1001 }],
      ['duplicate token', (state) => { state.settlements.push(state.settlements[0]!) }],
      ['no registered forecast', (state) => { state.forecasts.length = 0 }],
      ['in the future', (state) => { state.settlements[0]!.resolvedAt = 2002 }],
      ['does not follow', (state) => { state.settlements[0]!.eventId = quote(2).eventId }],
      ['does not follow', (state) => { state.settlements[0]!.resolvedAt = 1000 }],
      ['known resolution', (state) => {
        const otherPolicy = { ...policy, name: 'late sibling' }
        const other = { ...otherPolicy, id: candidateVersion(otherPolicy), registeredAt: 1000 }
        state.candidates.push(other)
        state.forecasts.push({
          ...state.forecasts[0]!, candidateId: other.id, receivedAt: 2200,
          observation: { ...quote(2), eventId: quote().eventId, eventEndsAt: 3000 },
        })
      }],
    ]
    for (const [message, corrupt] of corruptions) {
      const state = structuredClone(valid)
      corrupt(state)
      const parsed = experimentStateSchema.safeParse(state)
      expect(parsed.success, message).toBe(false)
      if (!parsed.success) expect(parsed.error.message).toContain(message)
    }
  })

  it('does not promote a small winning sample, or a large losing or uncalibrated sample', async () => {
    const { registry, setTime } = await harness({ config: { minResolvedEvents: 2 } })
    const good = await registry.registerCandidate(policy)
    const bad = await registry.registerCandidate({ ...policy, name: 'losing candidate' })
    await registry.recordForecast(estimate(good.id), quote())
    await registry.recordForecast(estimate(bad.id), quote(2))
    await registry.recordForecast(estimate(bad.id), quote(3))
    setTime(2001)
    await registry.settle(outcome())
    await registry.settle(outcome(2, 0))
    await registry.settle(outcome(3, 0))
    expect(registry.rank().find(item => item.candidateId === good.id)).toMatchObject({ status: 'collecting' })
    expect(registry.rank().find(item => item.candidateId === bad.id)).toMatchObject({ status: 'rejected', meanNetAdvantage: -0.1 })
    expect(registry.rank().some(item => item.status === 'paper-eligible')).toBe(false)
  })

  it('scores only the resolved admission-order prefix when supplied results select later winners', async () => {
    const { registry, setTime } = await harness()
    const candidate = await registry.registerCandidate(policy)
    for (let index = 1; index <= 80; index++) await registry.recordForecast(estimate(candidate.id), quote(index))
    setTime(2001)
    for (let index = 2; index <= 80; index++) await registry.settle(outcome(index))
    expect(registry.rank()[0]).toMatchObject({ forecastEvents: 80, resolvedEvents: 79, evaluatedEvents: 0, status: 'collecting', meanNetAdvantage: null })
    await registry.settle(outcome(1, 0))
    expect(registry.rank()[0]).toMatchObject({ evaluatedEvents: 80, resolvedEvents: 80 })
    expect(registry.rank()[0]!.meanNetAdvantage).toBeCloseTo(0.8875)
  })

  it('uses candidate correction and summable alpha spending for paper-only promotion', async () => {
    const { registry, setTime } = await harness()
    const candidate = await registry.registerCandidate(policy)
    const baseline = await registry.registerCandidate({ ...policy, name: 'market-equivalent' })
    for (let index = 1; index <= 80; index++) {
      await registry.recordForecast(estimate(candidate.id), quote(index))
      await registry.recordForecast(estimate(baseline.id, 0.2, 0), quote(index))
    }
    setTime(2001)
    for (let index = 1; index <= 80; index++) await registry.settle(outcome(index))
    const ranks = registry.rank()
    const promoted = ranks.find(item => item.candidateId === candidate.id)!
    expect(promoted).toMatchObject({ status: 'paper-eligible', evaluatedEvents: 80 })
    expect(promoted.lowerConfidenceBound).toBeCloseTo(0.9 - Math.sqrt(2 * Math.log(4 * 80 * 81 / 0.05) / 80))
    expect(promoted.brierScore).toBeCloseTo(0.01)
    expect(promoted.marketBrierScore).toBeCloseTo(0.64)
    expect(ranks.find(item => item.candidateId === baseline.id)).toMatchObject({ status: 'rejected' })
    expect(registry.rank()).toEqual(ranks)
    expect(experimentStateSchema.safeParse(registry.view()).success).toBe(true)
  })

  it('rejects invalid runtime clocks and drains queued writes before closing', async () => {
    const invalid = await harness({ clock: () => NaN })
    await expect(invalid.registry.registerCandidate(policy)).rejects.toThrow(/clock/)
    const { registry } = await harness()
    const pending = registry.registerCandidate(policy)
    const closing = registry.close()
    expect(registry.close()).toBe(closing)
    await expect(registry.registerCandidate({ ...policy, name: 'late' })).rejects.toMatchObject({ code: 'closed' })
    await expect(pending).resolves.toMatchObject({ name: 'weather' })
    await closing
    expect(() => registry.view()).toThrow(/closed/)
  })

  it('checks writer authority before initialization and inside every queued mutation', async () => {
    await expect(harness({ mutationGuard: () => { throw new Error('Writer revoked') } })).rejects.toThrow(/Writer revoked/)
    let allowed = true
    const { registry, setTime } = await harness({ mutationGuard: () => { if (!allowed) throw new Error('Writer revoked') } })
    const rejectedRegistration = registry.registerCandidate(policy)
    allowed = false
    await expect(rejectedRegistration).rejects.toThrow(/Writer revoked/)
    expect(registry.view().candidates).toEqual([])
    allowed = true
    const candidate = await registry.registerCandidate(policy)
    const rejectedForecast = registry.recordForecast(estimate(candidate.id), quote())
    allowed = false
    await expect(rejectedForecast).rejects.toThrow(/Writer revoked/)
    expect(registry.view().forecasts).toEqual([])
    allowed = true
    await registry.recordForecast(estimate(candidate.id), quote())
    setTime(2001)
    const rejectedSettlement = registry.settle(outcome())
    allowed = false
    await expect(rejectedSettlement).rejects.toThrow(/Writer revoked/)
    expect(registry.view().settlements).toEqual([])
  })
})
