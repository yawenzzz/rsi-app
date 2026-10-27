/** RSI endpoints use the official authenticated DSH Fetch registry. */
import type { Context } from '@deepseek-ai/cordis'
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import { z } from 'zod'

export type RpcHandler = (args: unknown, signal: AbortSignal) => unknown | Promise<unknown>

/** Validate one request before invoking its typed operation. */
export function rpcMethod<T>(schema: z.ZodType<T>, invoke: (args: T, signal: AbortSignal) => unknown | Promise<unknown>): RpcHandler {
  return (args, signal) => invoke(schema.parse(args), signal)
}

/** Register bounded routes inside DSH's authenticated /api transport. */
export function installRpc(ctx: Context, namespace: string, methods: Record<string, RpcHandler>, maxBytes: number): void {
  for (const [name, handler] of Object.entries(methods)) {
    const method = `${namespace}/${name}`
    ctx.effect(() => ctx.connection.fetch.register({
      path: `/api/${method}`, methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        if (request.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {
          return new Response('Expected application/json', { status: 415 })
        }
        const text = await request.text()
        if (Buffer.byteLength(text) > maxBytes) return new Response('RSI request exceeds its configured limit', { status: 413 })
        let input: z.infer<typeof clientRequestSchema>
        try {
          input = clientRequestSchema.parse(JSON.parse(text))
          if (input.method !== method) return new Response('RPC method does not match its route', { status: 400 })
        } catch { return new Response('Invalid RSI request envelope', { status: 400 }) }
        let result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: object } }
        try {
          request.signal.throwIfAborted()
          const payload = z.strictObject({ args: z.unknown() }).parse(input.payload)
          result = { ok: true, value: await handler(payload.args, request.signal) }
        } catch (error) {
          result = { ok: false, error: { code: error instanceof z.ZodError ? 'rsi/invalid-request' : 'rsi/operation-failed',
            message: error instanceof Error ? error.message : 'RSI operation failed', details: {} } }
        }
        return Response.json({ type: 'server-response', rpcId: input.rpcId, result })
      },
    }))
  }
}
