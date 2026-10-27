/** Detached-worktree validation; deployment and live-process handoff remain supervisor-owned. @module */

import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { defineDomain, domainTable, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { releaseCommitSchema, releaseConfigSchema, releaseRecordSchema } from './release-schema.ts'
import type {
  ReleaseCheck, ReleaseCheckResult, ReleaseCommit, ReleaseConfig, ReleaseId,
  ReleaseRecord, ReleaseRecordStore, ReleaseValidation, ReleaseValidator,
} from './release-types.ts'

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function recordId(candidateSha: ReleaseCommit, configHash: string): ReleaseId {
  return hash({ candidateSha, configHash }) as ReleaseId
}

const releaseDomain = defineDomain({
  name: 'rsi_releases',
  version: 1,
  tables: { records: domainTable<ReleaseId, ReleaseRecord>(releaseRecordSchema) },
})

/**
 * Open immutable validation records through the configured domain backend.
 * @param storageDomain - mounted domain facility; this store must be its sole rsi_releases writer.
 * @param assertWriter - synchronous ownership check before open and each queued insertion; defaults to no check.
 * @returns a store whose close must follow validator disposal.
 */
export async function openReleaseStore(
  storageDomain: DomainFacility,
  assertWriter: () => void = () => {},
): Promise<ReleaseRecordStore> {
  assertWriter()
  const domain = await storageDomain.open(releaseDomain)
  const records = domain.table('records')
  let writes: Promise<void> = Promise.resolve()
  for (const [key, record] of records.entries()) {
    if (key !== recordId(record.candidateSha, record.configHash) || record.id !== key || record.evidenceHash !== hash(record.checks)) {
      await domain.close()
      throw new Error(`release evidence hash or identity mismatch: ${key}`)
    }
  }
  return {
    list() {
      return [...records.entries()].map(([, record]) => ({ id: record.id, candidateSha: record.candidateSha,
        completedAt: record.completedAt, outcome: record.outcome }))
    },
    get(id) {
      const record = records.get(id)
      return record === undefined ? undefined : structuredClone(record)
    },
    find(candidateSha, configHash) {
      const record = records.get(recordId(candidateSha, configHash))
      return record === undefined ? undefined : structuredClone(record)
    },
    append(record) {
      const result = writes.then(async () => {
        if (records.get(record.id) !== undefined) throw new Error(`release evidence already exists: ${record.id}`)
        assertWriter()
        await records.put(record.id, structuredClone(record))
      })
      writes = result.then(() => {}, () => {})
      return result
    },
    async close() {
      await writes
      await domain.close()
    },
  }
}

/**
 * Interpret exit and interruption facts using the validator's acceptance rule.
 * @param result - Retained process completion.
 * @returns true only for an uninterrupted zero exit without an execution error.
 */
export function releaseCheckPassed(result: ReleaseCheckResult): boolean {
  return result.exitCode === 0 && result.signal === null && !result.timedOut && !result.aborted && result.error === null
}

function truncateError(error: unknown, maxBytes: number): string {
  return Buffer.from(error instanceof Error ? error.message : String(error)).subarray(0, maxBytes).toString('utf8')
}

async function privateWorktreeRoot(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory()) throw new Error('release worktreeRoot must be a real directory')
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('release worktreeRoot must permit access only to its owner (0700)')
  }
  return realpath(path)
}

/**
 * Construct a serial validator over local filesystem and subprocess providers.
 * Configured checks execute candidate code with the provider's host permissions; this is not a sandbox.
 * @param config - deployment-owned repository, commands, and resource limits.
 * @param subprocess - provider sharing the local filesystem's execution world.
 * @param records - immutable domain-backed evidence store.
 * @returns a validator that retains worktrees for inspection and never checks out the active branch.
 */
