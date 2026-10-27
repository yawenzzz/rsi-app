/** Native project profile edits persist across runtime preparation and remain project-local. */
import { mkdtemp, mkdir, readFile, realpath, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { agentProfilePaths, initializeAgentProfile } from '../../src/harness/agent-profile.ts'
import { prepareRuntimeProfile } from '../../src/harness/runtime-profile.ts'

const builtins = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@yawenzzz/dsh-rsi']
const limits = { maxPluginBytes: 16384, maxPluginFiles: 50 }

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rsi-writable-profile-')))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const paths = agentProfilePaths(root, 'agent-test', {
    pluginDirectory: 'plugins', bundleDirectory: 'bundles', profileDirectory: 'profile', workspaceDirectory: 'workspace',
  })
  await initializeAgentProfile(paths, builtins)
  const prepare = () => prepareRuntimeProfile(paths, builtins, new Map(), limits, '1.0.0')
  return { root, paths, prepare }
}

it('preserves native settings and manifest edits in the project source through restart', async () => {
  const first = await fixture()
  const second = await fixture()
  const untouched = await readFile(join(second.paths.profile, 'cordis.patch.yml'), 'utf8')
  const runtime = await first.prepare()
  const profile = join(runtime.home, 'profiles', runtime.name)
  expect(await realpath(profile)).toBe(first.paths.profile)
  const patch = '- id: codex-subscription\n  config:\n    contextMode: extended\n'
  await writeFileAtomic(join(profile, 'cordis.patch.yml'), patch, { mode: 0o600 })
  const manifest = z.object({ description: z.string().optional() }).loose().parse(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')))
  manifest.description = 'Saved through native project management'
  await writeFileAtomic(join(profile, 'package.json'), JSON.stringify(manifest) + '\n', { mode: 0o600 })
  expect(await readFile(join(first.paths.profile, 'cordis.patch.yml'), 'utf8')).toBe(patch)
  const restarted = await first.prepare()
  expect(restarted.hash).not.toBe(runtime.hash)
  expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toBe(patch)
  expect(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))).toMatchObject({ description: manifest.description })
  expect(await readFile(join(second.paths.profile, 'cordis.patch.yml'), 'utf8')).toBe(untouched)
})

it('retains an older generated profile before linking the authoritative project profile', async () => {
  const f = await fixture()
  const generated = join(f.root, '.rsi/home/profiles', f.paths.name)
  await mkdir(generated, { recursive: true })
  await writeFile(join(generated, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(generated, 'retained.txt'), 'old generated state\n')
  await writeFile(join(f.paths.profile, 'cordis.patch.yml'), '- id: codex-subscription\n  config:\n    contextMode: extended\n')
  await f.prepare()
  expect(await realpath(generated)).toBe(f.paths.profile)
  const backups = await readdir(join(f.root, '.rsi/profile-backups'))
  expect(backups).toHaveLength(1)
  expect(await readFile(join(f.root, '.rsi/profile-backups', backups[0]!, 'profile/retained.txt'), 'utf8')).toBe('old generated state\n')
  expect(await readFile(join(generated, 'cordis.patch.yml'), 'utf8')).toContain('extended')
})

it('rejects a runtime profile alias pointing at another project', async () => {
  const first = await fixture()
  const second = await fixture()
  const parent = join(first.root, '.rsi/home/profiles')
  await mkdir(parent, { recursive: true })
  await symlink(second.paths.profile, join(parent, first.paths.name), process.platform === 'win32' ? 'junction' : 'dir')
  const before = await readFile(join(second.paths.profile, 'package.json'), 'utf8')
  await expect(first.prepare()).rejects.toThrow('different project')
  expect(await readFile(join(second.paths.profile, 'package.json'), 'utf8')).toBe(before)
})

it('keeps a profile-installed external bundle available across restart', async () => {
  const f = await fixture()
  const directory = join(f.paths.profile, 'node_modules', 'example-bundle')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'example-bundle', version: '1.2.3',
    dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  await writeFile(join(directory, 'cordis.patch.yml'), '[]\n')
  const file = join(f.paths.profile, 'package.json')
  const manifest = z.object({ dependencies: z.record(z.string(), z.string()),
    dsh: z.object({ profile: z.object({ bundles: z.array(z.string()) }) }) }).loose().parse(JSON.parse(await readFile(file, 'utf8')))
  manifest.dependencies['example-bundle'] = '^1.2.3'
  manifest.dsh.profile.bundles.push('example-bundle')
  await writeFile(file, JSON.stringify(manifest) + '\n')
  const runtime = await f.prepare()
  expect(await realpath(join(runtime.home, 'profiles', runtime.name, 'node_modules/example-bundle'))).toBe(directory)
  await f.prepare()
  expect(await readFile(file, 'utf8')).toBe(JSON.stringify(manifest) + '\n')
})

it('loads local capability snapshots while keeping the source dependency declaration editable', async () => {
  const f = await fixture()
  const directory = join(f.paths.bundles, 'capability')
  await mkdir(directory)
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'local-capability', version: '1.0.0', type: 'module',
    dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  await writeFile(join(directory, 'cordis.patch.yml'), '- id: session-title-llm\n  disabled: true\n')
  const file = join(f.paths.profile, 'package.json')
  const manifest = z.object({ dependencies: z.record(z.string(), z.string()),
    dsh: z.object({ profile: z.object({ bundles: z.array(z.string()) }) }) }).loose().parse(JSON.parse(await readFile(file, 'utf8')))
  manifest.dependencies['local-capability'] = 'file:../bundles/capability'
  manifest.dsh.profile.bundles.push('local-capability')
  await writeFile(file, JSON.stringify(manifest) + '\n')
  const first = await f.prepare()
  const copied = first.bundles[0]!
  expect(copied.directory).not.toBe(directory)
  await writeFile(join(directory, 'cordis.patch.yml'), '- id: session-title-llm\n  disabled: false\n')
  expect(await readFile(join(copied.directory, 'cordis.patch.yml'), 'utf8')).toContain('true')
  const second = await f.prepare()
  expect(second.hash).not.toBe(first.hash)
  expect(await realpath(join(f.paths.profile, 'node_modules/local-capability'))).toBe(second.bundles[0]!.directory)
  expect(await readFile(file, 'utf8')).toBe(JSON.stringify(manifest) + '\n')
})

it('rejects missing external installations without replacing the source configuration', async () => {
  const f = await fixture()
  const file = join(f.paths.profile, 'package.json')
  const manifest = z.object({ dependencies: z.record(z.string(), z.string()),
    dsh: z.object({ profile: z.object({ bundles: z.array(z.string()) }) }) }).loose().parse(JSON.parse(await readFile(file, 'utf8')))
  manifest.dependencies['missing-bundle'] = '^1.0.0'
  manifest.dsh.profile.bundles.push('missing-bundle')
  const content = JSON.stringify(manifest) + '\n'
  await writeFile(file, content)
  await expect(f.prepare()).rejects.toThrow('Install Agent bundle missing-bundle')
  expect(await readFile(file, 'utf8')).toBe(content)
})
