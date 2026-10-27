/** Public-data parsing, bounded transport, and reported-resolution regressions. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it } from 'vitest'
import {
  MarketDataClient, bookSchema, feeParametersSchema, marketSchema,
  type ConditionId, type MarketId, type MarketDataOptions, type TokenId,
} from '../../src/runtime/data/market.ts'

const conditionId = brandString<ConditionId>('condition-1')
const tokenId = brandString<TokenId>('token-1')
const options: MarketDataOptions = {
  gammaUrl: 'https://gamma.example.test', clobUrl: 'https://clob.example.test/',
  timeoutMs: 10_000, maxMarkets: 3, marketIds: [], concurrency: 2, maxResponseBytes: 1_000_000,
}
const signal = () => new AbortController().signal
const market = (id = '1') => ({
  id, conditionId: `condition-${id}`, question: `Will event ${id} happen?`,
  description: 'Resolve using the official event record.', resolutionSource: 'https://untrusted.example.test/rules',
  endDate: '2026-09-12T00:00:00Z', clobTokenIds: JSON.stringify([`token-${id}`, `no-${id}`]),
  outcomes: '["Yes","No"]', events: [{ id: 'event-1' }],
  active: true, closed: false, acceptingOrders: true, feesEnabled: true,
})
const book = () => ({
  market: conditionId, asset_id: tokenId, timestamp: '1789080000000', hash: 'book-hash',
  bids: [{ price: '0.4', size: '12' }, { price: '0.45', size: '6' }],
  asks: [{ price: '0.7', size: '30' }, { price: '0.6', size: '20' }],
  min_order_size: '5', tick_size: '0.01', neg_risk: false,
})
const fees = () => ({ mbf: 0, tbf: 0, fd: { r: 0.05, e: 1, to: true } })
const resolution = () => ({
  conditionId, closed: true, umaResolutionStatus: 'resolved',
  clobTokenIds: '["token-1","no-1"]', outcomePrices: '["1","0"]',
})

function fixture(values: unknown[], overrides: Partial<MarketDataOptions> = {}) {
  const requests: Array<{ url: URL; init: RequestInit | undefined }> = []
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: new URL(input instanceof Request ? input.url : input.toString()), init })
    const next = values.shift()
    if (next instanceof Error) throw next
    return next instanceof Response ? next : Response.json(next)
  }
  return { data: new MarketDataClient({ ...options, ...overrides }, fetcher), requests }
}

describe('MarketDataClient discovery', () => {
  it('uses the current global transport after a provider restores its temporary fetch wrapper', async () => {
    const originalFetch = globalThis.fetch
    let wrapperActive = true
    let globalCalls = 0
    let injectedCalls = 0
    const transport: typeof fetch = async () => {
      globalCalls++
      return Response.json([market()])
    }
    try {
      globalThis.fetch = async (input, init) => {
        if (!wrapperActive) throw new Error('Provider fetch wrapper has been disposed')
        return transport(input, init)
      }
      const dynamic = new MarketDataClient(options)
      const injected = new MarketDataClient(options, async () => {
        injectedCalls++
        return Response.json([])
      })
      globalThis.fetch = transport
      wrapperActive = false

      expect((await dynamic.discover(signal())).map(item => item.id)).toEqual(['1'])
      expect(await injected.discover(signal())).toEqual([])
      expect(globalCalls).toBe(1)
      expect(injectedCalls).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('keeps identity, rules, fee flags, and local receive time without following market URLs', async () => {
    const { data, requests } = fixture([[market()]])
    const before = Date.now()
    const result = await data.discover(signal())
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: '1', conditionId, eventId: 'event-1', feesEnabled: true,
      tokens: [{ id: tokenId, outcome: 'Yes' }, { id: 'no-1', outcome: 'No' }],
      resolutionSource: 'https://untrusted.example.test/rules',
    })
    expect(result[0]!.observedAt).toBeGreaterThanOrEqual(before)
    expect(result[0]!.observedAt).toBeLessThanOrEqual(Date.now())
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url.origin).toBe('https://gamma.example.test')
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toEqual({
      active: 'true', closed: 'false', limit: '3', offset: '0', order: 'id', ascending: 'true',
    })
    expect(requests[0]!.init).toMatchObject({ method: 'GET', redirect: 'error', headers: { accept: 'application/json' } })
    expect(marketSchema.parse(result[0])).toEqual(result[0])
  })

  it('paginates while counting inactive and duplicate rows against the discovery bound', async () => {
    const page = Array.from({ length: 100 }, (_, index) => market(String(index)))
    page[1] = { ...market('0'), acceptingOrders: false }
    page[2] = market('0')
    const { data, requests } = fixture([page, [market('100'), { ...market('101'), closed: true }]], { maxMarkets: 102 })
    const result = await data.discover(signal())
    expect(result).toHaveLength(99)
    expect(requests.map(request => [request.url.searchParams.get('offset'), request.url.searchParams.get('limit')]))
      .toEqual([['0', '100'], ['100', '2']])
  })

  it('stops on empty pages and excludes inactive markets', async () => {
    const empty = fixture([[]])
    expect(await empty.data.discover(signal())).toEqual([])
    const inactive = fixture([[{ ...market(), active: false }]])
    expect(await inactive.data.discover(signal())).toEqual([])
  })

  it('reads the configured watchlist in order without scanning unrelated markets', async () => {
    const { data, requests } = fixture([market('82'), { ...market('17'), closed: true }, market('4')], {
      marketIds: ['82', '17', '4'].map(brandString<MarketId>),
    })
    expect((await data.discover(signal())).map(item => item.id)).toEqual(['82', '4'])
    expect(requests.map(request => request.url.pathname)).toEqual(['/markets/82', '/markets/17', '/markets/4'])
    expect(requests.every(request => request.url.search === '')).toBe(true)
  })

  it('rejects a watchlist response for another market', async () => {
    const { data } = fixture([market('2')], { marketIds: [brandString<MarketId>('1')] })
    await expect(data.discover(signal())).rejects.toThrow('watchlist identifier')
  })

  it.each([
    { feesEnabled: undefined }, { feesEnabled: null }, { conditionId: '' }, { endDate: 'yesterday' },
    { clobTokenIds: '["same","same"]' }, { clobTokenIds: '["only"]' },
    { clobTokenIds: 'broken' }, { outcomes: '["Yes","No","Maybe"]' }, { events: [] },
    { description: undefined }, { acceptingOrders: undefined },
  ])('rejects incomplete or inconsistent discovery metadata: %j', async (patch) => {
    const { data } = fixture([[{ ...market(), ...patch }]])
    await expect(data.discover(signal())).rejects.toThrow()
  })

  it('rejects a server page larger than the requested inspection budget', async () => {
    const { data } = fixture([[market('1'), market('2')]], { maxMarkets: 1 })
    await expect(data.discover(signal())).rejects.toThrow()
  })
})

describe('MarketDataClient books and fees', () => {
  it('sorts both book sides and preserves stale exchange timestamps separately from receipt time', async () => {
    const { data, requests } = fixture([{ ...book(), timestamp: '1' }])
    const result = await data.book(tokenId, signal())
    expect(result).toMatchObject({
      tokenId, conditionId, timestamp: 1, minOrderSize: 5, tickSize: 0.01, negRisk: false,
      bids: [{ price: 0.45, size: 6 }, { price: 0.4, size: 12 }],
      asks: [{ price: 0.6, size: 20 }, { price: 0.7, size: 30 }],
    })
    expect(result.observedAt).toBeGreaterThan(result.timestamp)
    expect(requests[0]!.url.searchParams.get('token_id')).toBe(tokenId)
    expect(bookSchema.parse(result)).toEqual(result)
  })

  it.each([
    { asset_id: 'wrong' }, { timestamp: '' }, { timestamp: '1e20' }, { timestamp: '-1' },
    { timestamp: '9007199254740992' }, { min_order_size: '0' }, { tick_size: '0' },
    { neg_risk: undefined }, { hash: undefined }, { asks: [{ price: '1.1', size: '3' }] },
    { bids: [{ price: '0.5', size: '0' }] }, { bids: [{ price: '0.5', size: 'Infinity' }] },
  ])('rejects invalid or mismatched book metadata: %j', async (patch) => {
    const { data } = fixture([{ ...book(), ...patch }])
    await expect(data.book(tokenId, signal())).rejects.toThrow()
  })

  it('retains empty sides as explicit missing liquidity', async () => {
    const { data } = fixture([{ ...book(), asks: [], bids: [] }])
    expect(await data.book(tokenId, signal())).toMatchObject({ asks: [], bids: [] })
  })

  it('reads all explicit CLOB fee parameters', async () => {
    const { data, requests } = fixture([fees()])
    const result = await data.feeParameters(conditionId, signal())
    expect(result).toMatchObject({ conditionId, rate: 0.05, exponent: 1, takerOnly: true, makerBaseFeeBps: 0, takerBaseFeeBps: 0 })
    expect(requests[0]!.url.pathname).toBe('/clob-markets/condition-1')
    expect(feeParametersSchema.parse(result)).toEqual(result)
  })

  it.each([{ fd: undefined }, { fd: { r: 0.05 } }, { tbf: undefined }, { fd: { r: -1, e: 1, to: true } }])(
    'rejects absent or invalid fees instead of treating them as free: %j', async (patch) => {
      const { data } = fixture([{ ...fees(), ...patch }])
      await expect(data.feeParameters(conditionId, signal())).rejects.toThrow()
    },
  )
})

describe('MarketDataClient reported resolution', () => {
  it('returns terminal payouts only with explicit Gamma resolution and closure', async () => {
    const { data, requests } = fixture([[resolution()]])
    expect(await data.resolution(conditionId, signal())).toMatchObject({
      conditionId, sourceStatus: 'resolved', status: 'reported-final',
      payouts: [{ tokenId, payout: 1 }, { tokenId: 'no-1', payout: 0 }],
    })
    expect(requests[0]!.url.searchParams.get('condition_ids')).toBe(conditionId)
  })

  it('retains explicit half payouts for a resolved binary split', async () => {
    const { data } = fixture([[{ ...resolution(), outcomePrices: '["0.5","0.5"]' }]])
    expect(await data.resolution(conditionId, signal())).toMatchObject({
      status: 'reported-final', payouts: [{ tokenId, payout: 0.5 }, { tokenId: 'no-1', payout: 0.5 }],
    })
  })

  it.each([
    [{ closed: false, umaResolutionStatus: undefined }, 'unresolved'],
    [{ umaResolutionStatus: 'proposed' }, 'unresolved'],
    [{ umaResolutionStatus: 'disputed' }, 'unresolved'],
    [{ umaResolutionStatus: undefined }, 'unknown'],
    [{ umaResolutionStatus: null }, 'unknown'],
    [{ umaResolutionStatus: 'new-status' }, 'unknown'],
    [{ closed: false }, 'unknown'],
    [{ outcomePrices: '["0.6","0.4"]' }, 'unknown'],
    [{ outcomePrices: '["1","1"]' }, 'unknown'],
  ])('does not settle inconsistent or non-final evidence: %j', async (patch, status) => {
    const { data } = fixture([[{ ...resolution(), ...patch }]])
    expect(await data.resolution(conditionId, signal())).toMatchObject({ status, payouts: [] })
  })

  it('reports a missing market as unknown', async () => {
    const { data } = fixture([[]])
    expect(await data.resolution(conditionId, signal())).toMatchObject({ status: 'unknown', sourceStatus: null, payouts: [] })
  })

  it.each([
    [{ ...resolution(), conditionId: 'other' }], [resolution(), resolution()],
    [{ ...resolution(), outcomePrices: '["1"]' }],
  ])('rejects mismatched or malformed resolution responses: %j', async (...rows) => {
    const { data } = fixture([rows])
    await expect(data.resolution(conditionId, signal())).rejects.toThrow()
  })
})

describe('MarketDataClient bounded requests', () => {
  it.each([
    [{ concurrency: 0 }, 'concurrency'], [{ timeoutMs: 0 }, 'timeoutMs'],
    [{ maxMarkets: 0 }, 'maxMarkets'], [{ maxResponseBytes: 0 }, 'maxResponseBytes'],
    [{ gammaUrl: 'file:///etc/passwd' }, 'HTTP'],
  ])('rejects invalid configuration: %j', (patch, message) => {
    expect(() => fixture([], patch)).toThrow(message)
  })

  it('rejects duplicate, malformed, or over-budget watchlists before requesting data', () => {
    for (const ids of [['1', '1'], ['../markets'], ['1', '2', '3', '4']]) {
      expect(() => fixture([], { marketIds: ids.map(brandString<MarketId>) })).toThrow()
    }
  })

  it('refuses an already aborted caller before fetching', async () => {
    const { data, requests } = fixture([])
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    await expect(data.book(tokenId, controller.signal)).rejects.toThrow('caller stopped')
    expect(requests).toEqual([])
  })

  it.each([
    [new Response('no', { status: 429 }), 'HTTP 429'],
    [new Response(null), 'no body'], [new Response('{'), 'JSON'], [new Error('network failed'), 'network failed'],
  ])('rejects failed or malformed responses: %s', async (response, message) => {
    const { data } = fixture([response])
    await expect(data.book(tokenId, signal())).rejects.toThrow(message)
  })

  it('enforces bytes across chunks, cancels an oversized stream, and accepts the exact bound', async () => {
    let canceled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('中')); controller.enqueue(new TextEncoder().encode('文')) },
      cancel() { canceled = true },
    })
    const oversized = fixture([new Response(body)], { maxResponseBytes: 5 })
    await expect(oversized.data.book(tokenId, signal())).rejects.toThrow('maxResponseBytes')
    expect(canceled).toBe(true)
    const exact = fixture([new Response('[]')], { maxResponseBytes: 2 })
    expect(await exact.data.discover(signal())).toEqual([])
  })

  it('aborts a pending request at its deadline and frees its slot', async () => {
    const receivedSignals: AbortSignal[] = []
    const fetcher: typeof fetch = async (_input, init) => {
      const requestSignal = init!.signal!
      receivedSignals.push(requestSignal)
      return new Promise<Response>((_resolve, reject) => {
        requestSignal.addEventListener('abort', () => {
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the supplied AbortSignal.reason.
          reject(requestSignal.reason)
        }, { once: true })
      })
    }
    const data = new MarketDataClient({ ...options, timeoutMs: 10, concurrency: 1 }, fetcher)
    await expect(data.book(tokenId, signal())).rejects.toMatchObject({ name: 'TimeoutError' })
    await expect(data.book(tokenId, signal())).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(receivedSignals).toHaveLength(2)
    expect(receivedSignals.every(item => item.aborted)).toBe(true)
  })

  it('bounds parallel requests, removes aborted queue entries, and wakes the next caller', async () => {
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<Response>()
    let calls = 0
    const fetcher: typeof fetch = async () => {
      calls++
      if (calls === 1) { started.resolve(undefined); return release.promise }
      return Response.json(book())
    }
    const data = new MarketDataClient({ ...options, concurrency: 1 }, fetcher)
    const first = data.book(tokenId, signal())
    await started.promise
    const controller = new AbortController()
    const queued = data.book(tokenId, controller.signal)
    const last = data.book(tokenId, signal())
    expect(calls).toBe(1)
    controller.abort(new Error('queued canceled'))
    await expect(queued).rejects.toThrow('queued canceled')
    release.resolve(Response.json(book()))
    await Promise.all([first, last])
    expect(calls).toBe(2)
  })
})
