/** Authenticated per-Agent control access; the dispatch closure fixes project ownership. */
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'

/** Operations exposed to one Agent; none accepts another Agent identity or a Harness version. */
export const controlOperationSchema = z.enum(['context', 'cognition', 'update', 'plugins', 'register', 'select', 'ui'])
/** One request supported by the project control channel. */
export type AgentControlOperation = z.infer<typeof controlOperationSchema>

/**
 * Bind a scoped control endpoint and retain all in-flight calls through teardown.
 * @param dispatch - Operations closed over the owning project.
 * @param maxBytes - Complete request and response allowance.
 * @returns process environment and a disposer that reaches quiescence.
 */
export async function openAgentControl(
  dispatch: (operation: AgentControlOperation, request: unknown) => Promise<unknown>, maxBytes: number,
): Promise<{ env: Record<string, string>; close: () => Promise<void> }> {
  const token = randomBytes(32).toString('hex')
  const pending = new Set<Promise<void>>()
  const server = createServer((request, response) => {
    const work = (async () => {
      response.setHeader('content-type', 'application/json')
      try {
        if (request.method !== 'POST' || request.url !== '/' || request.headers.authorization !== `Bearer ${token}`) {
          response.writeHead(403).end(JSON.stringify({ error: 'Agent access denied' }))
          return
        }
        let bytes = 0
        const chunks: Buffer[] = []
        for await (const chunk of request) {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
          bytes += value.length
          if (bytes > maxBytes) throw new Error('Agent request exceeds its byte allowance')
          chunks.push(value)
        }
        const input = z.strictObject({ operation: controlOperationSchema, request: z.unknown() })
          .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        const output = JSON.stringify({ result: await dispatch(input.operation, input.request) })
        if (Buffer.byteLength(output) > maxBytes) throw new Error('Agent response exceeds its byte allowance')
        response.end(output)
      } catch (error) {
        const output = JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
        response.writeHead(400).end(Buffer.byteLength(output) <= maxBytes ? output : '{"error":"Agent operation failed"}')
      }
    })()
    pending.add(work)
    void work.then(() => { pending.delete(work) }, () => { pending.delete(work); response.destroy() })
  })
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await listening
  const address = server.address() as AddressInfo
  return {
    env: { DSH_AGENT_CONTROL_URL: `http://127.0.0.1:${address.port}/`, DSH_AGENT_CONTROL_TOKEN: token },
    async close() {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve() })
      })
      server.closeAllConnections()
      await Promise.allSettled(pending)
      await closed
    },
  }
}
