/** Runtime source acquisition, cancellation ownership, and prospective citation checks. */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { WebFetchResult } from '@deepseek-ai/dsh-web'
import { MemoryStorageBackend } from './helpers/memory-backend.ts'
import { resolveConfig } from '../../src/runtime/config.ts'
import { MarketDataClient } from '../../src/runtime/data/market.ts'
import type { EventId } from '../../src/runtime/data/market.ts'
import { RsiRuntime } from '../../src/runtime/runtime.ts'
import type { RuntimeDependencies } from '../../src/runtime/runtime.ts'
import { runtimeDomain } from '../../src/runtime/runtime-state.ts'
import { observation } from './fixtures/observations.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const sourceUrl = 'https://official.example.test/release'
const sourceText = 'Initial estimate: 2.4%.'
const sourceResponse = (): WebFetchResult => ({
  url: sourceUrl, statusCode: 200, body: { kind: 'text', content: sourceText }, truncated: false,
})

async function harness(fetchEvidence?: RuntimeDependencies['fetchEvidence'], judge?: RuntimeDependencies['judge']) {
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend()
  ctx.storage.backend.register('memory', backend)
  cleanups.push(async () => { await backend.close() })
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  cleanups.push(async () => { await storageDomain.closeAll() })
  const observed = observation('capture', Date.now())
  const domain = await storageDomain.open(runtimeDomain)
  try {
    await domain.table('observations').put(observed.id, observed)
  } finally {
    await domain.close()
  }
  const config = resolveConfig({
    objective: 'Evaluate official releases.', autoTick: false,
    writerLeasePath: join(tmpdir(), 'source-capture-unused-writer'),
    evidence: { maxRecords: 10, maxTextBytes: 64 },
    ledger: { initialCapitalMicros: 100_000_000, perEventLimitMicros: 1_000_000,
      totalExposureLimitMicros: 5_000_000, maxDrawdownMicros: 2_000_000 },
    research: { enabled: false, cwd: tmpdir() },
  })
  const deps: RuntimeDependencies = {
    storageDomain, releases: null,
    data: new MarketDataClient(config.data, async () => { throw new Error('Unexpected market request') }),
    assertWriter: () => {},
    reportError: (error) => { throw error },
    ...(fetchEvidence === undefined ? {} : { fetchEvidence }),
    ...(judge === undefined ? {} : { judge }),
  }
  const open = async () => {
    const runtime = await RsiRuntime.open(config, deps)
    cleanups.push(async () => { await runtime.close() })
    return runtime
  }
  return { runtime: await open(), observed, reopen: open }
}

