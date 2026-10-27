import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createReleaseValidator, openReleaseStore } from '../../src/runtime/evolution/releases.ts'
import { releaseConfigSchema, releaseRecordSchema } from '../../src/runtime/evolution/release-schema.ts'
import type { ReleaseCheck, ReleaseConfig, ReleaseRecord, ReleaseRecordStore, ReleaseValidator } from '../../src/runtime/evolution/release-types.ts'

const nodeCheck = (name: string, script: string): ReleaseCheck => ({ name, command: process.execPath, args: ['-e', script] })

async function setup(
  checks: ReleaseCheck[] = [nodeCheck('source-check', 'require("node:assert").equal(require("node:fs").readFileSync("source.txt", "utf8").trim(), "candidate")')],
  assertWriter: () => void = () => {},
) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-release-test-'))
  const ctx = new Context()
  const fibers: Fiber[] = []
  const validators: ReleaseValidator[] = []
  const stores: ReleaseRecordStore[] = []
  onTestFinished(async () => {
    for (const validator of validators) await validator.dispose()
    for (const store of stores) await store.close()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  fibers.push(await ctx.plugin(Storage))
  fibers.push(await ctx.plugin(StorageJson, { root: join(root, 'data') }))
  fibers.push(await ctx.plugin(StorageDomain, { backend: 'json' }))
  fibers.push(await ctx.plugin(LocalSubprocess))
  const repositoryPath = join(root, 'repository')
  const hooksPath = join(root, 'hooks')
  await mkdir(repositoryPath)
  await mkdir(hooksPath)
  async function git(args: string[]): Promise<string> {
    const handle = ctx.subprocess.spawn({
      argv: ['git', '-c', `core.hooksPath=${hooksPath}`, '-c', 'commit.gpgsign=false', ...args],
      cwd: repositoryPath, graceMs: 1000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
    })
    try {
      const outcome = await handle.done
      expect(outcome).toEqual({ exitCode: 0, signal: null })
      return handle.collected.stdout!.readFrom(0).text.trim()
    } finally {
      handle.terminate()
      await handle.waitForExit()
    }
  }
  await git(['init'])
  await git(['config', 'core.autocrlf', 'false'])
  await writeFile(join(repositoryPath, 'source.txt'), 'candidate\n')
  await git(['add', 'source.txt'])
  await git(['-c', 'user.name=Release Test', '-c', 'user.email=release@example.invalid', 'commit', '-m', 'candidate'])
  const sha = await git(['rev-parse', 'HEAD'])
  const config: ReleaseConfig = {
    repositoryPath, worktreeRoot: join(root, 'worktrees'), checks,
    commandTimeoutMs: 30_000, terminationGraceMs: 1000, maxOutputBytes: 1024,
  }
  const backend = ctx.storage.backend.get('json').kv!
  const originalOpen = backend.open.bind(backend)
  let nextWrite: (() => Promise<void>) | undefined
  let writeCount = 0
  backend.open = async (descriptor) => {
    const unit = await originalOpen(descriptor)
    const originalPut = unit.putRecord.bind(unit)
    unit.putRecord = async (table, key, value) => {
      const beforeWrite = nextWrite
      nextWrite = undefined
      await beforeWrite?.()
      await originalPut(table, key, value)
      writeCount += 1
    }
    return unit
  }
  const store = await openReleaseStore(ctx.storageDomain, assertWriter)
  stores.push(store)
  function validator(overrides: Partial<ReleaseConfig> = {}) {
    const validator = createReleaseValidator({ ...config, ...overrides }, ctx.subprocess, store)
    validators.push(validator)
    return validator
  }
  return {
    root, ctx, store, stores, validators, git, config, sha, validator,
    writeCount: () => writeCount,
    blockNextWrite() {
      const entered = Promise.withResolvers<undefined>()
      const released = Promise.withResolvers<undefined>()
      nextWrite = async () => { entered.resolve(undefined); await released.promise }
      return { entered: entered.promise, release: () => { released.resolve(undefined) } }
    },
  }
}

describe('detached Harness release validation', () => {
  it('rejects opening release evidence after losing the writer', async () => {
    await expect(setup(undefined, () => { throw new Error('writer lost') }).then(() => undefined)).rejects.toThrow('writer lost')
  })

  it('rejects queued release evidence after losing the writer behind an earlier durable write', async () => {
    let ownsWriter = true
    const fixture = await setup(undefined, () => { if (!ownsWriter) throw new Error('writer lost') })
    const appended = Promise.withResolvers<ReleaseRecord>()
    const originalAppend = fixture.store.append.bind(fixture.store)
    let appendCount = 0
    const interceptor = vi.spyOn(fixture.store, 'append').mockImplementation((record) => {
      appendCount += 1
      if (appendCount === 2) appended.resolve(record)
      return originalAppend(record)
    })
    onTestFinished(() => { interceptor.mockRestore() })
    const barrier = fixture.blockNextWrite()
    const first = fixture.validator().validate(fixture.sha)
    let queuedRecord: ReleaseRecord
    let rejected: Promise<unknown>
    try {
      await Promise.race([
        barrier.entered,
        first.then(() => { throw new Error('release validation finished without reaching the blocked evidence write') }),
      ])
      const second = fixture.validator({ checks: [nodeCheck('another-check', 'process.exit(0)')] }).validate(fixture.sha)
      rejected = second.catch((error: unknown) => error)
      queuedRecord = await Promise.race([
        appended.promise,
        second.then(() => { throw new Error('release validation finished without queuing evidence') }),
      ])
      ownsWriter = false
    } finally {
      barrier.release()
    }
    const accepted = await first
    expect(await rejected).toMatchObject({ message: 'writer lost' })
    expect(fixture.writeCount()).toBe(1)
    expect(fixture.store.list()).toEqual([{ id: accepted.record.id, candidateSha: accepted.record.candidateSha,
      completedAt: accepted.record.completedAt, outcome: accepted.record.outcome }])
    expect(fixture.store.get(queuedRecord.id)).toBeUndefined()
    expect(fixture.store.find(accepted.record.candidateSha, accepted.record.configHash)).toEqual(accepted.record)
    expect(fixture.store.find(queuedRecord.candidateSha, queuedRecord.configHash)).toBeUndefined()
    const durable: unknown = JSON.parse(await readFile(join(fixture.root, 'data', 'rsi_releases.json'), 'utf8'))
    expect(durable).toMatchObject({ tables: { records: { [accepted.record.id]: accepted.record } } })
    expect(JSON.stringify(durable)).not.toContain(queuedRecord.id)
  })

  it('executes the candidate, preserves dirty checkout files, and reuses immutable evidence after reopen', async () => {
    const fixture = await setup()
    await writeFile(join(fixture.config.repositoryPath, 'source.txt'), 'local unfinished work\n')
    const validator = fixture.validator()
    const [first, overlapping] = await Promise.all([validator.validate(fixture.sha), validator.validate(fixture.sha)])
    expect(first.reused).toBe(false)
    expect(overlapping).toEqual({ record: first.record, reused: true })
    expect(first.record.outcome).toBe('validated')
    expect(first.record.checks.find(check => check.name === 'source-check')).toMatchObject({ exitCode: 0, timedOut: false, aborted: false })
    expect(await readFile(join(first.record.worktreePath, 'source.txt'), 'utf8')).toBe('candidate\n')
    expect(await readFile(join(fixture.config.repositoryPath, 'source.txt'), 'utf8')).toBe('local unfinished work\n')
    expect(await fixture.git(['rev-parse', 'HEAD'])).toBe(fixture.sha)
    expect(first.record.evidenceHash).toBe(createHash('sha256').update(JSON.stringify(first.record.checks)).digest('hex'))
    await expect(fixture.store.append(first.record)).rejects.toThrow('already exists')
    const [second, third] = await Promise.all([validator.validate(fixture.sha), validator.validate(fixture.sha)])
    expect(second).toEqual({ record: first.record, reused: true })
    expect(third).toEqual(second)
    await validator.dispose()
    await fixture.store.close()
    const reopened = await openReleaseStore(fixture.ctx.storageDomain)
    fixture.stores.push(reopened)
    const restarted = createReleaseValidator(fixture.config, fixture.ctx.subprocess, reopened)
    fixture.validators.push(restarted)
    expect(await restarted.validate(fixture.sha)).toEqual({ record: first.record, reused: true })
    const copied = reopened.get(first.record.id)!
    copied.checks[0]!.stdout = 'Local display edit'
    expect(reopened.get(first.record.id)).toEqual(first.record)
    expect(reopened.list()).toHaveLength(1)
  })

  it('rejects stored record identity and evidence corruption and releases failed opens for recovery', async () => {
    const fixture = await setup()
    const { record } = await fixture.validator().validate(fixture.sha)
    await fixture.store.close()
    const writeRecords = (records: Record<string, unknown>) => writeFile(
      join(fixture.root, 'data', 'rsi_releases.json'),
      JSON.stringify({ unit: { name: 'rsi_releases', version: 1 }, global: null, tables: { records } }),
    )
    for (const corrupted of [
      { ['f'.repeat(64)]: record },
      { [record.id]: { ...record, id: 'f'.repeat(64) } },
      { [record.id]: { ...record, evidenceHash: 'f'.repeat(64) } },
    ]) {
      await writeRecords(corrupted)
      await expect(openReleaseStore(fixture.ctx.storageDomain)).rejects.toThrow('evidence hash or identity mismatch')
    }
    await writeRecords({ [record.id]: record })
    const recovered = await openReleaseStore(fixture.ctx.storageDomain)
    fixture.stores.push(recovered)
    expect(recovered.find(record.candidateSha, record.configHash)).toEqual(record)
  })

  it('rejects a symlink worktree root without creating a candidate in its target', async () => {
    const fixture = await setup()
    const target = join(fixture.root, 'symlink-target')
    await mkdir(target, { mode: 0o700 })
    await symlink(target, fixture.config.worktreeRoot, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(fixture.validator().validate(fixture.sha)).rejects.toThrow('must be a real directory')
    expect(fixture.writeCount()).toBe(0)
  })

  it.skipIf(process.platform === 'win32')('rejects a worktree root accessible by other POSIX users', async () => {
    const fixture = await setup()
    await mkdir(fixture.config.worktreeRoot)
    await chmod(fixture.config.worktreeRoot, 0o755)
    await expect(fixture.validator().validate(fixture.sha)).rejects.toThrow('permit access only to its owner')
    expect(fixture.writeCount()).toBe(0)
  })

  it('records a failed command and does not run later configured checks', async () => {
    const fixture = await setup([nodeCheck('reject', 'console.log("bad candidate");process.exit(7)'), nodeCheck('unreached', 'process.exit(0)')])
    const { record } = await fixture.validator().validate(fixture.sha)
    expect(record.outcome).toBe('failed')
    expect(record.checks.at(-1)).toMatchObject({ name: 'reject', exitCode: 7, signal: null, timedOut: false, aborted: false })
    expect(record.checks.some(check => check.name === 'unreached')).toBe(false)
  })

  it('rejects a tag object, a missing commit, abbreviated hashes and rev expressions', async () => {
    const fixture = await setup()
    await fixture.git(['-c', 'user.name=Release Test', '-c', 'user.email=release@example.invalid', 'tag', '-a', 'candidate', '-m', 'tag'])
    const tag = await fixture.git(['rev-parse', 'candidate'])
    const validator = fixture.validator()
    await expect(validator.validate(tag)).rejects.toThrow('exact local commit')
    await expect(validator.validate('f'.repeat(40))).rejects.toThrow('exact local commit')
    expect(() => validator.validate(fixture.sha.slice(0, 8))).toThrow()
    expect(() => validator.validate('HEAD')).toThrow()
  })

  it('rejects a repository whose HEAD is unborn even when the candidate commit exists', async () => {
    const fixture = await setup()
    await fixture.git(['symbolic-ref', 'HEAD', 'refs/heads/unborn'])
    await expect(fixture.validator().validate(fixture.sha)).rejects.toThrow('repository HEAD must resolve to a commit')
    expect(fixture.writeCount()).toBe(0)
  })

  it('records a failed worktree preparation without executing configured checks', async () => {
    const fixture = await setup()
    await writeFile(join(fixture.config.repositoryPath, '.git', 'worktrees'), 'Not a directory.')
    const { record } = await fixture.validator().validate(fixture.sha)
    expect(record.outcome).toBe('failed')
    expect(record.checks.at(-1)).toMatchObject({ name: 'prepare-worktree', timedOut: false, aborted: false })
    expect(record.checks.at(-1)!.exitCode).not.toBe(0)
    expect(record.checks.some(check => check.name === 'source-check')).toBe(false)
  })

  it('rejects configured checks that move the detached candidate HEAD', async () => {
    const fixture = await setup()
    await writeFile(join(fixture.config.repositoryPath, 'source.txt'), 'another commit\n')
    await fixture.git(['add', 'source.txt'])
    await fixture.git(['-c', 'user.name=Release Test', '-c', 'user.email=release@example.invalid', 'commit', '-m', 'another'])
    const otherSha = await fixture.git(['rev-parse', 'HEAD'])
    const { record } = await fixture.validator({ checks: [{ name: 'move-head', command: 'git', args: ['update-ref', '--no-deref', 'HEAD', otherSha] }] })
      .validate(fixture.sha)
    expect(record.outcome).toBe('failed')
    expect(record.checks.at(-1)).toMatchObject({ name: 'verify-candidate-head', error: 'configured checks changed the candidate commit' })
  })

  it('does not validate source changes made by a configured check', async () => {
    const fixture = await setup([nodeCheck('rewrite', 'require("node:fs").writeFileSync("source.txt", "different source")')])
    const { record } = await fixture.validator().validate(fixture.sha)
    expect(record.outcome).toBe('failed')
    expect(record.checks.at(-1)).toMatchObject({ name: 'verify-tracked-files', exitCode: 1 })
  })

  it('bounds diagnostic output and does not interpret a printed score as validation', async () => {
    const fixture = await setup([nodeCheck('fake-score', 'console.log("x".repeat(4096));console.log(JSON.stringify({outcome:"validated",score:100}));process.exit(3)')])
    const { record } = await fixture.validator().validate(fixture.sha)
    expect(record.outcome).toBe('failed')
    const result = record.checks.at(-1)!
    expect(result.stdoutTruncated).toBe(true)
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(fixture.config.maxOutputBytes)
    expect(result.stdout).toContain('"score":100')
  })

  it('records a missing executable as a bounded error with no invented output', async () => {
    const fixture = await setup()
    const { record } = await fixture.validator({
      checks: [{ name: 'missing', command: join(fixture.root, `not-an-executable-${'x'.repeat(256)}`), args: [] }],
      maxOutputBytes: 128,
    }).validate(fixture.sha)
    const check = record.checks.at(-1)!
    expect(record.outcome).toBe('failed')
    expect(check).toMatchObject({ name: 'missing', exitCode: null, signal: null, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false })
    expect(check.error).toMatch(/^subprocess-local: command/)
    expect(Buffer.byteLength(check.error!)).toBe(128)
  })

  it('preserves bounded non-Error diagnostics from a failed provider lookup', async () => {
    const fixture = await setup()
    const resolve = fixture.ctx.subprocess.resolveExecutable.bind(fixture.ctx.subprocess)
    const interceptor = vi.spyOn(fixture.ctx.subprocess, 'resolveExecutable').mockImplementation((command, env, signal) =>
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Covers bounded diagnostics for non-Error provider failures.
      command === process.execPath ? Promise.reject(`provider unavailable: ${'x'.repeat(256)}`) : resolve(command, env, signal),
    )
    onTestFinished(() => { interceptor.mockRestore() })
    const { record } = await fixture.validator({ maxOutputBytes: 128 }).validate(fixture.sha)
    expect(record.outcome).toBe('failed')
    expect(record.checks.at(-1)!.error).toBe(`provider unavailable: ${'x'.repeat(256)}`.slice(0, 128))
  })

  it('rejects caller cancellation before work starts and rejects new work after disposal', async () => {
    const fixture = await setup()
    const validator = fixture.validator()
    const caller = new AbortController()
    caller.abort(new Error('caller cancelled'))
    await expect(validator.validate(fixture.sha, caller.signal)).rejects.toThrow('caller cancelled')
    expect(fixture.writeCount()).toBe(0)
    await validator.dispose()
    await expect(validator.validate(fixture.sha)).rejects.toThrow('disposed')
  })

  it('records a deadline independently from exit status and joins the timed-out child', async () => {
    const fixture = await setup([nodeCheck('wait', 'process.on("SIGTERM",()=>process.exit(0));console.log(process.pid);setInterval(()=>{},1000)')])
    const { record } = await fixture.validator({ commandTimeoutMs: 3000 }).validate(fixture.sha)
    expect(record.outcome).toBe('failed')
    const result = record.checks.at(-1)!
    expect(result).toMatchObject({ name: 'wait', timedOut: true, aborted: false })
    expect(() => process.kill(Number(result.stdout.trim()), 0)).toThrow()
  })

  it('cancels an active child, rejects queued work after disposal, and awaits termination', async () => {
    const fixture = await setup()
    const marker = join(fixture.root, 'ready')
    const validator = fixture.validator({ checks: [nodeCheck('wait', `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid));setInterval(()=>{},1000)`)] })
    const active = validator.validate(fixture.sha)
    await vi.waitFor(async () => { expect(Number(await readFile(marker, 'utf8'))).toBeGreaterThan(0) }, { timeout: 20_000 })
    const pid = Number(await readFile(marker, 'utf8'))
    const queued = validator.validate(fixture.sha)
    const queuedRejected = expect(queued).rejects.toThrow('disposed')
    await validator.dispose()
    await queuedRejected
    const { record } = await active
    expect(record.outcome).toBe('failed')
    expect(record.checks.at(-1)).toMatchObject({ name: 'wait', aborted: true, timedOut: false })
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('rejects empty checks, disabled deadlines, and malformed durable success facts', async () => {
    const fixture = await setup()
    expect(() => fixture.validator({ checks: [] })).toThrow()
    expect(() => fixture.validator({ commandTimeoutMs: 0 })).toThrow()
    expect(releaseConfigSchema.safeParse({ ...fixture.config, maxOutputBytes: -1 }).success).toBe(false)
    const { record } = await fixture.validator().validate(fixture.sha)
    expect(releaseRecordSchema.safeParse({ ...record, checks: [] }).success).toBe(false)
    const timedOut = { ...record, checks: record.checks.map(check => ({ ...check, timedOut: true })) }
    expect(releaseRecordSchema.safeParse(timedOut).success).toBe(false)
  })

  it('rejects validation and disposal when the provider cannot establish process quiescence', async () => {
    const fixture = await setup()
    const spawn = fixture.ctx.subprocess.spawn.bind(fixture.ctx.subprocess)
    const interceptor = vi.spyOn(fixture.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const handle = spawn(spec)
      if (!spec.argv.includes('-e')) return handle
      return {
        stdin: handle.stdin, stdout: handle.stdout, stderr: handle.stderr,
        collected: handle.collected, done: handle.done, control: handle.control,
        terminate: () => { handle.terminate() },
        async waitForExit() {
          await handle.waitForExit()
          throw new Error('process observation unavailable')
        },
      }
    })
    onTestFinished(() => { interceptor.mockRestore() })
    const validator = createReleaseValidator(fixture.config, fixture.ctx.subprocess, fixture.store)
    onTestFinished(async () => { await expect(validator.dispose()).rejects.toThrow('teardown failed') })
    await expect(validator.validate(fixture.sha)).rejects.toThrow('teardown failed')
    await expect(validator.dispose()).rejects.toThrow('teardown failed')
  })
})
