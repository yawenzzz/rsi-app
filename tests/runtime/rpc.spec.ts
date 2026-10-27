/** Paper HTTP controls validate ownership fields before invoking the financial service. */
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { fromPartial } from '@total-typescript/shoehorn'
import { expect, it, onTestFinished, vi } from 'vitest'
import { installPaperRpc } from '../../src/runtime/rpc.ts'
import type { RsiService } from '../../src/runtime/index.ts'

function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const routes = new Map<string, ConnectionFetchRoute>()
  ctx.provide('connection', fromPartial<Context['connection']>({ fetch: {
    register(route: ConnectionFetchRoute) {
      routes.set(route.path, route)
      return async () => { routes.delete(route.path) }
    },
  } }))
  const control = vi.fn<RsiService['remoteControl']>().mockResolvedValue(fromPartial({}))
  const opportunities = vi.fn<RsiService['remoteOpportunities']>().mockReturnValue(fromPartial({}))
  installPaperRpc(ctx, fromPartial<RsiService>({ remoteControl: control, remoteOpportunities: opportunities }), 4096)
  const request = async (name: string, args: unknown) => {
    const method = `rsi/${name}`
    const response = await routes.get(`/api/${method}`)!.fetch(new Request(`http://localhost/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'paper-request', method, payload: { args } }),
    }))
    return response.json()
  }
  return { routes, request, control, opportunities }
}

it('accepts only revisioned paper permission changes and refuses capital overrides', async () => {
  const f = fixture()
  const command = { expectedRevision: 3, action: 'resume', reason: 'Operator resumed paper purchases' }
  expect(await f.request('control', { command })).toMatchObject({ result: { ok: true } })
  expect(f.control).toHaveBeenCalledWith(command)
  f.control.mockClear()
  for (const invalid of [
    { ...command, expectedRevision: -1 },
    { ...command, initialCapitalMicros: 1_000_000_000 },
    { ...command, action: 'trade-live' },
  ]) {
    expect(await f.request('control', { command: invalid })).toMatchObject({ result: { ok: false, error: { code: 'rsi/invalid-request' } } })
  }
  expect(f.control).not.toHaveBeenCalled()
})

it('rejects invalid query bounds before reading paper observations', async () => {
  const f = fixture()
  const query = { search: '', category: null, state: null, minLiquidityMicros: 0, maxHorizonMs: null,
    maxAgeMs: null, order: 'newest', cursor: null, limit: 100 }
  expect(await f.request('opportunities', { query })).toMatchObject({ result: { ok: true } })
  expect(f.opportunities).toHaveBeenCalledWith(query)
  f.opportunities.mockClear()
  for (const limit of [0, 101, 1.5]) {
    expect(await f.request('opportunities', { query: { ...query, limit } })).toMatchObject({ result: { ok: false, error: { code: 'rsi/invalid-request' } } })
  }
  expect(f.opportunities).not.toHaveBeenCalled()
})
