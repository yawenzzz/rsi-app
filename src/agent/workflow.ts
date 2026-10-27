/** Cognitive task policy remains independent of provider-owned persona sections. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

/**
 * Register four-phase guidance in the project's logged system prompt.
 * @param ctx - Project profile context and lifecycle owner.
 * @param instructions - Deployment-authored task workflow.
 */
export function installWorkflow(ctx: Context, instructions: string): void {
  ctx.effect(() => ctx.systemPrompt.section({ name: 'rsi:workflow', order: 10, text: instructions }))
}
