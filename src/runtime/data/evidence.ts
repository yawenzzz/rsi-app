/** Immutable research text with explicit acquisition method and runtime receipt times. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { EventId } from './market.ts'

/** Content identity shared by data collection and prospective forecasts. */
export type SourceEvidenceId = Branded<'RsiSourceEvidenceId'>

/** Explicit evidence retention limits; reaching capacity rejects new content. */
export interface EvidenceConfig {
  maxRecords: number
  maxTextBytes: number
}

const timestamp = z.number().int().nonnegative()
const httpUrl = z.url().refine(value => ['https:', 'http:'].includes(new URL(value).protocol), 'Expected HTTP(S) evidence URL')

/** Validate submitted or host-fetched text; publication dates remain source claims. */
export const sourceEvidenceInputSchema = z.strictObject({
  eventId: z.string().min(1).transform(brandString<EventId>),
  url: httpUrl,
  text: z.string().min(1),
  reportedPublishedAt: timestamp.nullable(),
  provenance: z.enum(['submitted', 'fetched']),
})

/** Host callers alone may label text fetched; model submissions always use submitted. */
export type SourceEvidenceInput = z.infer<typeof sourceEvidenceInputSchema>

/** Validate retained text and its content identity when reopening storage. */
export const sourceEvidenceSchema = sourceEvidenceInputSchema.extend({
  id: z.string().regex(/^[a-f0-9]{64}$/).transform(brandString<SourceEvidenceId>),
  receivedAt: timestamp,
}).refine(value => value.id === evidenceId(value), 'Source evidence content hash mismatch')

/** First runtime receipt of exact text, URL, event, publication claim, and acquisition method. */
export type SourceEvidence = z.infer<typeof sourceEvidenceSchema>

const evidenceDomain = defineDomain({
  name: 'rsi_source_evidence', version: 1,
  tables: {
    records: domainTable<'state', { entries: SourceEvidence[] }>(z.strictObject({
      entries: z.array(sourceEvidenceSchema)
        .refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length, 'Duplicate source evidence'),
    })),
  },
})

/** Append-only source collection; all returned records are detached from durable storage. */
export interface EvidenceStore {
  /**
   * Retain text once per content identity; identical retries return the first receipt.
   * @param input - Text and acquisition method supplied by the owning collection path.
   * @returns committed evidence; invalid text, revoked authority, or capacity rejects.
   */
  append(input: SourceEvidenceInput): Promise<SourceEvidence>
  /**
   * Read exact evidence retained before a forecast.
   * @param id - Content identity issued by append.
   * @returns a detached record; an unknown identity throws.
   */
  get(id: SourceEvidenceId): SourceEvidence
  /**
   * Read a bounded tail of retained source records.
   * @param limit - Maximum records, in admission order.
   * @returns detached records; zero returns an empty list.
   */
  list(limit: number): SourceEvidence[]
  /** Drain admitted writes and close the evidence collection. */
  close(): Promise<void>
}

/**
 * Open evidence under the runtime's writer lease without granting financial authority.
 * @param storage - Host's durable domain facility.
 * @param config - Explicit count and UTF-8 text limits.
 * @param assertWriter - Authority checked at open and inside each queued append.
 * @param assertAdmission - Operational admission checked inside each queued append.
 * @param now - Runtime receipt clock; callers cannot supply receivedAt.
 * @returns a collection whose caller owns close.
 */
export async function openEvidenceStore(
  storage: DomainFacility, config: EvidenceConfig, assertWriter: () => void, assertAdmission: () => void,
  now: () => number = Date.now,
): Promise<EvidenceStore> {
  assertWriter()
  const domain = await storage.open(evidenceDomain)
  const records = domain.table('records')
  try {
    if (records.get('state') === undefined) {
      assertWriter()
      await records.put('state', { entries: [] })
    }
  } catch (error) {
    await domain.close()
    throw error
  }
  const entries = () => {
    const state = records.get('state')
    assert(state)
    return state.entries
  }
  return {
    async append(input) {
      const fields = sourceEvidenceInputSchema.parse(input)
      if (Buffer.byteLength(fields.text) > config.maxTextBytes) throw new Error('Source evidence text exceeds maxTextBytes')
      const id = evidenceId(fields)
      const next = await records.update('state', (state) => {
        assertWriter()
        assertAdmission()
        if (state.entries.some(entry => entry.id === id)) return state
        if (state.entries.length >= config.maxRecords) throw new Error('Source evidence capacity reached')
        const record = sourceEvidenceSchema.parse({ ...fields, id, receivedAt: now() })
        return { entries: [...state.entries, record] }
      })
      const record = next.entries.find(entry => entry.id === id)
      assert(record)
      return structuredClone(record)
    },
    get(id) {
      const record = entries().find(entry => entry.id === id)
      if (record === undefined) throw new Error('Unknown source evidence')
      return structuredClone(record)
    },
    list(limit) { return structuredClone(limit === 0 ? [] : entries().slice(-limit)) },
    close: () => domain.close(),
  }
}

function evidenceId(input: SourceEvidenceInput): SourceEvidenceId {
  return brandString<SourceEvidenceId>(createHash('sha256').update(JSON.stringify([
    input.eventId, input.url, input.text, input.reportedPublishedAt, input.provenance,
  ])).digest('hex'))
}
