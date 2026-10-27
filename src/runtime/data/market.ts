/** Public Polymarket metadata, order books, and reported settlement evidence. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'

/** Gamma market identifier, distinct from a CTF condition identifier. */
export type MarketId = Branded<'PolymarketMarketId'>
/** CTF condition identifier used by Gamma and CLOB market queries. */
export type ConditionId = Branded<'PolymarketConditionId'>
/** Gamma event identifier used to group related markets. */
export type EventId = Branded<'PolymarketEventId'>
/** CLOB outcome token identifier. */
export type TokenId = Branded<'PolymarketTokenId'>

/** Discovery metadata; text and resolution-source URLs are untrusted data. */
export interface Market {
  id: MarketId
  conditionId: ConditionId
  eventId: EventId
  question: string
  description: string
  resolutionSource: string
  endDate: string
  tokens: Array<{ id: TokenId; outcome: string }>
  active: boolean
  closed: boolean
  acceptingOrders: boolean
  feesEnabled: boolean
  /** Local Unix milliseconds when the complete HTTP body arrived. */
  observedAt: number
  /** Gamma-provided category when present; absence is not inferred from market text. */
  category?: string | undefined
}

/** A CLOB snapshot with bids descending and asks ascending; freshness is caller-owned. */
export interface Book {
  tokenId: TokenId
  conditionId: ConditionId
  observedAt: number
  /** CLOB snapshot timestamp in Unix milliseconds, preserved even when stale. */
  timestamp: number
  bids: Array<{ price: number; size: number }>
  asks: Array<{ price: number; size: number }>
  minOrderSize: number
  tickSize: number
  negRisk: boolean
  hash: string
}

/** Explicit CLOB fee parameters; no absent fee field is interpreted as zero. */
export interface FeeParameters {
  conditionId: ConditionId
  observedAt: number
  rate: number
  exponent: number
  takerOnly: boolean
  makerBaseFeeBps: number
  takerBaseFeeBps: number
}

/** Gamma-reported resolution; reported-final is not independent on-chain confirmation. */
export type Resolution = {
  conditionId: ConditionId
  observedAt: number
  sourceStatus: string | null
} & (
  | { status: 'reported-final'; payouts: Array<{ tokenId: TokenId; payout: number }> }
  | { status: 'unresolved' | 'unknown'; payouts: [] }
)

/** Request limits include queue wait and complete response-body consumption. */
export interface MarketDataOptions {
  /** HTTP(S) base URL for public Gamma market metadata. */
  gammaUrl: string
  /** HTTP(S) base URL for public CLOB books and fee parameters. */
  clobUrl: string
  /** Per-request deadline in milliseconds, including queue wait and body receipt. */
  timeoutMs: number
  /** Maximum Gamma rows inspected, including duplicate or ineligible rows. */
  maxMarkets: number
  /** Explicit Gamma market watchlist; empty selects bounded active-market discovery. */
  marketIds: MarketId[]
  /** Maximum simultaneous HTTP requests owned by this adapter. */
  concurrency: number
  /** Maximum bytes in each complete HTTP response body. */
  maxResponseBytes: number
}

const normalizedTokenId = z.string().min(1).transform(brandString<TokenId>)
const normalizedConditionId = z.string().min(1).transform(brandString<ConditionId>)
const receivedTimestamp = z.number().int().nonnegative()
const normalizedLevel = z.object({ price: z.number().min(0).max(1), size: z.number().positive() })
/** Validate normalized market metadata when reopening durable observations. */
export const marketSchema: z.ZodType<Market> = z.object({
  id: z.string().min(1).transform(brandString<MarketId>),
  conditionId: normalizedConditionId,
  eventId: z.string().min(1).transform(brandString<EventId>),
  question: z.string().min(1), description: z.string().min(1), resolutionSource: z.string(),
  endDate: z.iso.datetime({ offset: true }),
  tokens: z.array(z.object({ id: normalizedTokenId, outcome: z.string().min(1) })).min(2)
    .refine(tokens => new Set(tokens.map(token => token.id)).size === tokens.length, 'Duplicate token identifiers'),
  active: z.boolean(), closed: z.boolean(), acceptingOrders: z.boolean(), feesEnabled: z.boolean(),
  observedAt: receivedTimestamp,
  category: z.string().optional(),
})
/** Validate and sort normalized books when reopening durable observations. */
export const bookSchema: z.ZodType<Book> = z.object({
  tokenId: normalizedTokenId, conditionId: normalizedConditionId,
  observedAt: receivedTimestamp, timestamp: receivedTimestamp,
  bids: z.array(normalizedLevel).transform(levels => levels.sort((left, right) => right.price - left.price)),
  asks: z.array(normalizedLevel).transform(levels => levels.sort((left, right) => left.price - right.price)),
  minOrderSize: z.number().positive(), tickSize: z.number().positive().max(1),
  negRisk: z.boolean(), hash: z.string().min(1),
})
/** Validate explicit fee parameters when reopening durable observations. */
export const feeParametersSchema: z.ZodType<FeeParameters> = z.object({
  conditionId: normalizedConditionId, observedAt: receivedTimestamp,
  rate: z.number().nonnegative(), exponent: z.number().nonnegative(), takerOnly: z.boolean(),
  makerBaseFeeBps: z.number().int().nonnegative(), takerBaseFeeBps: z.number().int().nonnegative(),
})

