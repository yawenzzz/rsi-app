/** Host startup rollback, lost writer ownership, and quiescent service disposal. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RsiService, { resolveConfig, type Config } from '../../src/runtime/index.ts'
import { PaperLedger } from '../../src/runtime/execution/ledger.ts'
import { MarketDataClient } from '../../src/runtime/data/market.ts'
import * as WriterLease from '../../src/runtime/writer-lease.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  } finally {
    vi.restoreAllMocks()
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-host-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'state') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const config = resolveConfig({
    objective: 'Study prospective market evidence.', writerLeasePath: join(root, 'writer'),
    ledger: {
      initialCapitalMicros: 100_000_000, perEventLimitMicros: 1_000_000,
      totalExposureLimitMicros: 5_000_000, maxDrawdownMicros: 2_000_000,
    },
    research: { cwd: root },
  })
  let compromise: ((error: Error) => void) | undefined
  let held = true
  const released = Promise.withResolvers<undefined>()
  const release = vi.fn(async () => { released.resolve(undefined) })
  const acquire = vi.spyOn(WriterLease, 'acquireWriterLease').mockImplementation(async (_options, onCompromised) => {
    compromise = onCompromised
    return { assertHeld: () => { if (!held) throw new Error('Writer ownership lost') }, release }
  })
  const errors: unknown[] = []
  const warning = Promise.withResolvers<unknown>()
  const disposalFailure = Promise.withResolvers<unknown>()
  ctx.logger.exporter({
    levels: { default: 3 },
    export(message) {
      const value: unknown = message.args[0]
      if (message.type === 'warn') warning.resolve(value)
      if (message.type === 'error') {
        errors.push(value)
        if (value instanceof Error && value.message === 'Durability close failed') disposalFailure.resolve(value)
      }
    },
  })
  const withReleases: Config = structuredClone(config)
  withReleases.releases = {
    repositoryPath: root, worktreeRoot: join(root, 'worktrees'),
    checks: [{ name: 'syntax', command: process.execPath, args: ['--version'] }],
    commandTimeoutMs: 30_000, terminationGraceMs: 1000, maxOutputBytes: 1024,
  }
  return {
    root, ctx, config, withReleases, acquire, release, errors, warning, disposalFailure, released,
    loseWriter: (error: Error) => {
      if (compromise === undefined) throw new Error('Host has not acquired its writer')
      held = false
      compromise(error)
    },
  }
}

describe('Polymarket host ownership', () => {
  it('does not expose a runtime before asynchronous initialization finishes', async () => {
    const { ctx, config } = await fixture()
    const service = new RsiService(ctx, config)
    expect(() => service.runtime).toThrow('RSI research is not initialized')
  })

  it('refuses startup when the shared writer cannot be acquired', async () => {
    const { ctx, config, acquire, release } = await fixture()
    acquire.mockRejectedValueOnce(new Error('Writer is already owned'))
    await expect(ctx.plugin(RsiService, config)).rejects.toThrow('Writer is already owned')
    expect(release).not.toHaveBeenCalled()
    expect(ctx.tools.schemas().some(tool => tool.name.startsWith('rsi_'))).toBe(false)
  })

  it('releases ownership when autonomous research lacks a default model', async () => {
    const { ctx, config, release } = await fixture()
    const enabled = structuredClone(config)
    enabled.research.enabled = true
    await expect(ctx.plugin(RsiService, enabled))
      .rejects.toThrow('Autonomous research requires a configured default model')
    expect(release).toHaveBeenCalledOnce()
  })

  it('releases ownership when release validation lacks a subprocess provider', async () => {
    const { ctx, withReleases, release } = await fixture()
    await expect(ctx.plugin(RsiService, withReleases)).rejects.toThrow('Release validation requires the subprocess service')
    expect(release).toHaveBeenCalledOnce()
  })

  it('closes release storage when paper account initialization fails', async () => {
    const { ctx, config, withReleases, release } = await fixture()
    await ctx.plugin(SubprocessLocal)
    const owned = await PaperLedger.open(ctx.storageDomain, config.ledger)
    try {
      await expect(ctx.plugin(RsiService, withReleases)).rejects.toThrow('already open')
      expect(release).toHaveBeenCalledOnce()
      expect(ctx.storageDomain.get('rsi_runtime')).toBeUndefined()
      expect(ctx.tools.schemas().some(tool => tool.name.startsWith('rsi_'))).toBe(false)
    } finally {
      await owned.close()
    }
  })

  it('opens configured release validation and closes every domain before releasing the writer', async () => {
    const { ctx, withReleases, release } = await fixture()
    await ctx.plugin(SubprocessLocal)
    const fiber = await ctx.plugin(RsiService, withReleases)
    expect(ctx.rsi.runtime.status().mode).toBe('paper')
    await fiber.dispose()
    expect(release).toHaveBeenCalledOnce()
    expect(ctx.storageDomain.get('rsi_runtime')).toBeUndefined()
  })

  it('reports a background collection failure and retains its diagnostic', async () => {
    const { ctx, config, warning } = await fixture()
    vi.spyOn(MarketDataClient.prototype, 'discover').mockRejectedValue(new Error('Upstream unavailable'))
    const automatic = structuredClone(config)
    automatic.autoTick = true
    const fiber = await ctx.plugin(RsiService, automatic)
    expect(await warning.promise).toMatchObject({ message: 'Upstream unavailable' })
    expect(ctx.rsi.runtime.status().lastTickError).toBe('Upstream unavailable')
    await fiber.dispose()
  })

  it('stops the runtime and joins cleanup after the lease provider reports lost ownership', async () => {
    const { ctx, config, loseWriter, released, errors } = await fixture()
    await ctx.plugin(RsiService, config)
    const runtime = ctx.rsi.runtime
    const lost = new Error('Writer heartbeat lost')
    loseWriter(lost)
    await released.promise
    expect(errors).toContain(lost)
    expect(() => runtime.tick()).toThrow('RSI runtime stopped')
  })

  it('retains writer ownership when shutdown cannot confirm successful disposal', async () => {
    const { ctx, config, loseWriter, release, disposalFailure } = await fixture()
    const fiber = await ctx.plugin(RsiService, config)
    const runtime = ctx.rsi.runtime
    const close = runtime.close.bind(runtime)
    vi.spyOn(runtime, 'close').mockImplementationOnce(async () => {
      await close()
      throw new Error('Durability close failed')
    })
    loseWriter(new Error('Writer heartbeat lost'))
    expect(await disposalFailure.promise).toMatchObject({ message: 'Durability close failed' })
    expect(release).not.toHaveBeenCalled()
    await fiber.dispose()
    expect(release).toHaveBeenCalledOnce()
  })
})
