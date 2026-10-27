/** Evidence acquisition, durable identities, and serialized admission limits. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { openEvidenceStore, sourceEvidenceInputSchema, sourceEvidenceSchema } from '../../src/runtime/data/evidence.ts'
import type { EvidenceConfig, SourceEvidenceInput, SourceEvidenceId } from '../../src/runtime/data/evidence.ts'
import type { EventId } from '../../src/runtime/data/market.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

const input: SourceEvidenceInput = {
  eventId: brandString<EventId>('economic-release'), url: 'https://source.example.test/release',
  text: 'Initial estimate: 2.4%.', reportedPublishedAt: 900, provenance: 'submitted',
}

async function harness(options: {
  config?: Partial<EvidenceConfig>
  pool?: MemoryMediaPool
  assertWriter?: () => void
  assertAdmission?: () => void
  now?: () => number
} = {}) {
  const ctx = new Context()
  cleanup.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(options.pool)
  ctx.storage.backend.register('memory', backend)
  cleanup.push(async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  cleanup.push(async () => { await facility.closeAll() })
  let now = 1000
  const store = await openEvidenceStore(facility, { maxRecords: 10, maxTextBytes: 1024, ...options.config },
    options.assertWriter ?? (() => {}), options.assertAdmission ?? (() => {}), options.now ?? (() => now))
  return { store, pool: backend.pool, setTime: (value: number) => { now = value } }
}

describe('source evidence', () => {
  it('retains the first receipt of identical content and preserves each revision', async () => {
    const { store, setTime } = await harness()
    const first = await store.append(input)
    setTime(2000)
    expect(await store.append({ ...input })).toEqual(first)
    const revision = await store.append({ ...input, text: 'Revised estimate: 2.1%.' })
    const fetched = await store.append({ ...input, provenance: 'fetched' })
    expect(first).toMatchObject({ receivedAt: 1000, provenance: 'submitted', reportedPublishedAt: 900 })
    expect(revision).toMatchObject({ receivedAt: 2000 })
    expect(new Set([first.id, revision.id, fetched.id]).size).toBe(3)
    expect(store.list(2).map(record => record.id)).toEqual([revision.id, fetched.id])
    expect(store.list(0)).toEqual([])
  })

  it('reopens exact evidence and rejects modified content under an existing identity', async () => {
    const first = await harness()
    const record = await first.store.append(input)
    await first.store.close()
    const reopened = await harness({ pool: first.pool })
    expect(reopened.store.get(record.id)).toEqual(record)
    expect(sourceEvidenceSchema.safeParse({ ...record, text: 'Changed result' }).success).toBe(false)
    expect(sourceEvidenceSchema.safeParse({ ...record, provenance: 'fetched' }).success).toBe(false)
    expect(() => reopened.store.get(brandString<SourceEvidenceId>('f'.repeat(64)))).toThrow('Unknown source evidence')
  })

  it('returns detached records without retaining mutable caller fields', async () => {
    const { store } = await harness()
    const mutable = { ...input }
    const record = await store.append(mutable)
    mutable.text = 'Changed caller text'
    record.text = 'Changed result text'
    store.list(1)[0]!.text = 'Changed list text'
    expect(store.get(record.id).text).toBe(input.text)
  })

  it('bounds concurrent admissions without deleting earlier evidence', async () => {
    const { store } = await harness({ config: { maxRecords: 1 } })
    const writes = await Promise.allSettled([store.append(input), store.append({ ...input, text: 'Other source' })])
    expect(writes.map(write => write.status)).toEqual(['fulfilled', 'rejected'])
    expect(store.list(10)).toHaveLength(1)
    await expect(store.append(input)).resolves.toEqual(store.list(1)[0])
  })

  it('counts UTF-8 bytes and preserves submission origin at admission', async () => {
    const { store } = await harness({ config: { maxTextBytes: 6 } })
    await expect(store.append({ ...input, text: '中文' })).resolves.toMatchObject({ text: '中文' })
    await expect(store.append({ ...input, text: '中文字' })).rejects.toThrow('maxTextBytes')
    expect(sourceEvidenceInputSchema.safeParse({ ...input, receivedAt: 1 }).success).toBe(false)
    await expect(store.append({ ...input, url: 'file:///etc/passwd', text: 'x' })).rejects.toThrow('HTTP(S)')
  })

  it('checks writer and operation authority inside queued appends', async () => {
    let allowed = true
    let running = true
    const { store } = await harness({
      assertWriter: () => { if (!allowed) throw new Error('Writer revoked') },
      assertAdmission: () => { if (!running) throw new Error('Stopped') },
    })
    const queued = store.append(input)
    allowed = false
    await expect(queued).rejects.toThrow('Writer revoked')
    allowed = true
    running = false
    await expect(store.append(input)).rejects.toThrow('Stopped')
    expect(store.list(1)).toEqual([])
    running = true
    await expect(store.append(input)).resolves.toMatchObject(input)
  })

  it('rejects invalid runtime receipt clocks and drains writes before close', async () => {
    const invalid = await harness({ now: () => NaN })
    await expect(invalid.store.append(input)).rejects.toThrow()
    const { store } = await harness()
    const append = store.append(input)
    const closing = store.close()
    await expect(append).resolves.toMatchObject(input)
    await closing
    await expect(store.append(input)).rejects.toMatchObject({ code: 'closed' })
  })
})