const endpoint = z.url().refine(value => ['https:', 'http:'].includes(new URL(value).protocol), 'Expected HTTP(S) URL')
const optionsSchema = z.object({
  gammaUrl: endpoint,
  clobUrl: endpoint,
  timeoutMs: z.number().int().positive().max(2_147_483_647),
  maxMarkets: z.number().int().positive(),
  marketIds: z.array(z.string().regex(/^\d+$/).transform(brandString<MarketId>))
    .refine(ids => new Set(ids).size === ids.length, 'Duplicate market watchlist identifiers'),
  concurrency: z.number().int().positive(),
  maxResponseBytes: z.number().int().positive(),
}).refine(value => value.marketIds.length <= value.maxMarkets, 'Market watchlist exceeds maxMarkets')
const identifier = z.string().min(1)
const numericString = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/).transform(Number).pipe(z.number())
const probability = numericString.pipe(z.number().min(0).max(1))
const jsonArray = z.string().transform((value, ctx): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Expected a JSON-encoded array' })
    return z.NEVER
  }
})
const tokensSchema = jsonArray.pipe(z.array(identifier).min(2)).refine(values => new Set(values).size === values.length, 'Duplicate token identifiers')
const marketWireSchema = z.object({
  id: identifier,
  conditionId: identifier,
  question: z.string().min(1),
  description: z.string().min(1),
  resolutionSource: z.string(),
  endDate: z.iso.datetime({ offset: true }),
  clobTokenIds: tokensSchema,
  outcomes: jsonArray.pipe(z.array(z.string().min(1)).min(2)),
  events: z.tuple([z.object({ id: identifier })]).rest(z.object({ id: identifier })),
  active: z.boolean(),
  closed: z.boolean(),
  acceptingOrders: z.boolean(),
  feesEnabled: z.boolean(),
  category: z.string().optional(),
}).refine(value => value.clobTokenIds.length === value.outcomes.length, 'Outcome and token counts differ')
const levelSchema = z.object({ price: probability, size: numericString.pipe(z.number().positive()) })
const bookWireSchema = z.object({
  market: identifier,
  asset_id: identifier,
  timestamp: numericString.pipe(z.number().int().positive()),
  bids: z.array(levelSchema),
  asks: z.array(levelSchema),
  min_order_size: numericString.pipe(z.number().positive()),
  tick_size: probability.pipe(z.number().positive()),
  neg_risk: z.boolean(),
  hash: z.string().min(1),
})
const feeSchema = z.object({
  mbf: z.number().int().nonnegative(),
  tbf: z.number().int().nonnegative(),
  fd: z.object({ r: z.number().nonnegative(), e: z.number().nonnegative(), to: z.boolean() }),
})
const resolutionSchema = z.object({
  conditionId: identifier,
  closed: z.boolean(),
  umaResolutionStatus: z.string().nullish(),
  clobTokenIds: tokensSchema,
  outcomePrices: jsonArray.pipe(z.array(probability).min(2)),
}).refine(value => value.clobTokenIds.length === value.outcomePrices.length, 'Payout and token counts differ')

