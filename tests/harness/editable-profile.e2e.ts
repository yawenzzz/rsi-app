/** Native settings and plugin writes use each project's source profile through restart. */
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import yaml from 'js-yaml'
import { nativeConversationApi as api, nativeConversationFixture as fixture } from './native-conversation.fixture.ts'

it('applies project context settings immediately and retains settings and plugin selection across restart', async () => {
  const { root, profile, start } = await fixture()
  const { host, url } = await start()
  const mainBefore = await readFile(join(profile, 'cordis.patch.yml'), 'utf8')
  const projects: { id: string; directory: string; native: Awaited<ReturnType<typeof api>> }[] = []
  for (const name of ['a', 'b']) {
    const directory = join(root, `project-${name}`)
    const { id } = z.object({ id: z.string() }).parse(await host('agentWorkspaces/createWorkspace', { request: { name, path: directory } }))
    const connection = z.object({ url: z.string() }).parse(await host('agentWorkspaces/openWorkspace', { id }))
    projects.push({ id, directory, native: await api(url, connection.url) })
  }
  const first = projects[0]!
  const second = projects[1]!
  const secondBefore = await readFile(join(second.directory, 'profile/cordis.patch.yml'), 'utf8')
  expect(await first.native('settings/describe', {})).toMatchObject({ writable: true })
  expect(await first.native('settings/update', { ns: 'project-test-provider', patch: { contextWindow: 872000 } }))
    .toMatchObject({ value: { contextWindow: 872000 } })
  const session = z.object({ sessionId: z.string() }).parse(await first.native('session/create', { request: {} }))
  await first.native('session/prompt', { request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue',
    content: [{ type: 'text', text: 'Use the saved model context budget.' }] } })
  await vi.waitFor(async () => {
    expect(await first.native('agentEvidence/read', { sessionId: session.sessionId })).toMatchObject({ success: true })
  }, { timeout: 30000, interval: 100 })
  const sessions = z.object({ items: z.array(z.object({ sessionId: z.string(), projections: z.object({
    values: z.object({ contextPressure: z.object({ contextWindow: z.number() }) }),
  }) })) }).parse(await first.native('session/list', { _request: {} }))
  const contextWindow = sessions.items.find(item => item.sessionId === session.sessionId)!.projections.values.contextPressure.contextWindow
  expect(contextWindow).toBe(872000)
  const saved = z.array(z.object({ id: z.string(), config: z.unknown().optional() }))
    .parse(yaml.load(await readFile(join(first.directory, 'profile/cordis.patch.yml'), 'utf8')))
  expect(saved.find(row => row.id === 'project-test-provider')).toMatchObject({ config: { contextWindow: 872000 } })
  const bundles = z.array(z.object({ name: z.string(), enabled: z.boolean(), readOnlyReason: z.string().optional() }))
  expect(bundles.parse(await first.native('pluginManager/listBundles', {})).find(row => row.name === '@local/project-test-provider'))
    .toMatchObject({ enabled: true })
  expect(await first.native('pluginManager/setBundleEnabled', { name: '@local/project-test-provider', enabled: false }))
    .toMatchObject({ changed: true, application: 'restart-required' })
  const selectedBundles = async () => z.object({ dsh: z.object({ profile: z.object({ bundles: z.array(z.string()) }) }) })
    .parse(JSON.parse(await readFile(join(first.directory, 'profile/package.json'), 'utf8'))).dsh.profile.bundles
  expect(await selectedBundles()).not.toContain('@local/project-test-provider')
  expect(await first.native('pluginManager/setBundleEnabled', { name: '@local/project-test-provider', enabled: true }))
    .toMatchObject({ changed: true, application: 'restart-required' })
  expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toBe(mainBefore)
  expect(await readFile(join(second.directory, 'profile/cordis.patch.yml'), 'utf8')).toBe(secondBefore)
  await host('agentWorkspaces/stopWorkspace', { id: first.id })
  const restarted = z.object({ url: z.string() }).parse(await host('agentWorkspaces/openWorkspace', { id: first.id }))
  const native = await api(url, restarted.url)
  const settings = z.object({ writable: z.boolean(), namespaces: z.array(z.object({ ns: z.string(), value: z.unknown() })) })
  const state = settings.parse(await native('settings/describe', {}))
  const retained = z.object({ contextWindow: z.number() }).parse(state.namespaces.find(row => row.ns === 'project-test-provider')?.value)
  expect({ writable: state.writable, contextWindow, retainedContextWindow: retained.contextWindow,
    providerSelected: (await selectedBundles()).includes('@local/project-test-provider') }).toMatchInlineSnapshot(`
      {
        "contextWindow": 872000,
        "providerSelected": true,
        "retainedContextWindow": 872000,
        "writable": true,
      }
    `)
})
