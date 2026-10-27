/** Exact local artifacts and actual live entries determine plugin availability. */
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { fromPartial } from '@total-typescript/shoehorn'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CognitivePlugin, CognitivePluginId, CognitiveTaskId, CognitiveUnitId, CognitiveSnapshot, CognitiveTask } from '../../src/harness/cognition-types.ts'
import { inspectPluginArtifact, pluginsForUnits, verifyPluginExecution, selectedPluginArtifacts } from '../../src/harness/cognitive-plugins.ts'

const limits = { maxPluginFiles: 20, maxPluginBytes: 4096 }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cognitive-plugins-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'plugin')
  await mkdir(directory)
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@local/record-check-v1', version: '1.0.0', type: 'module',
    dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(join(directory, 'cordis.patch.yml'), '- insert: []\n')
  await writeFile(join(directory, 'index.js'), 'export function apply() {}\n')
  const unit = { id: brandString<CognitiveUnitId>('00000000-0000-4000-8000-000000000001'), revision: 1 }
  const artifact: CognitivePlugin = { ...await inspectPluginArtifact(root, directory, limits),
    id: brandString<CognitivePluginId>('00000000-0000-4000-8000-000000000002'),
    taskId: brandString<CognitiveTaskId>('00000000-0000-4000-8000-000000000003'), units: [unit], createdAt: '2026-10-21T00:00:00.000Z' }
  return { root, directory, artifact, unit }
}

it('bounds complete artifacts, rejects escaped patches and keeps dependency directories out of source identity', async () => {
  const f = await fixture()
  await mkdir(join(f.directory, 'node_modules'))
  await writeFile(join(f.directory, 'node_modules', 'installed.js'), 'dependency')
  expect((await inspectPluginArtifact(f.root, f.directory, limits)).contentHash).toBe(f.artifact.contentHash)
  await expect(inspectPluginArtifact(f.root, f.directory, { ...limits, maxPluginFiles: 1 })).rejects.toThrow('limit')
  await expect(inspectPluginArtifact(f.root, f.directory, { ...limits, maxPluginBytes: 1 })).rejects.toThrow('limit')
  await expect(inspectPluginArtifact(f.directory, f.root, limits)).rejects.toThrow('workspace bundles directory')
  await writeFile(join(f.directory, 'package.json'), JSON.stringify({ name: '@local/record-check-v1', version: '1.0.0', type: 'module',
    dsh: { bundle: { patch: '../outside.yml' } } }))
  await expect(inspectPluginArtifact(f.root, f.directory, limits)).rejects.toThrow('inside its package')
})

it.skipIf(process.platform === 'win32')('does not follow source symlinks outside the package', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'outside.js'), 'outside')
  await symlink(join(f.root, 'outside.js'), join(f.directory, 'escape.js'))
  await expect(inspectPluginArtifact(f.root, f.directory, limits)).rejects.toThrow('symbolic links')
})

it('does not reuse a plugin implementation for a different cognitive revision', async () => {
  const f = await fixture()
  expect(pluginsForUnits([f.unit], [f.artifact])).toEqual([f.artifact])
  expect(() => pluginsForUnits([{ ...f.unit, revision: 2 }], [f.artifact])).toThrow('revised cognitive capability')
  await expect(verifyPluginExecution({ root: f.root, artifacts: [f.artifact], ...limits })).resolves.toBeUndefined()
})

it('reuses unchanged baseline capabilities while requiring plugin implementations for revised units', async () => {
  const f = await fixture()
  const state = fromPartial<CognitiveSnapshot>({ plugins: [] })
  const task = fromPartial<CognitiveTask>({ units: [f.unit] })
  expect(selectedPluginArtifacts(state, task)).toEqual([])
  expect(() => selectedPluginArtifacts(state, { ...task, units: [{ ...f.unit, revision: 2 }] })).toThrow('revised cognitive capability')
  expect(selectedPluginArtifacts({ ...state, plugins: [f.artifact] }, task)).toEqual([f.artifact])
  expect(() => selectedPluginArtifacts({ ...state, plugins: [f.artifact] }, task, [])).toThrow('revised cognitive capability')
})
