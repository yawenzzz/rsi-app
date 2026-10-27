/** RSI Fetch routes validate wire input while DSH owns browser authentication. */
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { fromPartial } from '@total-typescript/shoehorn'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { installRpc, rpcMethod } from '../../src/shared/rpc.ts'
import { managerHandlers, managerRequestSchema } from '../../src/harness/rpc.ts'
import type { AgentWorkspaces } from '../../src/harness/index.ts'

async function fixture(limit = 1024) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const routes = new Map<string, ConnectionFetchRoute>()
  ctx.provide('connection', fromPartial<Context['connection']>({ fetch: {
    register(route: ConnectionFetchRoute) {
      routes.set(route.path, route)
      return async () => { routes.delete(route.path) }
    },
  } }))
  const operation = vi.fn((args: { value: string }) => ({ saved: args.value }))
  installRpc(ctx, 'rsi-test', { save: rpcMethod(z.strictObject({ value: z.string() }), operation) }, limit)
  const route = routes.get('/api/rsi-test/save')!
  const request = (body: unknown, contentType = 'application/json') => route.fetch(new Request('http://localhost/api/rsi-test/save', {
    method: 'POST', headers: { 'content-type': contentType }, body: typeof body === 'string' ? body : JSON.stringify(body),
  }))
  const envelope = (args: unknown, method = 'rsi-test/save') => ({
    type: 'client-request', rpcId: 'test-call', method, payload: { args },
  })
  return { ctx, routes, route, operation, request, envelope }
}

it('registers exact POST routes with official body buffering and releases them on disposal', async () => {
  const f = await fixture()
  expect(f.route).toMatchObject({ path: '/api/rsi-test/save', methods: ['POST'], requestBody: 'buffered' })
  await f.ctx.fiber.dispose()
  expect(f.routes.size).toBe(0)
})

it('preserves the request identity and returns the validated operation result', async () => {
  const f = await fixture()
  const response = await f.request(f.envelope({ value: 'project configuration' }), 'application/json; charset=utf-8')
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ type: 'server-response', rpcId: 'test-call', result: { ok: true, value: { saved: 'project configuration' } } })
  expect(f.operation).toHaveBeenCalledOnce()
})

it('rejects an invalid envelope, route mismatch and unsupported content type before invocation', async () => {
  const f = await fixture()
  expect((await f.request('{')).status).toBe(400)
  expect((await f.request({ method: 'rsi-test/save' })).status).toBe(400)
  expect((await f.request(f.envelope({ value: 'wrong route' }, 'rsi-test/remove'))).status).toBe(400)
  expect((await f.request(f.envelope({ value: 'wrong type' }), 'text/plain')).status).toBe(415)
  expect(f.operation).not.toHaveBeenCalled()
})

it('bounds the complete UTF-8 request before parsing or mutating state', async () => {
  const f = await fixture(200)
  expect((await f.request(f.envelope({ value: '证据'.repeat(100) }))).status).toBe(413)
  expect(f.operation).not.toHaveBeenCalled()
})

it('distinguishes argument validation from operation failures without returning success', async () => {
  const f = await fixture()
  const invalid = await f.request(f.envelope({ value: 8, extra: true }))
  expect(await invalid.json()).toMatchObject({ result: { ok: false, error: { code: 'rsi/invalid-request' } } })
  expect(f.operation).not.toHaveBeenCalled()
  f.operation.mockImplementationOnce(() => { throw new Error('Project is busy') })
  const failed = await f.request(f.envelope({ value: 'saved' }))
  expect(await failed.json()).toMatchObject({ result: { ok: false, error: { code: 'rsi/operation-failed', message: 'Project is busy' } } })
})

it('routes explicit human reviews separately from model cognitive commands', async () => {
  const id = 'a-00000000-0000-4000-8000-000000000001'
  const review = { revision: 0, taskId: '00000000-0000-4000-8000-000000000002', target: null,
    evidenceIds: ['00000000-0000-4000-8000-000000000003'], knowledge: null, effectiveness: 1, rationale: 'Accepted observed output.' }
  const reviewCognition = vi.fn(async () => ({ revision: 1 }))
  const updateCognition = vi.fn(async () => ({ revision: 1 }))
  const handlers = managerHandlers(fromPartial<AgentWorkspaces>({ reviewCognition, updateCognition }))
  expect(() => handlers.updateCognition({ id, request: { ...review, action: 'review' } }, new AbortController().signal)).toThrow()
  expect(updateCognition).not.toHaveBeenCalled()
  expect(reviewCognition).not.toHaveBeenCalled()
  expect(await handlers.reviewCognition({ id, request: review }, new AbortController().signal)).toEqual({ revision: 1 })
  expect(reviewCognition).toHaveBeenCalledWith(review, id)
  expect(managerRequestSchema.safeParse({ method: 'constructor', args: {} }).success).toBe(false)
})
