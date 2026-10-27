/** Durable evidence for scans and rejected attempts that produce no financial receipt. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { CandidateId } from '../strategy/experiment-schema.ts'
import type { DecisionDetail, DecisionId } from '../queries/types.ts'
import { decisionCheckSchema, quoteBreakdownSchema, tradeAssessmentSchema } from '../trading/schema.ts'

const numberOrNull = z.number().nullable()
const detailSchema: z.ZodType<DecisionDetail> = z.strictObject({
  decision: z.strictObject({
    id: z.string().min(1).transform(brandString<DecisionId>), at: z.number().int().nonnegative(),
    kind: z.enum(['data', 'research', 'forecast', 'trade', 'settlement', 'release', 'control']),
    outcome: z.enum(['completed', 'running', 'failed', 'rejected', 'interrupted']),
    summary: z.string(), question: z.string().nullable(), amountMicros: numberOrNull,
    observationId: z.string().nullable(), candidateId: z.string().transform(brandString<CandidateId>).nullable(),
    sessionId: z.string().nullable(),
  }),
  references: z.array(z.strictObject({ kind: z.string(), value: z.string() })),
  checks: z.array(decisionCheckSchema),
  pricing: quoteBreakdownSchema.nullable(),
  explanation: z.string(),
  assessment: tradeAssessmentSchema.optional(),
})

/** One independently versioned, append-only record table for nonfinancial outcomes. */
export const decisionDomain = defineDomain({
  name: 'rsi_decisions', version: 1,
  tables: { records: domainTable<'state', { entries: DecisionDetail[] }>(z.strictObject({ entries: z.array(detailSchema) })) },
})

/** Nonfinancial decision evidence; ledger receipts remain the authority for actual cash effects. */
export class DecisionJournal {
  private constructor(
    private readonly domain: Domain<typeof decisionDomain>,
    private readonly limit: number,
    private readonly assertWriter: () => void,
  ) {}

  /**
   * Open retained decision evidence under the runtime's writer lease.
   * @param storage - Durable domain owner.
   * @param limit - Maximum retained records; capacity rejects without discarding history.
   * @param assertWriter - Authority checked before each append.
   * @returns opened journal owned by the runtime.
   */
  static async open(storage: DomainFacility, limit: number, assertWriter: () => void): Promise<DecisionJournal> {
    const domain = await storage.open(decisionDomain)
    try {
      if (domain.table('records').get('state') === undefined) {
        assertWriter()
        await domain.table('records').put('state', { entries: [] })
      }
      return new DecisionJournal(domain, limit, assertWriter)
    } catch (error) {
      await domain.close()
      throw error
    }
  }

  /**
   * Read the retained journal.
   * @returns detached nonfinancial evidence.
   */
  view(): DecisionDetail[] {
    const state = this.domain.table('records').get('state') as { entries: DecisionDetail[] }
    return structuredClone(state.entries)
  }

  /**
   * Store one operation outcome; a repeated identity returns the first retained record.
   * @param input - Validated diagnostic fields owned by the operation.
   * @param id - Optional operation-owned deduplication identity; otherwise a fresh identity is assigned.
   * @returns the committed journal record.
   */
  async append(
    input: Omit<DecisionDetail, 'decision'> & { decision: Omit<DecisionDetail['decision'], 'id'> },
    id: DecisionId = brandString<DecisionId>(`journal:${randomUUID()}`),
  ): Promise<DecisionDetail> {
    const record = detailSchema.parse({ ...input, decision: { ...input.decision, id } })
    const records = this.domain.table('records')
    const next = await records.update('state', (state) => {
      this.assertWriter()
      if (state.entries.some(entry => entry.decision.id === id)) return state
      if (state.entries.length >= this.limit) throw new Error('Decision evidence capacity reached')
      return { entries: [...state.entries, record] }
    })
    return structuredClone(next.entries.find(entry => entry.decision.id === id) as DecisionDetail)
  }

  /** Close retained evidence after the runtime drains active work. */
  async close(): Promise<void> { await this.domain.close() }
}
