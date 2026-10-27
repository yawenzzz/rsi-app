/** Durable admission control shared by research, collection and paper execution. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainFacility } from '@deepseek-ai/dsh-storage-domain'

/** Operator-visible emergency state; restoring the host does not clear a stop. */
export interface OperationalState {
  revision: number
  stopped: boolean
  reason: string | null
  changedAt: number | null
}

const schema: z.ZodType<OperationalState> = z.strictObject({
  revision: z.number().int().nonnegative(), stopped: z.boolean(), reason: z.string().nullable(),
  changedAt: z.number().int().nonnegative().nullable(),
})
const operationalDomain = defineDomain({ name: 'rsi_operations', version: 1,
  tables: { control: domainTable<'state', OperationalState>(schema) } })

/** One admission latch; every consumer checks it at its own queued commit point. */
export class Operations {
  private constructor(private readonly domain: Domain<typeof operationalDomain>, private readonly assertWriter: () => void) {}

  /**
   * Restore the application's admission state.
   * @param storage - Durable domain facility.
   * @param assertWriter - Host's process-ownership assertion.
   * @returns opened admission controller.
   */
  static async open(storage: DomainFacility, assertWriter: () => void): Promise<Operations> {
    const domain = await storage.open(operationalDomain)
    try {
      if (domain.table('control').get('state') === undefined) {
        assertWriter()
        await domain.table('control').put('state', { revision: 0, stopped: false, reason: null, changedAt: null })
      }
      return new Operations(domain, assertWriter)
    } catch (error) { await domain.close(); throw error }
  }

  /**
   * Read the admission latch.
   * @returns detached current emergency state.
   */
  view(): OperationalState { return { ...this.domain.table('control').get('state') as OperationalState } }

  /** Throw when the host has lost ownership or emergency admission is stopped. */
  assertRunning(): void {
    this.assertWriter()
    if (this.view().stopped) throw new Error('RSI is emergency-stopped')
  }

  /**
   * Persist a revision-checked emergency transition before any cancellation effects.
   * @param revision - Exact observed operational revision.
   * @param stopped - True rejects new admissions, false permits subsequent work.
   * @param reason - Operator reason retained for audit.
   * @returns state only after durable publication.
   */
  async change(revision: number, stopped: boolean, reason: string): Promise<OperationalState> {
    const text = z.string().trim().min(1).max(500).parse(reason)
    const next = await this.domain.table('control').update('state', (state) => {
      this.assertWriter()
      if (revision !== state.revision) throw new Error('Operational revision is stale; refresh before retrying')
      return { revision: state.revision + 1, stopped, reason: text, changedAt: Date.now() }
    })
    return { ...next }
  }

  /** Drain admitted storage work and close the latch. */
  async close(): Promise<void> { await this.domain.close() }
}
