/** Synthetic filled positions and settlement history through the shipped runtime's normal operations. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../../../../src/runtime/index.ts'

/** The seeder requires the isolated profile's ready runtime. */
export const inject = ['rsi']

/**
 * Exercise prospective qualification, paper purchases and final payouts against a local fixture server.
 * @param ctx - Product context with automatic research and collection disabled.
 * @returns after retaining two synthetic settlements, one paused holding and a rejected stale-data refresh.
 */
export async function apply(ctx: Context): Promise<void> {
  const runtime = ctx.rsi.runtime
  const endpoint = new URL(runtime.config.data.gammaUrl)
  if (runtime.status().objective !== 'Synthetic console verification — no trading performance'
    || runtime.config.autoTick || runtime.config.research.enabled || endpoint.hostname !== '127.0.0.1') {
    throw new Error('Portfolio fixture requires its isolated synthetic profile and local market API')
  }
  const stage = async (name: string) => {
    const response = await fetch(new URL(`/fixture/${name}`, endpoint), {
      method: 'POST', headers: { 'x-rsi-console-fixture': 'portfolio' }, signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error(`Portfolio fixture stage failed: ${name}`)
    await response.json()
  }
  if (runtime.ledger.view().settlements.length >= 2) { await stage('loss'); return }
  const candidate = await runtime.registerCandidate({ name: '合成策略验证',
    thesis: 'Synthetic fixture outcomes exercise UI receipts; they are not trading performance evidence.',
    minEdge: 0.05, kellyFraction: 0.1 })
  await runtime.registerCandidate({ name: '合成后续研究', parentId: candidate.id,
    thesis: 'Synthetic candidate lineage without qualification evidence.', minEdge: 0.06, kellyFraction: 0.08 })
  const forecast = async (token: string, probability: number) => {
    const observation = runtime.consoleSource().observations.findLast(item => item.book.tokenId === token)
    if (observation === undefined) throw new Error(`Missing synthetic observation: ${token}`)
    await runtime.forecast(observation.id, { candidateId: candidate.id, probability, uncertainty: 0.05,
      evidence: [{ url: 'https://fixture.test/portfolio', stance: 'context', text: '合成验证数据，不代表真实策略表现。' }] })
  }
  await runtime.tick()
  for (let index = 0; index < 40; index++) await forecast(`fixture-training-${index}-yes`, 0.9)
  await stage('positions')
  await runtime.tick()
  if (runtime.experiments.rank().find(item => item.candidateId === candidate.id)?.status !== 'paper-eligible') {
    throw new Error('Synthetic prospective samples did not qualify the fixture')
  }
  await forecast('fixture-macro-yes', 0.8)
  await runtime.control({ expectedRevision: runtime.status().controlRevision, action: 'resume', reason: 'Synthetic portfolio verification' })
  await runtime.tick()
  await stage('win')
  await runtime.tick()
  await forecast('fixture-weather-yes', 0.8)
  await runtime.tick()
  await stage('loss')
  await runtime.tick()
  await forecast('fixture-energy-yes', 0.8)
  await runtime.tick()
  await runtime.control({ expectedRevision: runtime.status().controlRevision, action: 'pause', reason: 'Synthetic portfolio verification complete' })
  await stage('stale')
  await runtime.tick()
  const account = runtime.ledger.view()
  if (account.positions.length !== 1 || account.settlements.length !== 2 || account.trades.length !== 3) {
    throw new Error('Synthetic portfolio did not retain the expected three purchases and two settlements')
  }
}
