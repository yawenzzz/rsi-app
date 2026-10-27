/** Project registration creates only identity metadata and rejects ambiguous directory ownership. */
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, symlink, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { AgentCatalog } from '../../src/harness/catalog.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-catalog-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return { root, path: join(root, 'catalog.json'), catalog: new AgentCatalog(join(root, 'catalog.json'), 10) }
}

it('registers stable identity without a baseline and keeps existing project files', async () => {
  const f = await fixture()
  const project = join(f.root, 'project')
  await mkdir(project)
  await writeFile(join(project, 'source.txt'), 'user source\n')
  expect(await f.catalog.list()).toEqual([])
  const record = await f.catalog.create({ name: 'A', path: project }, async () => {})
  expect(await readdir(project)).toEqual(['.rsi', 'source.txt'])
  expect(await readFile(join(project, 'source.txt'), 'utf8')).toBe('user source\n')
  expect(await new AgentCatalog(f.path, 10).get(record.id)).toEqual(record)
  await expect(f.catalog.create({ name: 'nested', path: join(project, 'child') }, async () => {})).rejects.toThrow('overlaps')
})

it('does not publish a project whose preparation failed and reuses its retained identity on retry', async () => {
  const f = await fixture()
  const project = join(f.root, 'project')
  await expect(f.catalog.create({ name: 'A', path: project }, async () => { throw new Error('invalid profile') })).rejects.toThrow('invalid profile')
  const identity = await readFile(join(project, '.rsi/identity.json'), 'utf8')
  expect(await f.catalog.list()).toEqual([])
  await f.catalog.create({ name: 'A', path: project }, async () => {})
  expect(await readFile(join(project, '.rsi/identity.json'), 'utf8')).toBe(identity)
})

it.skipIf(process.platform === 'win32')('rejects a state-directory symlink without writing an identity outside the project', async () => {
  const f = await fixture()
  const project = join(f.root, 'project'), other = join(f.root, 'other')
  await mkdir(project)
  await mkdir(other)
  await symlink(other, join(project, '.rsi'))
  await expect(f.catalog.create({ name: 'A', path: project }, async () => {})).rejects.toThrow('symbolic link')
  expect(await readdir(other)).toEqual([])
})

it('refuses an unmigrated project instead of creating empty task history under the new name', async () => {
  const f = await fixture()
  const project = join(f.root, 'project')
  const registered = await f.catalog.create({ name: 'A', path: project }, async () => {})
  const original = await readFile(join(project, '.rsi/identity.json'), 'utf8')
  await rename(join(project, '.rsi'), join(project, '.poly-rsi'))
  await expect(f.catalog.get(registered.id)).rejects.toThrow('migrate')
  await expect(new AgentCatalog(join(f.root, 'other.json'), 10).create({ name: 'A', path: project }, async () => {}))
    .rejects.toThrow('existing tasks must be preserved')
  expect(await readdir(project)).toEqual(['.poly-rsi'])
  expect(await readFile(join(project, '.poly-rsi/identity.json'), 'utf8')).toBe(original)
})
