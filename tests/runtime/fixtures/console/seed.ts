/** Candidate and optional local-market data for an isolated, keyless console verification profile. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../../../../src/runtime/index.ts'

/** The fixture waits for the normal product runtime to open its durable owners. */
export const inject = ['rsi']

/**
 * Populate a new fixture account through normal candidate registration.
 * @param ctx - The isolated profile's ready product context.
 * @returns after candidate and configured fixture evidence is retained; no purchase or model request is made.
 */
export async function apply(ctx: Context): Promise<void> {
  const runtime = ctx.rsi.runtime
  if (runtime.status().objective !== 'Synthetic console verification — no trading performance'
    || runtime.config.autoTick || runtime.config.research.enabled) {
    throw new Error('Console fixture requires its explicit synthetic objective')
  }
  const parent = await runtime.registerCandidate({ name: '概率校准基线',
    thesis: 'Synthetic UI fixture: baseline candidate without performance evidence.', minEdge: 0.05, kellyFraction: 0.1 })
  await runtime.registerCandidate({ name: '流动性过滤', parentId: parent.id,
    thesis: 'Synthetic UI fixture: candidate derived from the baseline.', minEdge: 0.06, kellyFraction: 0.08 })
  await runtime.registerCandidate({ name: '事件分组研究', parentId: parent.id,
    thesis: 'Synthetic UI fixture: unresolved independence research.', minEdge: 0.07, kellyFraction: 0.05 })
  if (new URL(runtime.config.data.gammaUrl).hostname === '127.0.0.1') {
    await runtime.tick()
    const observation = runtime.status().observations.find(item => item.tokenId === 'fixture-macro-yes')
    if (observation === undefined) throw new Error('Synthetic market observation is missing')
    if (!runtime.experiments.view().forecasts.some(item => item.candidateId === parent.id)) {
      await runtime.forecast(observation.id, { candidateId: parent.id, probability: 0.65, uncertainty: 0.1,
        evidence: [
          { url: 'https://fixture.test/support', text: '测试支持依据：用于核对证据分组和来源链接。', stance: 'supports' },
          { url: 'https://fixture.test/against', text: '测试矛盾依据：保留相反信息，不代表真实事件判断。', stance: 'contradicts' },
          { url: 'https://fixture.test/context', text: '测试背景资料：本页面的数据来自独立验证目录。', stance: 'context' },
        ] })
    }
    await runtime.tick()
  }
}