export function createReleaseValidator(
  config: ReleaseConfig,
  subprocess: SubprocessRuntime,
  records: ReleaseRecordStore,
): ReleaseValidator {
  const settings = releaseConfigSchema.parse(config)
  const lifetime = new AbortController()
  let tail: Promise<void> = Promise.resolve()
  let teardownFailure: Error | undefined

  async function run(check: ReleaseCheck, cwd: string, signal: AbortSignal): Promise<ReleaseCheckResult> {
    const startedAt = Date.now()
    using bounded = deadline(signal, settings.commandTimeoutMs, 'RSI_RELEASE_TIMEOUT')
    let handle: SubprocessHandle | undefined
    let exitCode: number | null = null
    let exitSignal: string | null = null
    let error: string | null = null
    try {
      const executable = await subprocess.resolveExecutable(check.command, undefined, bounded.signal)
      handle = subprocess.spawn({
        argv: [executable, ...check.args], cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: settings.maxOutputBytes }, stderr: { maxBytes: settings.maxOutputBytes } },
        graceMs: settings.terminationGraceMs,
        signal: bounded.signal,
        env: { GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1' },
      })
      const outcome = await handle.done
      exitCode = outcome.exitCode
      exitSignal = outcome.signal
    } catch (cause) {
      error = truncateError(cause, settings.maxOutputBytes)
    } finally {
      if (handle !== undefined) {
        // A completed leader can leave descendants; no validation outlives its managed range.
        try {
          handle.terminate()
          await handle.waitForExit()
        } catch (cause) {
          teardownFailure = new Error('release process teardown failed', { cause })
          lifetime.abort(teardownFailure)
          throw teardownFailure
        }
      }
    }
    const stdout = handle?.collected.stdout?.readFrom(0)
    const stderr = handle?.collected.stderr?.readFrom(0)
    return {
      ...check, args: [...check.args], startedAt, completedAt: Date.now(), exitCode, signal: exitSignal,
      timedOut: timeoutOf(bounded.signal, 'RSI_RELEASE_TIMEOUT') !== undefined,
      aborted: signal.aborted, error,
      stdout: stdout?.text ?? '', stderr: stderr?.text ?? '',
      stdoutTruncated: stdout?.lossy ?? false, stderrTruncated: stderr?.lossy ?? false,
    }
  }

  async function validate(candidateSha: ReleaseCommit, signal: AbortSignal): Promise<ReleaseValidation> {
    signal.throwIfAborted()
    const repositoryPath = await realpath(settings.repositoryPath)
    const configHash = hash({ ...settings, repositoryPath })
    const previous = records.find(candidateSha, configHash)
    if (previous !== undefined) return { record: previous, reused: true }
    const startedAt = Date.now()
    const checks: ReleaseCheckResult[] = []
    const git = async (name: string, args: string[], cwd = repositoryPath): Promise<ReleaseCheckResult> => {
      const result = await run({ name, command: 'git', args }, cwd, signal)
      checks.push(result)
      return result
    }
    const resolve = await git('candidate-commit', ['rev-parse', '--verify', `${candidateSha}^{commit}`])
    if (!releaseCheckPassed(resolve) || resolve.stdout.trim() !== candidateSha) throw new Error('candidate must resolve to the exact local commit supplied')
    const base = await git('base-commit', ['rev-parse', '--verify', 'HEAD^{commit}'])
    if (!releaseCheckPassed(base)) throw new Error('release repository HEAD must resolve to a commit')
    const baseSha = releaseCommitSchema.parse(base.stdout.trim())
    const worktreeRoot = await privateWorktreeRoot(settings.worktreeRoot)
    signal.throwIfAborted()
    const privateRoot = await mkdtemp(join(worktreeRoot, 'candidate-'))
    const hooksPath = join(privateRoot, 'hooks')
    await mkdir(hooksPath, { mode: 0o700 })
    const worktreePath = join(privateRoot, 'checkout')
    const prepared = await git('prepare-worktree', ['-c', `core.hooksPath=${hooksPath}`, 'worktree', 'add', '--detach', worktreePath, candidateSha])
    if (releaseCheckPassed(prepared)) {
      for (const check of settings.checks) {
        const result = await run(check, worktreePath, signal)
        checks.push(result)
        if (!releaseCheckPassed(result)) break
      }
      if (checks.every(releaseCheckPassed)) {
        const head = await git('verify-candidate-head', ['rev-parse', '--verify', 'HEAD^{commit}'], worktreePath)
        if (releaseCheckPassed(head) && head.stdout.trim() !== candidateSha) head.error = 'configured checks changed the candidate commit'
        if (checks.every(releaseCheckPassed)) await git('verify-tracked-files', ['diff', '--quiet', 'HEAD', '--'], worktreePath)
        if (checks.every(releaseCheckPassed)) await git('verify-index', ['diff', '--cached', '--quiet', 'HEAD', '--'], worktreePath)
      }
    }
    const record: ReleaseRecord = {
      id: recordId(candidateSha, configHash), candidateSha, baseSha, configHash,
      repositoryPath, worktreePath, startedAt, completedAt: Date.now(),
      outcome: checks.every(releaseCheckPassed) && !signal.aborted ? 'validated' : 'failed',
      checks, evidenceHash: hash(checks),
    }
    await records.append(record)
    return { record: structuredClone(record), reused: false }
  }

  return {
    validate(candidateSha, signal) {
      const candidate = releaseCommitSchema.parse(candidateSha)
      const combined = signal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, signal])
      const result = tail.then(() => validate(candidate, combined))
      // A rejected request must not poison the serial queue; its caller still receives the rejection.
      tail = result.then(() => {}, () => {})
      return result
    },
    async dispose() {
      lifetime.abort(new Error('release validator disposed'))
      await tail
      if (teardownFailure !== undefined) throw teardownFailure
    },
  }
}
