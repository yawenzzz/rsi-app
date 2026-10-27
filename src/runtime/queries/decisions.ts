/** Unified timeline projected from original receipts and retained nonfinancial outcomes. */
import { decisionQuerySchema } from './schemas.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CandidateId } from '../strategy/experiment-schema.ts'
import type { ConsoleSource } from './source.ts'
import type { ConsolePage, DecisionDetail, DecisionId, DecisionQuery, DecisionView } from './types.ts'
import { explainQuote } from './pricing.ts'
import { pageOf } from './pagination.ts'
import { forecastDecisionId, forecastHistory } from './decision-ids.ts'
import { forecastRevision } from '../strategy/forecasts.ts'
import type { ReleaseId, ReleaseRecord } from '../evolution/release-types.ts'
import { releaseCheckPassed } from '../evolution/releases.ts'

function record(id: string, fields: Omit<DecisionView, 'id'>, explanation: string): DecisionDetail {
  return { decision: { id: brandString<DecisionId>(id), ...fields }, references: [], checks: [], pricing: null, explanation }
}

function releaseDecision(release: Pick<ReleaseRecord, 'id' | 'candidateSha' | 'completedAt' | 'outcome'>): DecisionDetail {
  return record(`release:${release.id}`, { at: release.completedAt, kind: 'release',
    outcome: release.outcome === 'validated' ? 'completed' : 'failed', summary: `release.${release.outcome}`,
    releaseCommit: release.candidateSha, question: null, amountMicros: null, observationId: null, candidateId: null, sessionId: null }, '')
}

/**
 * Join distinct receipt authorities using namespaced stable identities.
 * @param source - Snapshot of committed research, ledger and journal owners.
 * @returns newest-first details; journal rows do not fabricate financial transitions.
 */
export function decisionViews(source: ConsoleSource): DecisionDetail[] {
  const rows = [...source.journal]
  const forecasts = forecastHistory(source.research)
  const forecastOrder = new Map(forecasts.map((forecast, index) => [forecastDecisionId(forecast), index]))
  if (source.releases !== null) rows.push(...source.releases.list().map(releaseDecision))
  for (const forecast of forecasts) {
    const observation = source.observations.find(item => item.id === forecast.observation.observationId)
    const detail = record(forecastDecisionId(forecast), {
      at: forecast.receivedAt, kind: 'forecast', outcome: 'completed', summary: 'forecast.recorded',
      question: observation?.market.question ?? null, amountMicros: null,
      observationId: forecast.observation.observationId, candidateId: forecast.candidateId, sessionId: null,
    }, forecast.evidence.map(item => item.text).join('\n'))
    detail.references = forecast.evidence.map(item => ({ kind: 'source', value: item.url }))
    rows.push(detail)
  }
  for (const receipt of source.account.trades) {
    const intent = receipt.intent
    const candidateId = brandString<CandidateId>(intent.strategyVersion)
    const observation = source.observations.find(item => item.id === intent.evidenceRef)
    const detail = record(`trade:${intent.id}`, { at: receipt.executedAt, kind: 'trade', outcome: 'completed', summary: 'trade.committed',
      question: observation?.market.question ?? null, amountMicros: intent.costMicros, observationId: intent.evidenceRef,
      candidateId, sessionId: null }, '')
    detail.references = [{ kind: 'intent', value: intent.id }, { kind: 'observation', value: intent.evidenceRef },
      { kind: 'candidate', value: intent.strategyVersion },
      { kind: 'sequence', value: String(receipt.sequence) }, { kind: 'cashAfterMicros', value: String(receipt.cashAfterMicros) }]
    const assessment = intent.assessment
    const forecast = forecasts.find(item => item.candidateId === candidateId
      && item.observation.eventId === intent.eventId && item.observation.tokenId === intent.tokenId
      && (assessment === undefined ? forecastRevision(item) === 0
        : item.observation.observationId === assessment.forecastObservationId && item.receivedAt === assessment.forecastReceivedAt
          && forecastRevision(item) === (assessment.forecastRevision ?? 0)))
    if (forecast !== undefined) detail.references.push({ kind: 'forecast', value: forecastDecisionId(forecast) })
    if (intent.assessment !== undefined) {
      detail.assessment = intent.assessment
      detail.checks = intent.assessment.sizing.checks
      detail.pricing = intent.assessment.sizing.quote
    } else detail.pricing = observation === undefined ? null : explainQuote(observation, intent.quantity)
    rows.push(detail)
  }
  for (const receipt of source.account.settlements) {
    const observation = source.observations.find(item => item.book.tokenId === receipt.settlement.tokenId)
    const detail = record(`settlement:${receipt.settlement.tokenId}`, {
      at: receipt.settledAt, kind: 'settlement', outcome: 'completed', summary: 'settlement.committed',
      question: observation?.market.question ?? null, amountMicros: receipt.profitMicros,
      observationId: observation?.id ?? null, candidateId: null, sessionId: null,
    }, '')
    detail.references = [{ kind: 'resolution', value: receipt.settlement.resolutionRef },
      { kind: 'payoutMicros', value: String(receipt.payoutMicros) }, { kind: 'cashAfterMicros', value: String(receipt.cashAfterMicros) }]
    rows.push(detail)
  }
  for (const run of source.state.researchRuns) {
    rows.push(record(`research:${run.id}`, {
      at: run.finishedAt ?? run.startedAt, kind: 'research', outcome: run.state, summary: `research.${run.state}`,
      question: null, amountMicros: null, observationId: null, candidateId: null, sessionId: run.sessionId,
    }, run.error ?? ''))
  }
  for (const event of source.account.audit) {
    if (event.kind !== 'control') continue
    rows.push(record(`control:${event.sequence}`, {
      at: event.at, kind: 'control', outcome: 'completed', summary: `control.${event.action}`,
      question: null, amountMicros: null, observationId: null, candidateId: null, sessionId: null,
    }, event.reason))
  }
  return rows.sort((a, b) => {
    const left = forecastOrder.get(a.decision.id)
    const right = forecastOrder.get(b.decision.id)
    return b.decision.at - a.decision.at || (left === undefined || right === undefined ? 0 : right - left)
      || a.decision.id.localeCompare(b.decision.id)
  })
}

