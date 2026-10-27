/** Project composition persists independently and captures the complete local capability graph. */
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CognitivePluginId, CognitiveTaskId, CognitiveUnitId, CognitivePlugin } from '../../src/harness/cognition-types.ts'
import { agentProfilePaths, initializeAgentProfile, prepareAgentWorkspace, readAgentProfile, resolveAgentProfile, selectAgentBundle, verifyAgentProfile } from '../../src/harness/agent-profile.ts'
import { resolveConfig } from '../../src/harness/index.ts'
import { inspectPluginArtifact, verifyPluginExecution } from '../../src/harness/cognitive-plugins.ts'
import { assembleProjectPackages } from '../../src/harness/execution/project-packages.ts'

const limits = { maxPluginBytes: 16384, maxPluginFiles: 50 }
const runtimeBundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app']
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-profile-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const paths = agentProfilePaths(root, 'rsi-project-a', {
    pluginDirectory: 'plugins', bundleDirectory: 'bundles', profileDirectory: 'profile', workspaceDirectory: 'workspace',
  })
  await initializeAgentProfile(paths, runtimeBundles)
  const directory = join(paths.bundles, 'research')
  const plugin = join(paths.plugins, 'inspect')
  await mkdir(directory)
  await mkdir(plugin)
  await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: '@local/inspect', version: '1.0.0', type: 'module', exports: './index.js' }))
  await writeFile(join(plugin, 'index.js'), 'export function apply() {}\n')
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@local/research', version: '1.0.0', type: 'module',
    dependencies: { '@local/inspect': 'file:../../plugins/inspect' }, dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  await writeFile(join(directory, 'cordis.patch.yml'), '- insert:\n    - id: inspection\n      name: "@local/inspect"\n')
  const artifact: CognitivePlugin = { ...await inspectPluginArtifact(paths.bundles, directory, limits, paths.plugins),
    id: brandString<CognitivePluginId>('00000000-0000-4000-8000-000000000001'),
    taskId: brandString<CognitiveTaskId>('00000000-0000-4000-8000-000000000002'),
    units: [{ id: brandString<CognitiveUnitId>('00000000-0000-4000-8000-000000000003'), revision: 1 }],
    createdAt: '2026-10-22T00:00:00.000Z' }
  return { root, paths, artifact, plugin }
}

it('creates a separate task directory and preserves its files across initialization', async () => {
  const f = await fixture()
  expect((await readdir(f.root)).sort()).toEqual(['bundles', 'plugins', 'profile', 'workspace'])
  await writeFile(join(f.paths.workspace, 'task.txt'), 'task input\n')
  await initializeAgentProfile(f.paths, runtimeBundles)
  expect(await readFile(join(f.paths.workspace, 'task.txt'), 'utf8')).toBe('task input\n')
})

it('prepares a configured task directory for an existing Agent without moving its files', async () => {
  const f = await fixture()
  const paths = agentProfilePaths(f.root, f.paths.name, resolveConfig({ workspaceDirectory: 'tasks/workspace' }))
  await writeFile(join(f.root, 'existing.txt'), 'existing input\n')
  expect(await prepareAgentWorkspace(paths)).toBe(join(f.paths.root, 'tasks/workspace'))
  expect(await readdir(paths.workspace)).toEqual([])
  expect(await readFile(join(f.root, 'existing.txt'), 'utf8')).toBe('existing input\n')
})

it.each(['', '.', '..', '../outside', '/tmp/outside', 'C:\\outside', 'plugins', 'plugins/tasks',
  'plugins\\tasks', 'bundles', 'profile', '.rsi', '.rsi/tasks'])('rejects invalid task directory %j', (workspaceDirectory) => {
  expect(() => resolveConfig({ workspaceDirectory })).toThrow()
})

it('rejects a task directory containing a capability directory', () => {
  expect(() => resolveConfig({ workspaceDirectory: 'tasks', pluginDirectory: 'tasks/plugins' })).toThrow('overlap')
})

it('rejects a file occupying the task directory', async () => {
  const f = await fixture()
  await rm(f.paths.workspace, { recursive: true })
  await writeFile(f.paths.workspace, 'task file\n')
  await expect(prepareAgentWorkspace(f.paths)).rejects.toThrow('Agent directories must be directories')
  expect(await readFile(f.paths.workspace, 'utf8')).toBe('task file\n')
})

it.skipIf(process.platform === 'win32')('rejects redirected task directories before using them', async () => {
  const f = await fixture()
  const other = await fixture()
  await rm(f.paths.workspace, { recursive: true })
  await symlink(other.root, f.paths.workspace)
  await expect(prepareAgentWorkspace(f.paths)).rejects.toThrow('symbolic links')
  await expect(initializeAgentProfile(f.paths, runtimeBundles)).rejects.toThrow('symbolic links')
})

