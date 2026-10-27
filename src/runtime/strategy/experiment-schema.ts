/** Durable validation and version identity for prospective paper research. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { EventId, MarketId, TokenId } from '../data/market.ts'
import type { SourceEvidenceId } from '../data/evidence.ts'

/** Immutable candidate version identifier. */
export type CandidateId = Branded<'RsiCandidateId'>
/** Runtime observation reference retained with each prediction. */
export type ResearchObservationId = Branded<'RsiResearchObservationId'>
const timestamp = z.number().int().nonnegative()
const probability = z.number().min(0).max(1)
const candidateId = z.string().regex(/^[a-f0-9]{64}$/).transform(brandString<CandidateId>)
const eventId = z.string().min(1).transform(brandString<EventId>)
const marketId = z.string().min(1).transform(brandString<MarketId>)
const tokenId = z.string().min(1).transform(brandString<TokenId>)

/** Fixed experiment budget and evidence thresholds, persisted on first open. */
export const experimentConfigSchema = z.object({
  minResolvedEvents: z.number().int().positive(),
  maxCandidates: z.number().int().positive(),
  maxForecasts: z.number().int().positive(),
  confidenceAlpha: z.number().gt(0).lt(1),
  maxEvidenceBytes: z.number().int().positive(),
}).strict()

/** Candidate inputs accepted from a research tool; no executable source is evaluated. */
export const candidateInputSchema = z.object({
  name: z.string().trim().min(1),
  thesis: z.string().trim().min(1),
  minEdge: z.number().min(0).lt(1),
  kellyFraction: z.number().gt(0).max(1),
  /** Maximum time to the scheduled event end at admission; settlement can occur later. */
  maxEventHorizonMs: z.number().int().positive().optional(),
  /** Prior immutable policy from which this candidate is derived. */
  parentId: candidateId.optional(),
  /** Exact source revision associated with this proposal; not deployment evidence. */
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
}).strict()

/**
 * Hash all candidate policy and descriptive fields in a stable field order.
 * @param input - Validated candidate fields.
 * @returns immutable version identity; any changed field produces a new version.
 */
export function candidateVersion(input: z.infer<typeof candidateInputSchema>): CandidateId {
  return brandString<CandidateId>(createHash('sha256').update(JSON.stringify([
    input.name, input.thesis, input.minEdge, input.kellyFraction, input.maxEventHorizonMs ?? null,
    ...(input.parentId === undefined && input.sourceCommit === undefined ? [] : [input.parentId ?? null, input.sourceCommit ?? null]),
  ])).digest('hex'))
}

const candidateSchema = candidateInputSchema.extend({ id: candidateId, registeredAt: timestamp })
  .refine(candidate => candidate.id === candidateVersion(candidate), 'candidate version hash mismatch')

/** Model-owned forecast fields; timestamps, quoted costs, and labels are runtime-owned. */
export const forecastInputSchema = z.object({
  candidateId,
  probability,
  uncertainty: probability,
  evidence: z.array(z.object({
    url: z.url(), text: z.string(), stance: z.enum(['supports', 'contradicts', 'context']).optional(),
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/).transform(brandString<SourceEvidenceId>).optional(),
  }).strict()),
}).strict()

/** Quote supplied by the runtime from its stored executable book observation. */
export const forecastObservationSchema = z.object({
  observationId: z.string().min(1).transform(brandString<ResearchObservationId>),
  observedAt: timestamp,
  eventId,
  marketId,
  tokenId,
  eventEndsAt: timestamp,
  costMicros: z.number().int().gt(0).lt(1_000_000),
  baselineProbability: probability,
}).strict()

const forecastSchema = forecastInputSchema.extend({
  observation: forecastObservationSchema,
  receivedAt: timestamp,
})

const forecastRevisionSchema = forecastSchema.extend({ revision: z.number().int().positive() })

/** Trusted settlement for one outcome token, including explicit split payouts. */
export const researchSettlementSchema = z.object({
  eventId,
  marketId,
  tokenId,
  payout: probability,
  resolvedAt: timestamp,
  source: z.url(),
}).strict()
const settlementSchema = researchSettlementSchema.extend({ receivedAt: timestamp })

