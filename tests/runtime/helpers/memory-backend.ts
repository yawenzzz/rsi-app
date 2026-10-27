/** Fault-injectable in-memory storage for RSI account and research persistence tests. */
import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'

/** One durable test medium; the pool outlives individual open handles. */
export interface MemoryMedium {
  tables: Map<string, Map<string, unknown>>
  global: unknown
}

/** Shared retained data and deliberate write failures used by restart and rollback cases. */
export class MemoryMediaPool {
  readonly media = new Map<string, MemoryMedium>()
  readonly versions = new Map<string, number>()
  failNextWrites = 0

  /** Reject an injected write before changing its retained values. */
  beforeWrite(): void {
    if (this.failNextWrites <= 0) return
    this.failNextWrites--
    throw new Error('injected write failure')
  }
}

/** Implement the public KV facet without importing the DSH repository's private fixtures. */
export class MemoryStorageBackend implements StorageBackend {
  readonly kv: KvFacet
  private readonly handles = new Map<string, KvUnit>()
  private closed = false

  /** @param pool - Retained media shared by restarted backends; omitted creates a fresh medium. */
  constructor(readonly pool: MemoryMediaPool = new MemoryMediaPool()) {
    this.kv = { open: descriptor => this.open(descriptor) }
  }

  private async open(descriptor: KvUnitDescriptor): Promise<KvUnit> {
    if (this.closed) throw new StorageError('closed', 'memory backend is closed')
    if (this.handles.has(descriptor.name)) throw new Error(`memory unit '${descriptor.name}' is already open`)
    const version = this.pool.versions.get(descriptor.name)
    if (version !== undefined && version !== descriptor.version) {
      throw new StorageError('version-mismatch', `memory unit '${descriptor.name}' has a different version`)
    }
    this.pool.versions.set(descriptor.name, descriptor.version)
    let medium = this.pool.media.get(descriptor.name)
    if (medium === undefined) {
      medium = { tables: new Map(), global: null }
      this.pool.media.set(descriptor.name, medium)
    }
    const retained = medium
    let closed = false
    const assertOpen = () => {
      if (closed) throw new StorageError('closed', `memory unit '${descriptor.name}' is closed`)
    }
    const handle: KvUnit = {
      loadAll: async () => {
        assertOpen()
        return { tables: Object.fromEntries(descriptor.tables.map(table => [table,
          Object.fromEntries(retained.tables.get(table) ?? [])])), global: retained.global }
      },
      putRecord: async (table, key, value) => {
        assertOpen()
        this.pool.beforeWrite()
        let records = retained.tables.get(table)
        if (records === undefined) { records = new Map(); retained.tables.set(table, records) }
        records.set(key, value)
      },
      deleteRecord: async (table, key) => {
        assertOpen()
        this.pool.beforeWrite()
        retained.tables.get(table)?.delete(key)
      },
      deleteRecords: async (table, keys) => {
        assertOpen()
        this.pool.beforeWrite()
        const records = retained.tables.get(table)
        for (const key of keys) records?.delete(key)
      },
      setGlobal: async value => {
        assertOpen()
        this.pool.beforeWrite()
        retained.global = value
      },
      close: async () => {
        if (closed) return
        closed = true
        this.handles.delete(descriptor.name)
      },
    }
    this.handles.set(descriptor.name, handle)
    return handle
  }

  /** Close all owned handles and prevent reopening this backend. */
  async close(): Promise<void> {
    this.closed = true
    await Promise.all([...this.handles.values()].map(handle => handle.close()))
  }
}
