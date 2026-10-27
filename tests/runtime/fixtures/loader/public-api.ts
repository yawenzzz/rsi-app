/** Per-composition Polymarket HTTP fixture with externally observable request ownership. */
import { createServer, type Server } from 'node:http'

/** Mutable upstream evidence shared by requests to one fixture server. */
export interface PublicApiFixture {
  url: string
  requests: Array<{ method: string; path: string; query: string }>
  resolved: boolean
  failRequests: boolean
  evidenceText: string
  jevRequests: Array<{ authorization: string | undefined; body: unknown }>
  jevResponse: unknown
  /** Stop accepting requests and await closure of every owned connection. */
  close(): Promise<void>
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
    server.closeAllConnections()
  })
}

/**
 * Bind a fresh loopback server that implements only the public reads used by this composition.
 * @returns Ready fixture whose caller owns asynchronous closure.
 */
export async function startPublicApi(): Promise<PublicApiFixture> {
  const fixture: PublicApiFixture = {
    url: '', requests: [], resolved: false, failRequests: false,
    evidenceText: 'Initial official estimate: 2.4%.', jevRequests: [], jevResponse: null,
    close: () => closeServer(server),
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid')
    fixture.requests.push({ method: request.method ?? '', path: url.pathname, query: url.search })
    response.setHeader('content-type', 'application/json')
    if (fixture.failRequests) {
      response.writeHead(503).end(JSON.stringify({ error: 'fixture unavailable' }))
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/systemone') {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        const value: unknown = JSON.parse(body)
        fixture.jevRequests.push({ authorization: request.headers.authorization, body: value })
        response.end(JSON.stringify(fixture.jevResponse))
      })
      return
    }
    if (request.method !== 'GET') {
      response.writeHead(405).end(JSON.stringify({ error: 'read-only public fixture' }))
      return
    }
    if (url.pathname === '/evidence') {
      response.setHeader('content-type', 'text/plain; charset=utf-8')
      response.end(fixture.evidenceText)
      return
    }
    if (url.pathname === '/markets') {
      const condition = url.searchParams.get('condition_ids')
      if (condition !== null) {
        response.end(JSON.stringify(condition === 'loader-condition' ? [{
          conditionId: condition,
          closed: fixture.resolved,
          umaResolutionStatus: fixture.resolved ? 'resolved' : null,
          clobTokenIds: JSON.stringify(['yes-token', 'no-token']),
          outcomePrices: JSON.stringify(fixture.resolved ? ['1', '0'] : ['0.5', '0.5']),
        }] : []))
        return
      }
      response.end(JSON.stringify(url.searchParams.get('offset') === '0' ? [{
        id: 'loader-market', conditionId: 'loader-condition', events: [{ id: 'loader-event' }],
        question: 'Will the fixture report YES?', description: 'YES resolves from the fixture observation.',
        resolutionSource: 'https://fixture.invalid/result', endDate: '2099-01-01T00:00:00Z',
        clobTokenIds: JSON.stringify(['yes-token', 'no-token']), outcomes: JSON.stringify(['Yes', 'No']),
        active: true, closed: false, acceptingOrders: true, feesEnabled: false,
      }] : []))
      return
    }
    if (url.pathname === '/book' && ['yes-token', 'no-token'].includes(url.searchParams.get('token_id') ?? '')) {
      response.end(JSON.stringify({
        market: 'loader-condition', asset_id: url.searchParams.get('token_id'), timestamp: String(Date.now()),
        bids: [{ price: '0.49', size: '100' }], asks: [{ price: '0.51', size: '100' }],
        min_order_size: '1', tick_size: '0.01', neg_risk: false, hash: 'fixture-book',
      }))
      return
    }
    if (url.pathname === '/clob-markets/loader-condition') {
      response.end(JSON.stringify({ mbf: 0, tbf: 0, fd: { r: 0, e: 1, to: false } }))
      return
    }
    response.writeHead(404).end(JSON.stringify({ error: 'unexpected fixture endpoint' }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    await closeServer(server)
    throw new Error('Polymarket fixture did not bind a TCP address')
  }
  fixture.url = `http://127.0.0.1:${address.port}`
  return fixture
}
