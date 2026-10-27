/** Cooperative writer exclusion, canonical paths, and terminal lease states. */

import { execFile } from 'node:child_process'
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { LockOptions } from 'proper-lockfile'
import { acquireWriterLease } from '../../src/runtime/writer-lease.ts'
import type { WriterLease, WriterLeaseLocker, WriterLeaseOptions } from '../../src/runtime/writer-lease.ts'

const execFileAsync = promisify(execFile)
const leases: WriterLease[] = []
const roots: string[] = []
const childDisposals: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(childDisposals.splice(0).map(dispose => dispose()))
  await Promise.all(leases.splice(0).map(lease => lease.release()))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function options(): Promise<WriterLeaseOptions> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-lease-'))
  roots.push(root)
  return { path: join(root, 'private', 'writer'), staleMs: 60_000, updateMs: 10_000 }
}

async function acquire(config: WriterLeaseOptions): Promise<WriterLease> {
  const lease = await acquireWriterLease(config, () => {})
  leases.push(lease)
  return lease
}

function controlledLocker(release: () => Promise<void> = () => Promise.resolve()) {
  let configuration: LockOptions | undefined
  const locker: WriterLeaseLocker = async (_path, value) => {
    configuration = value
    return release
  }
  return {
    locker,
    compromise(error = Object.assign(new Error('heartbeat lost'), { code: 'ECOMPROMISED' })) {
      configuration!.onCompromised!(error)
      return error
    },
    configuration: () => configuration,
  }
}

async function independentContender(script: string, dependency: string, path: string) {
  const operation = execFileAsync(process.execPath, ['-e', script, dependency, path], { env: {} })
  childDisposals.push(async () => {
    if (operation.child.exitCode === null && operation.child.signalCode === null) operation.child.kill()
    await operation.catch(() => undefined)
  })
  return await operation
}

