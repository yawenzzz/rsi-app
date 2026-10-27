/** Executable paper quotes include complete depth, current fees, and slippage allowances. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { resolveConfig } from '../../src/runtime/config.ts'
import { bookSchema, feeParametersSchema, MarketDataClient } from '../../src/runtime/data/market.ts'
import { quotePurchase } from '../../src/runtime/execution/quotes.ts'
import { RsiRuntime } from '../../src/runtime/runtime.ts'
import { startPublicApi, type PublicApiFixture } from './fixtures/loader/public-api.ts'

const contexts: Context[] = []
const runtimes: RsiRuntime[] = []
const roots: string[] = []
const publicApis: PublicApiFixture[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.close()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const api of publicApis.splice(0)) await api.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function openRuntime(transport: typeof fetch, endpoint = 'https://fixture.invalid') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-runtime-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const config = resolveConfig({
    objective: 'Evaluate prospective research.', autoTick: false,
    writerLeasePath: join(root, 'writer'),
    data: { gammaUrl: endpoint, clobUrl: endpoint },
    ledger: {
      initialCapitalMicros: 100_000_000, perEventLimitMicros: 1_000_000,
      totalExposureLimitMicros: 5_000_000, maxDrawdownMicros: 2_000_000,
    },
    research: { enabled: false, cwd: root },
  })
  let writerHeld = true
  const errors: unknown[] = []
  const deps = {
    storageDomain: ctx.storageDomain,
    releases: null,
    data: new MarketDataClient(config.data, transport),
    assertWriter() { if (!writerHeld) throw new Error('Writer ownership lost') },
    reportError(error: unknown) { errors.push(error) },
  }
  const runtime = await RsiRuntime.open(config, deps)
  runtimes.push(runtime)
  return { runtime, config, deps, errors, loseWriter: () => { writerHeld = false } }
}

function book() {
  return bookSchema.parse({
    tokenId: 'yes-token', conditionId: 'condition', observedAt: 1000, timestamp: 1000,
    bids: [{ price: 0.2, size: 10 }], asks: [{ price: 0.25, size: 1 }, { price: 0.5, size: 2 }],
    minOrderSize: 1, tickSize: 0.01, negRisk: false, hash: 'book',
  })
}

function fees() {
  return feeParametersSchema.parse({
    conditionId: 'condition', observedAt: 1000,
    rate: 0.1, exponent: 1, takerOnly: true, makerBaseFeeBps: 0, takerBaseFeeBps: 0,
  })
}

describe('paper purchase costs', () => {
  it('charges each consumed price level, its fee, and the execution allowance', () => {
    expect(quotePurchase(book(), fees(), 2, 100)).toEqual({ quantity: 2, costMicros: 801688, averageCostMicros: 400844 })
  })

  it('refuses incomplete depth or a quantity below the market minimum', () => {
    expect(quotePurchase(book(), fees(), 4, 100)).toBeNull()
    const source = book()
    source.minOrderSize = 1.5
    expect(quotePurchase(source, fees(), 1, 100)).toBeNull()
  })

  it('does not infer zero fees for mismatched or unsupported fee metadata', () => {
    const wrongCondition = feeParametersSchema.parse({ ...fees(), conditionId: 'another-condition' })
    expect(quotePurchase(book(), wrongCondition, 1, 100)).toBeNull()
    expect(quotePurchase(book(), { ...fees(), makerBaseFeeBps: 1 }, 1, 100)).toBeNull()
    expect(quotePurchase(book(), { ...fees(), takerBaseFeeBps: 1 }, 1, 100)).toBeNull()
  })

  it('requires whole shares and a positive representable debit', () => {
    expect(quotePurchase(book(), fees(), 1.5, 100)).toBeNull()
    const freeBook = book()
    freeBook.asks = [{ price: 0, size: 1 }]
    expect(quotePurchase(freeBook, fees(), 1, 100)).toBeNull()
    const hugeBook = book()
    hugeBook.asks = [{ price: 0.9, size: Number.MAX_SAFE_INTEGER }]
    expect(quotePurchase(hugeBook, fees(), Number.MAX_SAFE_INTEGER, 100)).toBeNull()
  })
})

describe('persistent collection lifecycle', () => {
  it('shares an admitted tick and joins its cancellation before releasing durable owners', async () => {
    const entered = Promise.withResolvers<undefined>()
    const stopped = Promise.withResolvers<undefined>()
    let requests = 0
    const transport: typeof fetch = async (_input, init) => {
      requests++
      entered.resolve(undefined)
      const signal = init?.signal
      if (!signal) throw new Error('Fixture requires request cancellation')
      signal.throwIfAborted()
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          stopped.resolve(undefined)
          reject(signal.reason instanceof Error ? signal.reason : new Error('Fixture request aborted'))
        }, { once: true })
      })
    }
    const { runtime, config, deps, errors } = await openRuntime(transport)
    const tick = runtime.tick()
    const outcome = tick.catch((error: unknown) => error)
    await entered.promise
    expect(runtime.tick()).toBe(tick)
    await runtime.close()
    await stopped.promise
    expect(await outcome).toMatchObject({ message: 'RSI runtime stopped' })
    expect(requests).toBe(1)
    expect(errors).toEqual([])
    const reopened = await RsiRuntime.open(config, deps)
    runtimes.push(reopened)
    expect(reopened.status()).toMatchObject({ status: 'paused', observationCount: 0, lastTickError: null })
  })

  it('retains upstream failure diagnostics and collects again without changing paper funds', async () => {
    const api = await startPublicApi()
    publicApis.push(api)
    api.failRequests = true
    const { runtime } = await openRuntime(fetch, api.url)
    const account = runtime.status().account
    await expect(runtime.tick()).rejects.toThrow('Polymarket /markets returned HTTP 503')
    expect(runtime.status()).toMatchObject({ account, observationCount: 0, lastTickError: 'Polymarket /markets returned HTTP 503' })
    api.failRequests = false
    await expect(runtime.tick()).resolves.toEqual({ observations: 2, skipped: 0, errors: [] })
    expect(runtime.status()).toMatchObject({ account, observationCount: 2, lastTickError: null })
  })

  it('denies controls and candidate registration after writer authority is lost', async () => {
    const transport: typeof fetch = async () => { throw new Error('Unexpected network request') }
    const { runtime, loseWriter } = await openRuntime(transport)
    const before = runtime.status()
    loseWriter()
    await expect(runtime.control({ expectedRevision: 0, action: 'resume', reason: 'Start' })).rejects.toThrow('Writer ownership lost')
    await expect(runtime.registerCandidate({ name: 'candidate', thesis: 'future outcomes', minEdge: 0.1, kellyFraction: 0.1 }))
      .rejects.toThrow('Writer ownership lost')
    expect(runtime.status()).toEqual(before)
  })
})