/** Primary forecasts determine qualification; revisions preserve subsequent prospective estimates. */
export const experimentStateSchema = z.object({
  config: experimentConfigSchema,
  candidates: z.array(candidateSchema),
  forecasts: z.array(forecastSchema),
  forecastRevisions: z.array(forecastRevisionSchema).default([]),
  settlements: z.array(settlementSchema),
}).strict().superRefine((state, ctx) => {
  const fail = (message: string) => { ctx.addIssue({ code: 'custom', message }) }
  if (state.candidates.length > state.config.maxCandidates) fail('candidate budget exceeded')
  if (state.forecasts.length + state.forecastRevisions.length > state.config.maxForecasts) fail('forecast budget exceeded')
  const candidates = new Map(state.candidates.map(candidate => [candidate.id, candidate]))
  if (candidates.size !== state.candidates.length) fail('duplicate candidate version')
  const primaries = new Map<string, z.infer<typeof forecastSchema>>()
  for (const candidate of state.candidates) {
    if (candidate.parentId !== undefined && !state.candidates.some(parent => parent.id === candidate.parentId
      && parent.id !== candidate.id && parent.registeredAt <= candidate.registeredAt)) fail('candidate parent is absent or newer')
    if (Buffer.byteLength(candidate.name + candidate.thesis) > state.config.maxEvidenceBytes) fail('candidate text budget exceeded')
  }
  for (const forecast of state.forecasts) {
    const key = JSON.stringify([forecast.candidateId, forecast.observation.eventId])
    if (primaries.has(key)) fail('duplicate independent event forecast')
    primaries.set(key, forecast)
  }
  const revisions = new Map<string, z.infer<typeof forecastRevisionSchema>>()
  for (const forecast of state.forecastRevisions) {
    const key = JSON.stringify([forecast.candidateId, forecast.observation.eventId])
    const primary = primaries.get(key)
    const previous = revisions.get(key)
    if (!primary) fail('forecast revision has no primary forecast')
    else {
      if (forecast.observation.marketId !== primary.observation.marketId
        || forecast.observation.tokenId !== primary.observation.tokenId) fail('forecast revision changes primary market or token')
      if (forecast.receivedAt < (previous ?? primary).receivedAt
        || forecast.receivedAt >= primary.observation.eventEndsAt) fail('forecast revision is not prospective')
    }
    if (forecast.revision !== (previous?.revision ?? 0) + 1) fail('forecast revision sequence is not contiguous')
    revisions.set(key, forecast)
  }
  const forecasts = [...state.forecasts, ...state.forecastRevisions]
  for (const forecast of forecasts) {
    const candidate = candidates.get(forecast.candidateId)
    if (!candidate || candidate.registeredAt > forecast.receivedAt) fail('forecast predates candidate registration')
    if (forecast.receivedAt >= forecast.observation.eventEndsAt || forecast.observation.observedAt > forecast.receivedAt) fail('forecast is not prospective')
    if (Buffer.byteLength(JSON.stringify(forecast.evidence)) > state.config.maxEvidenceBytes) fail('forecast evidence budget exceeded')
    if (candidate?.maxEventHorizonMs !== undefined
      && forecast.observation.eventEndsAt - forecast.receivedAt > candidate.maxEventHorizonMs) fail('forecast exceeds candidate event horizon')
  }
  const tokens = new Set<string>()
  for (const settlement of state.settlements) {
    const key = JSON.stringify([settlement.marketId, settlement.tokenId])
    if (tokens.has(key)) fail('duplicate token settlement')
    tokens.add(key)
    const matching = forecasts.filter(forecast =>
      forecast.observation.marketId === settlement.marketId && forecast.observation.tokenId === settlement.tokenId)
    if (!matching.length) fail('settlement has no registered forecast')
    if (settlement.resolvedAt > settlement.receivedAt) fail('settlement resolution is in the future')
    for (const forecast of matching) {
      if (forecast.observation.eventId !== settlement.eventId || forecast.receivedAt >= settlement.resolvedAt) fail('settlement does not follow its prospective forecast')
    }
    for (const forecast of forecasts) {
      if (forecast.observation.eventId === settlement.eventId && forecast.receivedAt >= settlement.resolvedAt) fail('event forecast follows a known resolution')
    }
  }
})

/** One singleton table preserves atomic candidate, forecast, and settlement transitions. */
export const researchDomain = defineDomain({
  name: 'rsi_research',
  version: 1,
  tables: { research: domainTable<'state', z.infer<typeof experimentStateSchema>>(experimentStateSchema) },
})