function leaseFailure(lease: WriterLease): Error {
  try {
    lease.assertHeld()
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('expected an inactive writer lease')
}

describe('RSI writer lease', () => {
  it('admits exactly one simultaneous owner and permits acquisition after release', async () => {
    const config = await options()
    const attempts = await Promise.allSettled([acquire(config), acquire(config)])
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = attempts.find(result => result.status === 'rejected')
    expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'ELOCKED' } })
    const owner = attempts.find(result => result.status === 'fulfilled')
    if (owner?.status !== 'fulfilled') throw new Error('missing acquired owner')
    expect(() => { owner.value.assertHeld() }).not.toThrow()
    await owner.value.release()
    const successor = await acquire(config)
    expect(() => { successor.assertHeld() }).not.toThrow()
    if (process.platform !== 'win32') {
      expect((await lstat(config.path)).mode & 0o777).toBe(0o600)
      expect((await lstat(dirname(config.path))).mode & 0o777).toBe(0o700)
    }
  })

  it('excludes an independent Node process while the parent holds the lease', async () => {
    const config = await options()
    const owner = await acquire(config)
    const dependency = createRequire(import.meta.url).resolve('proper-lockfile')
    // This micro-fixture probes the dependency's OS lock, not a Harness app.
    const script = [
      'const lock = require(process.argv[1]);',
      'lock.lock(process.argv[2], { stale: 60000, update: 10000, retries: 0, realpath: true })',
      '.then(async release => { await release(); process.stdout.write("acquired"); })',
      '.catch(error => { process.stdout.write(error.code); });',
    ].join('\n')
    const child = await independentContender(script, dependency, config.path)
    expect(child.stdout).toBe('ELOCKED')
    expect(child.stderr).toBe('')
    await owner.release()
    const successor = await independentContender(script, dependency, config.path)
    expect(successor.stdout).toBe('acquired')
    expect(successor.stderr).toBe('')
  })

  it('canonicalizes parent-directory aliases to the same lock', async () => {
    const config = await options()
    await acquire(config)
    const alias = join(dirname(dirname(config.path)), 'alias')
    await symlink(dirname(config.path), alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(acquire({ ...config, path: join(alias, 'writer') })).rejects.toMatchObject({ code: 'ELOCKED' })
  })

  it('disarms before notifying compromise and never releases a replacement lock', async () => {
    const config = await options()
    let releases = 0
    const provider = controlledLocker(async () => { releases++ })
    let notifications = 0
    const lease = await acquireWriterLease(config, () => {
      expect(() => { lease.assertHeld() }).toThrow('writer lease is not held')
      notifications++
    }, provider.locker)
    expect(provider.configuration()).toMatchObject({ stale: 60_000, update: 10_000, retries: 0, realpath: true })
    const failure = provider.compromise()
    provider.compromise()
    expect(notifications).toBe(1)
    expect(leaseFailure(lease).cause).toBe(failure)
    await lease.release()
    expect(releases).toBe(0)
  })

  it('contains a throwing compromise observer while retaining its failure', async () => {
    const provider = controlledLocker()
    const lease = await acquireWriterLease(await options(), () => { throw new Error('observer failed') }, provider.locker)
    expect(() => provider.compromise()).not.toThrow()
    expect(leaseFailure(lease).cause).toBeInstanceOf(AggregateError)
    await lease.release()
  })

  it('disarms synchronously, awaits release once, and ignores callbacks during disposal', async () => {
    let complete!: () => void
    const done = new Promise<void>((resolve) => { complete = resolve })
    let releases = 0
    let notifications = 0
    const provider = controlledLocker(() => { releases++; return done })
    const lease = await acquireWriterLease(await options(), () => { notifications++ }, provider.locker)
    const first = lease.release()
    expect(lease.release()).toBe(first)
    expect(() => { lease.assertHeld() }).toThrow('writer lease is not held')
    provider.compromise()
    expect(notifications).toBe(0)
    await Promise.resolve()
    expect(releases).toBe(1)
    complete()
    await first
  })

  it('retains release failure without restoring ownership or retrying removal', async () => {
    const failure = new Error('lock removal failed')
    const provider = controlledLocker(() => Promise.reject(failure))
    const lease = await acquireWriterLease(await options(), () => {}, provider.locker)
    await expect(lease.release()).rejects.toBe(failure)
    await expect(lease.release()).rejects.toBe(failure)
    expect(() => { lease.assertHeld() }).toThrow('writer lease is not held')
  })

  it('rejects compromise reported before acquisition resolves', async () => {
    const failure = Object.assign(new Error('acquisition compromised'), { code: 'ECOMPROMISED' })
    await expect(acquireWriterLease(await options(), () => {}, async (_path, config) => {
      config.onCompromised!(failure)
      return () => Promise.resolve()
    })).rejects.toBe(failure)
  })

  it.each([
    { path: 'relative' }, { staleMs: 4999 }, { staleMs: NaN },
    { updateMs: 999 }, { updateMs: 30_001 }, { updateMs: Infinity },
  ])('rejects invalid deployment durations or paths: %j', async (override) => {
    await expect(acquire({ ...await options(), ...override })).rejects.toThrow('writer lease')
  })

  it('refuses a directory anchor and preserves an existing file', async () => {
    const config = await options()
    await expect(acquire({ ...config, path: dirname(dirname(config.path)) })).rejects.toThrow('regular file')
    const owner = await acquire(config)
    await owner.release()
    await writeFile(config.path, 'anchor retained')
    await acquire(config)
    expect(await readFile(config.path, 'utf8')).toBe('anchor retained')
  })

  it.skipIf(process.platform === 'win32')('rejects non-private anchors on POSIX', async () => {
    const config = await options()
    const owner = await acquire(config)
    await owner.release()
    await chmod(config.path, 0o644)
    await expect(acquire(config)).rejects.toThrow('owner-only permissions')
  })

  it('propagates parent filesystem failures', async () => {
    const config = await options()
    const parent = dirname(config.path)
    await writeFile(parent, 'not a directory')
    await expect(acquire(config)).rejects.toThrow()
  })

  it('propagates anchor creation failures without claiming ownership', async () => {
    const config = await options()
    await expect(acquire({ ...config, path: join(dirname(config.path), 'x'.repeat(300)) })).rejects.toThrow()
  })
})