describe('runtime source capture', () => {
  it('retains provider text and final URL with runtime-owned acquisition method and receipt time', async () => {
    const calls: string[] = []
    const { runtime, observed } = await harness(async (url, signal) => {
      calls.push(url)
      signal.throwIfAborted()
      return sourceResponse()
    })
    const before = Date.now()
    const captured = await runtime.captureEvidence(observed.id, `${sourceUrl}?requested=1`)
    expect(captured).toMatchObject({ eventId: observed.market.eventId, url: sourceUrl,
      text: sourceText, provenance: 'fetched', reportedPublishedAt: null })
    expect(captured.receivedAt).toBeGreaterThanOrEqual(before)
    expect(captured.receivedAt).toBeLessThanOrEqual(Date.now())
    expect(calls).toEqual([`${sourceUrl}?requested=1`])
    expect(runtime.evidence.get(captured.id)).toEqual(captured)
  })

  it('rejects absent providers and invalid requests without inventing evidence', async () => {
    const { runtime, observed } = await harness()
    await expect(runtime.captureEvidence(observed.id, sourceUrl)).rejects.toThrow('configured Web fetch provider')
    expect(() => runtime.captureEvidence('unknown', sourceUrl)).toThrow('Unknown observation')
    expect(() => runtime.captureEvidence(observed.id, 'file:///private/source')).toThrow()
    expect(runtime.evidence.list(10)).toEqual([])
  })

  it('rejects failed, truncated, empty, and oversized provider results without retaining them', async () => {
    let response = sourceResponse()
    const { runtime, observed } = await harness(async () => response)
    const rejected: Array<[WebFetchResult, string | RegExp]> = [
      [{ ...sourceResponse(), statusCode: 503 }, 'complete successful HTTP response'],
      [{ ...sourceResponse(), truncated: true }, 'complete successful HTTP response'],
      [{ ...sourceResponse(), body: { kind: 'text', content: '' } }, /Too small/],
      [{ ...sourceResponse(), body: { kind: 'text', content: 'x'.repeat(65) } }, 'maxTextBytes'],
    ]
    for (const [value, diagnostic] of rejected) {
      response = value
      await expect(runtime.captureEvidence(observed.id, sourceUrl)).rejects.toThrow(diagnostic)
      expect(runtime.evidence.list(10)).toEqual([])
    }
    response = sourceResponse()
    await expect(runtime.captureEvidence(observed.id, sourceUrl)).resolves.toMatchObject({ text: sourceText })
  })

  it('joins a late provider before closing evidence and rejects its post-abort response', async () => {
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<undefined>()
    let inspectBeforeReturn = () => {}
    const { runtime, observed, reopen } = await harness(async (_url, signal) => {
      entered.resolve(signal)
      await release.promise
      inspectBeforeReturn()
      return sourceResponse()
    })
    cleanups.push(async () => { release.resolve(undefined) })
    const capture = runtime.captureEvidence(observed.id, sourceUrl)
    const outcome = capture.catch((error: unknown) => error)
    const signal = await entered.promise
    let providerSawOpenEvidence = false
    inspectBeforeReturn = () => {
      expect(runtime.evidence.list(10)).toEqual([])
      providerSawOpenEvidence = true
    }
    const closing = runtime.close()
    expect(signal.aborted).toBe(true)
    release.resolve(undefined)
    await closing
    expect(await outcome).toMatchObject({ message: 'RSI runtime stopped' })
    expect(providerSawOpenEvidence).toBe(true)
    const restored = await reopen()
    expect(restored.evidence.list(10)).toEqual([])
  })

  it('keeps an interrupted capture canceled after emergency stop and resume', async () => {
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<undefined>()
    let calls = 0
    const { runtime, observed } = await harness(async (_url, signal) => {
      if (++calls === 1) {
        entered.resolve(signal)
        await release.promise
      }
      return sourceResponse()
    })
    cleanups.push(async () => { release.resolve(undefined) })
    const outcome = runtime.captureEvidence(observed.id, sourceUrl).catch((error: unknown) => error)
    const signal = await entered.promise
    await runtime.changeOperations(0, true, 'Stop evidence acquisition')
    expect(signal.aborted).toBe(true)
    expect(() => runtime.captureEvidence(observed.id, sourceUrl)).toThrow('emergency-stopped')
    await runtime.changeOperations(1, false, 'Resume fresh work')
    release.resolve(undefined)
    expect(await outcome).toMatchObject({ message: 'RSI emergency stop' })
    expect(runtime.evidence.list(10)).toEqual([])
    await expect(runtime.captureEvidence(observed.id, sourceUrl)).resolves.toMatchObject({ provenance: 'fetched' })
    expect(calls).toBe(2)
  })

  it('preserves caller cancellation without stopping other captures', async () => {
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<undefined>()
    let calls = 0
    const { runtime, observed } = await harness(async (_url, signal) => {
      if (++calls === 1) {
        entered.resolve(signal)
        await release.promise
      }
      return sourceResponse()
    })
    cleanups.push(async () => { release.resolve(undefined) })
    const caller = new AbortController()
    const outcome = runtime.captureEvidence(observed.id, sourceUrl, caller.signal).catch((error: unknown) => error)
    const combined = await entered.promise
    const reason = new Error('Research request canceled')
    caller.abort(reason)
    expect(combined.reason).toBe(reason)
    release.resolve(undefined)
    expect(await outcome).toBe(reason)
    await expect(runtime.captureEvidence(observed.id, sourceUrl, caller.signal)).rejects.toBe(reason)
    expect(runtime.evidence.list(10)).toEqual([])
    await expect(runtime.captureEvidence(observed.id, sourceUrl)).resolves.toMatchObject({ text: sourceText })
    expect(calls).toBe(2)
  })

  it('admits source excerpts only for their retained event, URL, and text', async () => {
    const { runtime, observed } = await harness(async () => sourceResponse())
    const captured = await runtime.captureEvidence(observed.id, sourceUrl)
    const foreign = await runtime.evidence.append({
      eventId: brandString<EventId>('other-event'), url: sourceUrl, text: sourceText,
      reportedPublishedAt: null, provenance: 'submitted',
    })
    const candidate = await runtime.registerCandidate({ name: 'Official release', thesis: 'Prospective official estimates.', minEdge: 0.05, kellyFraction: 0.1 })
    const estimate = { candidateId: candidate.id, probability: 0.2, uncertainty: 0.05 }
    const citation = { snapshotId: captured.id, url: sourceUrl, text: 'estimate: 2.4%' }
    const invalid = [
      { ...citation, snapshotId: foreign.id },
      { ...citation, url: `${sourceUrl}/other` },
      { ...citation, text: 'Unrelated claim' },
    ]
    for (const evidence of invalid) {
      await expect(runtime.forecast(observed.id, { ...estimate, evidence: [evidence] })).rejects.toThrow('does not match')
    }
    expect(runtime.experiments.view().forecasts).toEqual([])
    await expect(runtime.forecast(observed.id, { ...estimate, evidence: [citation] })).resolves.toMatchObject({ evidence: [citation] })
  })
})