/**
 * Query a filtered, bounded audit timeline.
 * @param source - Current authoritative state.
 * @param request - Wire filters and pagination.
 * @returns newest-first event summaries.
 */
export function queryDecisions(source: ConsoleSource, request: DecisionQuery): ConsolePage<DecisionView> {
  const query = decisionQuerySchema.parse(request)
  const search = query.search.toLowerCase()
  const rows = decisionViews(source).map(item => item.decision).filter(item =>
    (query.kinds.length === 0 || query.kinds.includes(item.kind))
    && `${item.id} ${item.summary} ${item.question ?? ''} ${item.releaseCommit ?? ''}`.toLowerCase().includes(search))
  return pageOf(rows, row => row.id, request.cursor, query.limit, { search: query.search, kinds: [...query.kinds].sort() })
}

/**
 * Resolve an exact decision reference for the detail panel and native chat context.
 * @param source - Current authoritative state.
 * @param id - Namespaced event reference.
 * @returns retained evidence or rejects an unknown reference.
 */
export function queryDecision(source: ConsoleSource, id: DecisionId): DecisionDetail {
  if (id.startsWith('release:')) {
    const release = source.releases?.get(brandString<ReleaseId>(id.slice('release:'.length)))
    if (release === undefined) throw new Error('Unknown release validation record')
    return { ...releaseDecision(release), release: { ...release,
      checks: release.checks.map(check => ({ ...check, passed: releaseCheckPassed(check) })) },
    references: [{ kind: 'candidateCommit', value: release.candidateSha }, { kind: 'baseCommit', value: release.baseSha },
      { kind: 'evidenceHash', value: release.evidenceHash }, { kind: 'configHash', value: release.configHash }],
    }
  }
  const value = decisionViews(source).find(row => row.decision.id === id)
  if (value === undefined) throw new Error('Unknown decision record')
  return value
}
