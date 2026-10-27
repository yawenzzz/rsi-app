/** Per-composition external model adapter registration. */
import type { Context } from '@deepseek-ai/cordis'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'

/**
 * Bind one test-owned model script to the fixture route.
 * @param adapter - Script and captured requests belonging to one composition.
 * @returns Loader plugin whose disposal removes the external model adapter.
 */
export function createProvider(adapter: LlmAdapter) {
  return {
    name: 'fixture-llm', inject: ['llm'],
    apply: (ctx: Context) => {
      ctx.effect(() => ctx.llm.registerAdapter(['fixture'], adapter))
    },
  }
}