it('keeps each project selection through restart and leaves other project and host profiles untouched', async () => {
  const first = await fixture()
  const second = await fixture()
  const secondBefore = await readFile(join(second.paths.profile, 'package.json'), 'utf8')
  const hostProfile = join(first.root, 'application-profile.json')
  await writeFile(hostProfile, '{"application":"rsi"}\n')
  await selectAgentBundle(first.paths, first.artifact, true, limits, () => {})
  await initializeAgentProfile(first.paths, runtimeBundles)
  const selected = await resolveAgentProfile(first.paths, runtimeBundles, [first.artifact])
  expect(selected.artifacts).toEqual([first.artifact])
  expect(selected.snapshot.bundles).toEqual([...runtimeBundles, first.artifact.name])
  expect((await readAgentProfile(first.paths)).manifest.dependencies).toEqual({ '@local/research': 'file:../bundles/research' })
  expect(await readFile(join(second.paths.profile, 'package.json'), 'utf8')).toBe(secondBefore)
  expect(await readFile(hostProfile, 'utf8')).toBe('{"application":"rsi"}\n')
  await expect(resolveAgentProfile(first.paths, runtimeBundles, [])).rejects.toThrow('registered local bundle')
  await expect(resolveAgentProfile(first.paths, runtimeBundles, [second.artifact])).rejects.toThrow('different source')
  await selectAgentBundle(first.paths, first.artifact, false, limits, () => {})
  expect((await resolveAgentProfile(first.paths, runtimeBundles, [first.artifact])).artifacts).toEqual([])
})

it('includes sibling plugin content in bundle identity and snapshots the graph independently for each run', async () => {
  const f = await fixture()
  await selectAgentBundle(f.paths, f.artifact, true, limits, () => {})
  const profile = (await readAgentProfile(f.paths)).snapshot
  const execution = { ...limits, root: f.paths.bundles, pluginRoot: f.paths.plugins, artifacts: [f.artifact], profile }
  const output = await assembleProjectPackages(execution, join(f.root, 'run', 'sources'))
  const copied = output.packages.find(pkg => pkg.name === '@local/inspect')!
  expect(await readFile(join(copied.directory, 'index.js'), 'utf8')).toBe('export function apply() {}\n')
  expect(output.bundles[0]!.directory).not.toBe(f.artifact.directory)
  await writeFile(join(f.plugin, 'index.js'), 'export function apply() { throw new Error("new revision") }\n')
  await expect(verifyPluginExecution(execution)).rejects.toThrow('source changed')
  expect(await readFile(join(copied.directory, 'index.js'), 'utf8')).toBe('export function apply() {}\n')
  await expect(selectAgentBundle(f.paths, f.artifact, true, limits, () => {})).rejects.toThrow('source changed')
  await selectAgentBundle(f.paths, f.artifact, false, limits, () => {})
  await expect(verifyAgentProfile(profile)).rejects.toThrow('profile changed')
})

it('rejects foreign local dependencies, conflicting ownership and a lost writer before publication', async () => {
  const f = await fixture()
  const manifestPath = join(f.paths.profile, 'package.json')
  const before = await readFile(manifestPath, 'utf8')
  await expect(selectAgentBundle(f.paths, f.artifact, true, limits, () => { throw new Error('writer lost') })).rejects.toThrow('writer lost')
  expect(await readFile(manifestPath, 'utf8')).toBe(before)
  const manifest = z.looseObject({ dependencies: z.record(z.string(), z.string()) })
    .parse(JSON.parse(await readFile(join(f.artifact.directory, 'package.json'), 'utf8')))
  manifest.dependencies['@local/inspect'] = 'file:../../../other-project'
  await writeFile(join(f.artifact.directory, 'package.json'), JSON.stringify(manifest))
  await expect(inspectPluginArtifact(f.paths.bundles, f.artifact.directory, limits, f.paths.plugins)).rejects.toThrow('owning project')
  const profile = z.looseObject({ name: z.string() }).parse(JSON.parse(before))
  profile.name = 'different-agent'
  await writeFile(manifestPath, JSON.stringify(profile))
  await expect(readAgentProfile(f.paths)).rejects.toThrow('owning project')
})

it.skipIf(process.platform === 'win32')('rejects redirected profiles and bundle sources without writing to another project', async () => {
  const f = await fixture()
  const other = await fixture()
  await rm(f.paths.profile, { recursive: true })
  await symlink(other.paths.profile, f.paths.profile)
  const before = await readFile(join(other.paths.profile, 'package.json'), 'utf8')
  await expect(initializeAgentProfile(f.paths, runtimeBundles)).rejects.toThrow('symbolic links')
  expect(await readFile(join(other.paths.profile, 'package.json'), 'utf8')).toBe(before)
  await symlink(f.artifact.directory, join(f.paths.bundles, 'alias'))
  await expect(inspectPluginArtifact(f.paths.bundles, join(f.paths.bundles, 'alias'), limits, f.paths.plugins)).rejects.toThrow('symbolic links')
})