/**
 * Reads configured Gamma/CLOB endpoints without authentication or trading operations.
 * Malformed responses reject the operation; redirects and oversized bodies are refused.
 * @param options - Explicit endpoint, request, discovery, and response limits.
 * @param fetcher - Per-instance transport; defaults to the current global fetch for each request.
 * Must honor the supplied AbortSignal through body reads.
 */
export class MarketDataClient {
  private readonly options: MarketDataOptions
  private activeRequests = 0
  private readonly waiters = new Set<() => void>()

  constructor(
    options: MarketDataOptions,
    private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {
    this.options = optionsSchema.parse(options)
  }

  /**
   * Inspect at most maxMarkets rows, retaining active markets that accept orders.
   * A configured watchlist reads those exact market IDs instead of the discovery feed.
   * Offset pagination is not a consistent snapshot; duplicates consume the inspection budget.
   * @param signal - Cancellation for the complete discovery operation.
   * @returns Unique eligible markets with each page's local receive timestamp.
   */
  async discover(signal: AbortSignal): Promise<Market[]> {
    const markets = new Map<ConditionId, Market>()
    if (this.options.marketIds.length > 0) {
      for (const id of this.options.marketIds) {
        const { value, observedAt } = await this.request(this.url(this.options.gammaUrl, `markets/${encodeURIComponent(id)}`), signal)
        const row = marketWireSchema.parse(value)
        if (row.id !== id) throw new Error('Polymarket market does not match the requested watchlist identifier')
        if (row.active && !row.closed && row.acceptingOrders) {
          const market = normalizeMarket(row, observedAt)
          markets.set(market.conditionId, market)
        }
      }
      return [...markets.values()]
    }
    let inspected = 0
    while (inspected < this.options.maxMarkets) {
      const limit = Math.min(100, this.options.maxMarkets - inspected)
      const url = this.url(this.options.gammaUrl, 'markets', {
        active: 'true', closed: 'false', limit: String(limit), offset: String(inspected),
        order: 'id', ascending: 'true',
      })
      const { value, observedAt } = await this.request(url, signal)
      const rows = z.array(marketWireSchema).max(limit).parse(value)
      for (const row of rows) {
        if (!row.active || row.closed || !row.acceptingOrders) continue
        const market = normalizeMarket(row, observedAt)
        markets.set(market.conditionId, market)
      }
      inspected += rows.length
      if (rows.length < limit) break
    }
    return [...markets.values()]
  }

  /**
   * Read and sort an outcome token's complete order book without assuming it is fresh.
   * @param tokenId - Token admitted from market metadata or durable validation.
   * @param signal - Cancellation for queue wait, transport, and body consumption.
   * @returns Validated book; mismatched token identifiers reject the read.
   */
  async book(tokenId: TokenId, signal: AbortSignal): Promise<Book> {
    const { value, observedAt } = await this.request(this.url(this.options.clobUrl, 'book', { token_id: tokenId }), signal)
    const row = bookWireSchema.parse(value)
    if (row.asset_id !== tokenId) throw new Error('Polymarket order book token does not match the requested token')
    return bookSchema.parse({
      tokenId, conditionId: brandString<ConditionId>(row.market), observedAt, timestamp: row.timestamp,
      bids: row.bids, asks: row.asks,
      minOrderSize: row.min_order_size, tickSize: row.tick_size, negRisk: row.neg_risk, hash: row.hash,
    })
  }

  /**
   * Read the current CLOB fee curve without inferring fees from category or Gamma flags.
   * @param conditionId - Condition whose fee parameters are requested.
   * @param signal - Cancellation for the request.
   * @returns Explicit parameters and local receive time; missing fields reject the read.
   */
  async feeParameters(conditionId: ConditionId, signal: AbortSignal): Promise<FeeParameters> {
    const { value, observedAt } = await this.request(this.url(this.options.clobUrl, `clob-markets/${encodeURIComponent(conditionId)}`), signal)
    const row = feeSchema.parse(value)
    return {
      conditionId, observedAt, rate: row.fd.r, exponent: row.fd.e, takerOnly: row.fd.to,
      makerBaseFeeBps: row.mbf, takerBaseFeeBps: row.tbf,
    }
  }

  /**
   * Read Gamma's reported resolution without treating market closure or prices as finality.
   * Only closed, explicitly resolved markets with terminal payouts return reported-final.
   * @param conditionId - Condition whose resolution is requested.
   * @param signal - Cancellation for the request.
   * @returns Reported evidence, including unknown for absent or inconsistent finality.
   */
  async resolution(conditionId: ConditionId, signal: AbortSignal): Promise<Resolution> {
    const { value, observedAt } = await this.request(this.url(this.options.gammaUrl, 'markets', { condition_ids: conditionId, limit: '2' }), signal)
    const rows = z.array(resolutionSchema).max(1).parse(value)
    const row = rows[0]
    if (!row) return { conditionId, observedAt, sourceStatus: null, status: 'unknown', payouts: [] }
    if (row.conditionId !== conditionId) throw new Error('Polymarket resolution condition does not match the requested condition')
    const base = { conditionId, observedAt, sourceStatus: row.umaResolutionStatus ?? null }
    if (row.umaResolutionStatus !== 'resolved') {
      return { ...base, status: !row.closed || ['proposed', 'disputed'].includes(row.umaResolutionStatus ?? '') ? 'unresolved' : 'unknown', payouts: [] }
    }
    const prices = row.outcomePrices
    const terminal = prices.every(price => price === 0 || price === 1) && prices.reduce<number>((sum, price) => sum + price, 0) === 1
    const split = prices.length === 2 && prices.every(price => price === 0.5)
    if (!row.closed || (!terminal && !split)) return { ...base, status: 'unknown', payouts: [] }
    return {
      ...base, status: 'reported-final',
      payouts: row.clobTokenIds.map((tokenId, index) => ({ tokenId: brandString<TokenId>(tokenId), payout: prices[index] as number })),
    }
  }

  private url(base: string, path: string, parameters: Record<string, string> = {}): URL {
    const url = new URL(path, base.endsWith('/') ? base : `${base}/`)
    url.search = new URLSearchParams(parameters).toString()
    return url
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.activeRequests < this.options.concurrency) {
      this.activeRequests++
      return
    }
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal.removeEventListener('abort', aborted)
        this.activeRequests++
        resolve()
      }
      const aborted = () => {
        this.waiters.delete(ready)
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Cancellation preserves the caller's exact AbortSignal.reason.
        reject(signal.reason)
      }
      this.waiters.add(ready)
      signal.addEventListener('abort', aborted, { once: true })
    })
  }

  private async request(url: URL, callerSignal: AbortSignal): Promise<{ value: unknown; observedAt: number }> {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new DOMException('Polymarket data request timed out', 'TimeoutError'))
    }, this.options.timeoutMs)
    const signal = AbortSignal.any([callerSignal, controller.signal])
    let acquired = false
    try {
      await this.acquire(signal)
      acquired = true
      signal.throwIfAborted()
      const response = await this.fetcher(url, { method: 'GET', redirect: 'error', signal, headers: { accept: 'application/json' } })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Polymarket ${url.pathname} returned HTTP ${response.status}`)
      }
      if (!response.body) throw new Error('Polymarket response has no body')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          signal.throwIfAborted()
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > this.options.maxResponseBytes) throw new Error('Polymarket response exceeds maxResponseBytes')
          chunks.push(chunk.value)
        }
      } finally {
        await reader.cancel()
        reader.releaseLock()
      }
      const observedAt = Date.now()
      signal.throwIfAborted()
      const value: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
      return { value, observedAt }
    } finally {
      clearTimeout(timer)
      if (acquired) {
        this.activeRequests--
        const next = this.waiters.values().next().value
        if (next) {
          this.waiters.delete(next)
          next()
        }
      }
    }
  }
}

function normalizeMarket(row: z.infer<typeof marketWireSchema>, observedAt: number): Market {
  return {
    id: brandString<MarketId>(row.id), conditionId: brandString<ConditionId>(row.conditionId),
    eventId: brandString<EventId>(row.events[0].id),
    question: row.question, description: row.description,
    resolutionSource: row.resolutionSource, endDate: row.endDate,
    tokens: row.clobTokenIds.map((id, index) => ({ id: brandString<TokenId>(id), outcome: row.outcomes[index] as string })),
    active: row.active, closed: row.closed, acceptingOrders: row.acceptingOrders,
    feesEnabled: row.feesEnabled, observedAt,
    ...(row.category === undefined ? {} : { category: row.category }),
  }
}