describe('runtime Jev judgments', () => {
  const input = { state: 'Inflation is elevated.', questions: { concern: { type: 'noul', instructions: 'Does this mention inflation?' } } }
  const answer = { model: 'jev-1.13.0', answers: { concern: { type: 'noul' as const, noul: 0.9 } },
    usage: { input_tokens: 10, output_tokens: 0 }, inputHash: brandString<Branded<'RsiJudgmentInputHash'>>('a'.repeat(64)) }

  it('passes explicit state without adding sources and rejects an unavailable provider', async () => {
    const missing = await harness()
    expect(() => missing.runtime.judge(input)).toThrow('provider is not configured')
    const { runtime } = await harness(undefined, async (request) => {
      expect(request).toEqual(input)
      return answer
    })
    await expect(runtime.judge(input)).resolves.toEqual(answer)
    const cancelled = new AbortController()
    cancelled.abort(new Error('caller cancelled'))
    await expect(runtime.judge(input, cancelled.signal)).rejects.toThrow('caller cancelled')
  })

  it('joins pending judgments before releasing runtime ownership and rejects late results', async () => {
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<undefined>()
    const { runtime } = await harness(undefined, async (_request, signal) => {
      entered.resolve(signal)
      await release.promise
      return answer
    })
    cleanups.push(async () => { release.resolve(undefined) })
    const outcome = runtime.judge(input).catch((error: unknown) => error)
    const signal = await entered.promise
    let closed = false
    const closing = runtime.close().then(() => { closed = true })
    expect(signal.aborted).toBe(true)
    expect(closed).toBe(false)
    release.resolve(undefined)
    expect(await outcome).toMatchObject({ message: 'RSI runtime stopped' })
    await closing
    expect(() => runtime.judge(input)).toThrow()
  })

  it('cancels admitted judgments on emergency stop while allowing fresh work after resume', async () => {
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<undefined>()
    let calls = 0
    const { runtime } = await harness(undefined, async (_request, signal) => {
      if (++calls === 1) {
        entered.resolve(signal)
        await release.promise
      }
      return answer
    })
    cleanups.push(async () => { release.resolve(undefined) })
    const outcome = runtime.judge(input).catch((error: unknown) => error)
    const signal = await entered.promise
    await runtime.changeOperations(0, true, 'Stop judgments')
    expect(signal.aborted).toBe(true)
    expect(() => runtime.judge(input)).toThrow('emergency-stopped')
    await runtime.changeOperations(1, false, 'Resume judgments')
    release.resolve(undefined)
    expect(await outcome).toMatchObject({ message: 'RSI emergency stop' })
    await expect(runtime.judge(input)).resolves.toEqual(answer)
  })
})
