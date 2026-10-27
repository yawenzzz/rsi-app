/** Local synthetic Gamma/CLOB responses for real-profile console verification. */
import { createServer } from 'node:http'

/**
 * Serve clearly labelled fixture markets through the real HTTP adapter.
 * @param portfolio - Enable isolated training, settlement and stale-data phases controlled by the console seed.
 * @returns the bound URL and an awaited close operation owned by the caller.
 */
export async function startMarketApi(portfolio = false): Promise<{ url: string; close: () => Promise<void> }> {
  let phase = portfolio ? 'training' : 'evidence'
  let stale = false
  const training = Array.from({ length: 40 }, (_, index) => `training-${index}`)
  const payout = (name: string): number | null => {
    if (name.startsWith('training-') && phase !== 'training') return 1
    if (name === 'macro' && ['win', 'loss'].includes(phase)) return 1
    if (name === 'weather' && phase === 'loss') return 0
    return null
  }
  const market = (name: string) => ({
    id: `fixture-${name}`, conditionId: `fixture-${name}`, events: [{ id: `fixture-event-${name}` }],
    question: name.startsWith('training-') ? `合成验证事件 ${name}` : name === 'macro' ? '测试市场：未来事件是否发生？'
      : name === 'energy' ? '测试市场：能源事件是否发生？' : '测试市场：天气事件是否发生？',
    description: 'Synthetic console fixture. No real event or trading performance is represented.',
    resolutionSource: 'https://fixture.test/resolution', category: name === 'macro' ? 'Macro' : name === 'energy' ? 'Energy' : 'Weather',
    endDate: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    clobTokenIds: JSON.stringify([`fixture-${name}-yes`, `fixture-${name}-no`]), outcomes: '["Yes","No"]',
    active: payout(name) === null, closed: payout(name) !== null, acceptingOrders: payout(name) === null,
    feesEnabled: true, umaResolutionStatus: payout(name) === null ? 'proposed' : 'resolved',
    outcomePrices: payout(name) === null ? '["0.5","0.5"]' : JSON.stringify([String(payout(name)), String(1 - (payout(name) as number))]),
  })
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (portfolio && request.method === 'POST' && request.headers['x-rsi-console-fixture'] === 'portfolio') {
      const next = url.pathname.slice('/fixture/'.length)
      if (url.pathname.startsWith('/fixture/') && ['positions', 'win', 'loss', 'stale'].includes(next)) {
        if (next === 'stale') stale = true
        else { phase = next; stale = false }
        response.end('{}')
        return
      }
    }
    if (request.method !== 'GET') { response.writeHead(405).end('{}'); return }
    if (url.pathname === '/markets') {
      const condition = url.searchParams.get('condition_ids')
      const names = phase === 'training' ? training : phase === 'loss' ? ['energy'] : phase === 'win' ? ['weather', 'energy'] : ['macro', 'weather']
      const rows = condition === null ? names.map(market) : [...training, 'macro', 'weather', 'energy']
        .filter(name => `fixture-${name}` === condition).map(market)
      response.end(JSON.stringify(rows))
      return
    }
    if (url.pathname.startsWith('/clob-markets/')) {
      response.end(JSON.stringify({ mbf: 0, tbf: 0, fd: { r: 0.02, e: 1, to: true } }))
      return
    }
    if (url.pathname === '/book') {
      const token = url.searchParams.get('token_id') ?? ''
      const name = token.replace(/^fixture-/, '').replace(/-(yes|no)$/, '')
      const offset = token.endsWith('-no') ? 0.1 : 0
      const trainingOffset = name.startsWith('training-') ? -0.36 : 0
      const price = (value: number) => String(value + offset + trainingOffset)
      response.end(JSON.stringify({
        market: `fixture-${name}`, asset_id: token, timestamp: String(Date.now() - (stale ? 7_200_000 : 0)), hash: `synthetic-book-${token}`,
        bids: [{ price: price(0.44), size: '4000' }, { price: price(0.42), size: '6000' }, { price: price(0.4), size: '5000' }],
        asks: [{ price: price(0.46), size: '3000' }, { price: price(0.48), size: '7000' }, { price: price(0.5), size: '5000' }],
        min_order_size: '5', tick_size: '0.01', neg_risk: false,
      }))
      return
    }
    response.writeHead(404).end('{}')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture server did not bind a TCP port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve() })
        server.closeAllConnections()
      })
    },
  }
}
