/** Actual detached-worktree check receipts for an exclusively owned synthetic console home. */
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { createReleaseValidator, openReleaseStore } from '../../../../src/runtime/evolution/releases.ts'
import { acquireWriterLease } from '../../../../src/runtime/writer-lease.ts'
import { runtimeDomain } from '../../../../src/runtime/runtime-state.ts'
import type { ReleaseConfig, ReleaseValidation } from '../../../../src/runtime/evolution/release-types.ts'

/**
 * Validate the fixture repository with one passing and one deliberately failing check configuration.
 * @param home - Stopped synthetic profile home; its normal writer lease must be available.
 * @param commit - Actual commit in this home's release-repository directory.
 * @returns immutable receipts and the passing configuration for the subsequent normal app boot.
 */
export async function seedReleaseEvidence(home: string, commit: string): Promise<{
  config: ReleaseConfig
  accepted: ReleaseValidation
  rejected: ReleaseValidation
}> {
  const ctx = new Context()
  const lease = await acquireWriterLease({ path: join(home, 'writer'), staleMs: 30_000, updateMs: 10_000 }, () => {})
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(home, 'storages') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(LocalSubprocess)
    const runtime = await ctx.storageDomain.open(runtimeDomain)
    try {
      if (runtime.table('state').get('state')?.objective !== 'Synthetic console verification — no trading performance') {
        throw new Error('Release fixture requires an existing synthetic console home')
      }
    } finally { await runtime.close() }
    const store = await openReleaseStore(ctx.storageDomain, () => { lease.assertHeld() })
    const config: ReleaseConfig = { repositoryPath: join(home, 'release-repository'), worktreeRoot: join(home, 'release-worktrees'),
      commandTimeoutMs: 30_000, terminationGraceMs: 1000, maxOutputBytes: 2048,
      checks: [{ name: 'Synthetic passing check', command: process.execPath,
        args: ['-e', 'process.stdout.write("Synthetic validation only\\n")'] }] }
    const passing = createReleaseValidator(config, ctx.subprocess, store)
    const failing = createReleaseValidator({ ...config, checks: [{ name: 'Synthetic failing check', command: process.execPath,
      args: ['-e', 'process.stderr.write("Synthetic failure for UI verification\\n"); process.exitCode = 1'] }] }, ctx.subprocess, store)
    try {
      const accepted = await passing.validate(commit)
      const rejected = await failing.validate(commit)
      return { config, accepted, rejected }
    } finally {
      await passing.dispose()
      await failing.dispose()
      await store.close()
    }
  } finally {
    await ctx.fiber.dispose()
    await lease.release()
  }
}
