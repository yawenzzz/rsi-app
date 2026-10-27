/** Loader-owned Web provider for the fixture's public source endpoint. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-web'

export const name = 'fixture-evidence'
export const inject = ['web']

/**
 * Register real HTTP reads against the loopback evidence endpoint.
 * @param ctx - Fixture scope owning provider registration and disposal.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.web.registerFetchProvider({
    id: 'fixture-evidence',
    available: () => true,
    async fetch(request, signal) {
      const url = new URL(request.url)
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/evidence') {
        throw new Error('Evidence fixture accepts only its loopback source endpoint')
      }
      const response = await fetch(url, { redirect: 'error', ...(signal === undefined ? {} : { signal }) })
      return { url: response.url, statusCode: response.status,
        body: { kind: 'text', content: await response.text() }, truncated: false }
    },
  }))
}
