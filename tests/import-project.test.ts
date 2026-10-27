/** Project imports are explicit, lease-protected and reversible without touching retained evidence. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { writeFileAtomic, type WriteFileAtomicOptions } from '@deepseek-ai/dsh-atomic-write'
import { acquireWriterLease, type WriterLeaseOptions } from '../src/runtime/writer-lease.ts'
import { applyProjectImport, inspectProjectImport } from '../scripts/migration-lib.mjs'

const run = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const owner = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name: string; version: string }
const version = getDshRuntimeVersion()
const lease = (options: WriterLeaseOptions) => acquireWriterLease(options, () => {})

async function tree(directory: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const key = `${prefix}${entry.name}`
    if (entry.isSymbolicLink()) result[key] = `link:${await readlink(path)}`
    else if (entry.isDirectory()) { result[`${key}/`] = 'directory'; Object.assign(result, await tree(path, `${key}/`)) }
    else result[key] = (await readFile(path)).toString('base64')
  }
  return result
}

async function fixture(incompatible: 'local' | 'external' | null = null) {
  const temporary = await mkdtemp(join(tmpdir(), 'rsi-project-import-'))
  onTestFinished(() => rm(temporary, { recursive: true, force: true }))
  const project = join(temporary, 'project')
  const home = join(temporary, 'new-home')
  const profile = join(project, 'profile')
  const state = join(project, '.rsi/state')
  const application = join(home, 'profiles/rsi')
  const installed = join(temporary, 'installed-rsi')
  const local = join(project, 'bundles/local')
  const implementation = join(project, 'plugins/implementation')
  const id = 'a-00000000-0000-4000-8000-000000000001'
  await Promise.all([profile, state, join(application, 'node_modules', owner.name.split('/')[0]!), installed, local, implementation,
    join(project, '.rsi/home/sessions/retained')].map(path => mkdir(path, { recursive: true })))
  await writeFile(join(installed, 'package.json'), JSON.stringify({ name: owner.name, version: owner.version,
    engines: { dsh: version }, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(join(installed, 'cordis.patch.yml'), '[]\n')
  await symlink(installed, join(application, 'node_modules', owner.name), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(application, 'package.json'), JSON.stringify({ name: 'rsi', private: true, dependencies: { [owner.name]: `file:${installed}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', owner.name] } } }))
  const identity = JSON.stringify({ id, createdAt: '2026-10-22T00:00:00.000Z' }) + '\n'
  await writeFile(join(project, '.rsi/identity.json'), identity)
  await writeFile(join(state, 'writer'), '', { mode: 0o600 })
  await writeFile(join(state, 'cognition.jsonl'), '{"retained":"human evidence"}\n')
  await writeFile(join(project, '.rsi/home/sessions/retained/session.v4.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 255]))
  const credential = join(temporary, 'credentials.yaml')
  await writeFile(credential, 'private-fixture-token-not-to-be-copied\n', { mode: 0o600 })
  await writeFile(join(local, 'package.json'), JSON.stringify({ name: '@fixture/local', version: '1.0.0',
    dependencies: { '@fixture/implementation': 'file:../../plugins/implementation' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(join(local, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(implementation, 'package.json'), JSON.stringify({ name: '@fixture/implementation', version: '1.0.0',
    peerDependencies: { '@deepseek-ai/dsh-tools': incompatible === 'local' ? '0.2.1-alpha.1' : version } }))
  await writeFile(join(implementation, 'index.js'), 'throw new Error("Preflight must not execute plugin code")\n')
  const manifest = { name: `agent-${id}`, private: true, dependencies: {
    '@deepseek-ai/dsh-rsi-agent': 'file:../legacy-agent', '@fixture/local': 'file:../bundles/local',
  } as Record<string, string>, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-rsi-agent', '@fixture/local'] } } }
  if (incompatible === 'external') {
    const external = join(profile, 'node_modules/external-bundle')
    await mkdir(external, { recursive: true })
    await writeFile(join(external, 'package.json'), JSON.stringify({ name: 'external-bundle', version: '1.0.0',
      engines: { dsh: '0.2.1-alpha.1' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    await writeFile(join(external, 'cordis.patch.yml'), '[]\n')
    manifest.dependencies['external-bundle'] = '1.0.0'
    manifest.dsh.profile.bundles.push('external-bundle')
  }
  const manifestBefore = JSON.stringify(manifest, null, 2) + '\n'
  const patchBefore = `# Preserve the original profile in the backup\n- id: credentials\n  config:\n    path: ${JSON.stringify(credential)}\n    watch: false\n- id: custom\n  config:\n    directory: !!js process.cwd()\n`
  await writeFile(join(profile, 'package.json'), manifestBefore, { mode: 0o600 })
  await writeFile(join(profile, 'cordis.patch.yml'), patchBefore, { mode: 0o600 })
  return { temporary, project, home, profile, state, installed, manifestBefore, patchBefore, identity, input: { project, home } }
}

it('defaults to read-only CLI preflight and preserves the entire fixture tree', async () => {
  const f = await fixture()
  const before = await tree(f.temporary)
  const { stdout } = await run(process.execPath, ['scripts/import-project.mjs', '--project', f.project, '--home', f.home, '--json'], { cwd: root })
  expect(JSON.parse(stdout)).toMatchObject({ mode: 'dry-run', compatible: true, changed: true,
    target: { name: owner.name, directory: await realpath(f.installed) } })
  expect(await tree(f.temporary)).toEqual(before)
})

it('requires the explicit CLI apply flag and uses the built writer-lease owner', async () => {
  const f = await fixture()
  const { stdout } = await run(process.execPath, ['scripts/import-project.mjs', '--project', f.project, '--home', f.home, '--apply', '--json'], { cwd: root })
  expect(JSON.parse(stdout)).toMatchObject({ mode: 'applied', compatible: true })
  expect(await readFile(join(f.project, '.rsi/identity.json'), 'utf8')).toBe(f.identity)
  expect(await readdir(f.state)).not.toContain('writer.lock')
})

it.each(['local', 'external'] as const)('refuses incompatible %s plugins before creating backups or locks', async incompatible => {
  const f = await fixture(incompatible)
  const before = await tree(f.temporary)
  const report = await inspectProjectImport(f.input)
  expect(report.compatible).toBe(false)
  expect(report.problems).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'INCOMPATIBLE_PLUGIN',
    name: incompatible === 'local' ? '@fixture/implementation' : 'external-bundle', exempted: false })]))
  await expect(applyProjectImport(f.input, { acquireLease: lease })).rejects.toMatchObject({ code: 'PRECHECK_FAILED' })
  expect(await tree(f.temporary)).toEqual(before)
})

it('applies only profile changes, retains original bytes and leaves identity and journals unchanged', async () => {
  const f = await fixture()
  const retainedBefore = await tree(join(f.project, '.rsi'))
  const result = await applyProjectImport(f.input, { acquireLease: lease })
  expect(result).toMatchObject({ mode: 'applied', compatible: true })
  const manifest = JSON.parse(await readFile(join(f.profile, 'package.json'), 'utf8'))
  expect(manifest.dsh.profile.bundles).toContain(owner.name)
  expect(manifest.dsh.profile.bundles).not.toContain('@deepseek-ai/dsh-rsi-agent')
  expect(manifest.dependencies[owner.name]).toBe(`file:${result.target.directory}`)
  expect(manifest.dependencies['@fixture/local']).toBe('file:../bundles/local')
  const patch = await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8')
  expect(patch).toContain('role: agent')
  expect(patch).toContain('!!js process.cwd()')
  expect(patch).not.toContain('private-fixture-token-not-to-be-copied')
  expect(await readFile(join(result.backup, 'package.json'), 'utf8')).toBe(f.manifestBefore)
  expect(await readFile(join(result.backup, 'cordis.patch.yml'), 'utf8')).toBe(f.patchBefore)
  const retainedAfter = await tree(join(f.project, '.rsi'))
  for (const [path, bytes] of Object.entries(retainedBefore)) expect(retainedAfter[path]).toBe(bytes)
  expect(await applyProjectImport(f.input, { acquireLease: lease })).toMatchObject({ mode: 'unchanged', backup: null })
})

it('restores both profile files after the second atomic replacement fails', async () => {
  const f = await fixture()
  let writes = 0
  const writeAtomic = async (path: string, content: string | Uint8Array, options: WriteFileAtomicOptions) => {
    if (++writes === 2) throw new Error('Injected second replacement failure')
    await writeFileAtomic(path, content, options)
  }
  await expect(applyProjectImport(f.input, { acquireLease: lease, writeAtomic })).rejects.toMatchObject({ code: 'IMPORT_ROLLED_BACK' })
  expect(await readFile(join(f.profile, 'package.json'), 'utf8')).toBe(f.manifestBefore)
  expect(await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8')).toBe(f.patchBefore)
  expect(await readFile(join(f.project, '.rsi/identity.json'), 'utf8')).toBe(f.identity)
  expect(await readdir(join(f.project, '.rsi/import-backups'))).toHaveLength(1)
  expect(await readdir(f.state)).not.toContain('writer.lock')
})

it('rejects a project while its existing application holds the writer lease', async () => {
  const f = await fixture()
  const held = await lease({ path: join(f.state, 'writer'), staleMs: 30000, updateMs: 10000 })
  onTestFinished(() => held.release())
  const before = await tree(f.temporary)
  expect(await inspectProjectImport(f.input)).toMatchObject({ compatible: false,
    problems: expect.arrayContaining([expect.objectContaining({ code: 'PROJECT_IN_USE' })]) })
  await expect(applyProjectImport(f.input, { acquireLease: lease })).rejects.toMatchObject({ code: 'PRECHECK_FAILED' })
  expect(await tree(f.temporary)).toEqual(before)
  await held.release()
})

it('does not initialize a missing target application home during preflight', async () => {
  const f = await fixture()
  const before = await tree(f.temporary)
  await expect(inspectProjectImport({ project: f.project, home: join(f.temporary, 'missing-home') })).rejects.toMatchObject({ code: 'INVALID_JSON' })
  expect(await tree(f.temporary)).toEqual(before)
})
