/**
 * Cooperative process ownership for one RSI storage namespace. Every writer
 * must use the same canonical anchor and heartbeat settings; this lease does
 * not fence external database writers or survive manual lock replacement.
 * @module rsi/writer-lease
 */

import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import lockfile from 'proper-lockfile'
import type { LockOptions } from 'proper-lockfile'

/** Deployment-owned lock location and heartbeat durations. */
export interface WriterLeaseOptions {
  /** Absolute anchor path shared by every process using the same RSI data. */
  path: string
  /** Milliseconds before a missed heartbeat permits stale-lock recovery; at least 5000. */
  staleMs: number
  /** Heartbeat interval in milliseconds, from 1000 through half of staleMs. */
  updateMs: number
}

/** Ownership handle; callers drain accepted writes before releasing it. */
export interface WriterLease {
  /**
   * Refuse writes after compromise or once release begins. Call at the write
   * queue slot, after any earlier asynchronous preflight.
   * @throws when this handle no longer owns the lease.
   */
  assertHeld(): void
  /**
   * Disarm this handle immediately and await removal of its lock. Repeated
   * calls share one result; a compromised lock is never removed by this owner.
   * @returns resolution after release, or rejection when lock removal fails.
   */
  release(): Promise<void>
}

/**
 * Lock-provider operation, injectable without replacing process-global APIs.
 * @param path - existing anchor whose real path identifies the writer.
 * @param options - common heartbeat policy and compromise callback.
 * @returns the provider-owned asynchronous release function.
 */
export type WriterLeaseLocker = (path: string, options: LockOptions) => Promise<() => Promise<void>>

/**
 * Acquire exclusive cooperative ownership before opening the storage domain.
 * Creates missing parents and the anchor owner-only, without replacing an
 * existing anchor. Existing symlink or non-file anchors are rejected. All
 * processes sharing the data must share these durations and this anchor.
 * Compromise disarms writes before notifying the owner; a throwing observer
 * remains observable as the cause of subsequent assertHeld failures.
 * @param options - deployment path and heartbeat durations.
 * @param onCompromised - synchronous notification that must stop new work.
 * @param locker - file-lock provider; defaults to proper-lockfile.
 * @returns the acquired lease, to release after storage writes are drained.
 */
export async function acquireWriterLease(
  options: WriterLeaseOptions,
  onCompromised: (error: Error) => void,
  locker: WriterLeaseLocker = lockfile.lock,
): Promise<WriterLease> {
  if (!isAbsolute(options.path)) throw new Error('writer lease path must be absolute')
  if (!Number.isSafeInteger(options.staleMs) || options.staleMs < 5000) {
    throw new Error('writer lease staleMs must be a safe integer of at least 5000 milliseconds')
  }
  if (!Number.isSafeInteger(options.updateMs) || options.updateMs < 1000 || options.updateMs > options.staleMs / 2) {
    throw new Error('writer lease updateMs must be a safe integer from 1000 through staleMs / 2')
  }
  await mkdir(dirname(options.path), { recursive: true, mode: 0o700 })
  try {
    const anchor = await open(options.path, 'wx', 0o600)
    await anchor.close()
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  }
  const anchor = await lstat(options.path)
  if (!anchor.isFile() || anchor.isSymbolicLink()) throw new Error('writer lease anchor must be a regular file')
  if (process.platform !== 'win32' && (anchor.mode & 0o077) !== 0) {
    throw new Error('writer lease anchor must have owner-only permissions')
  }

  let held = true
  let compromised: Error | undefined
  let releasing = false
  let releasePromise: Promise<void> | undefined
  const releaseOwner = await locker(options.path, {
    stale: options.staleMs,
    update: options.updateMs,
    retries: 0,
    realpath: true,
    onCompromised(error) {
      if (releasing || compromised !== undefined) return
      held = false
      compromised = error
      try {
        onCompromised(error)
      } catch (observerError) {
        compromised = new AggregateError([error, observerError], 'writer lease compromise observer failed')
      }
    },
  })
  if (compromised !== undefined) throw compromised

  return {
    assertHeld() {
      if (!held) throw new Error(`writer lease is not held: ${options.path}`, { cause: compromised })
    },
    release() {
      held = false
      releasing = true
      releasePromise ??= compromised === undefined
        ? Promise.resolve().then(() => releaseOwner())
        : Promise.resolve()
      return releasePromise
    },
  }
}
