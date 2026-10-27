/** RSI project navigation and task review through unmodified official DSH client slots. */
import type { Context } from '@deepseek-ai/cordis'
import { mountRsiUi } from './mount.ts'

export { inject } from './mount.ts'

/**
 * Register project and workflow pages in the current native Web application.
 * @param ctx - Official browser plugin services.
 */
export function apply(ctx: Context): void { mountRsiUi(ctx) }
