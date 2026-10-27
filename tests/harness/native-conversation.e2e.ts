/** Ordinary native conversations use project profiles without a baseline, clone or version trial. */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { nativeConversationApi as api, nativeConversationFixture as fixture, dshVersion } from './native-conversation.fixture.ts'

it('isolates two ordinary conversations and preserves native history across a profile restart', async () => {
  const { root, profile, start } = await fixture()
  const { host, url } = await start()
  const unauthenticated = await fetch(new URL('/api/agentWorkspaces/workspaces', url), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(),
      method: 'agentWorkspaces/workspaces', payload: { args: {} } }) })
  expect(unauthenticated.status).toBe(401)
  const parentLogin = await fetch(url, { redirect: 'manual' })
  const parentCookie = parentLogin.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const mainBefore = await readFile(join(profile, 'package.json'), 'utf8')
  const projects: { id: string; path: string; url: string; sessionId: string }[] = []
  for (const letter of ['a', 'b']) {
    const directory = join(root, `project-${letter}`)
    const taskDirectory = join(directory, 'workspace')
    const project = z.object({ id: z.string(), path: z.string() }).parse(await host('agentWorkspaces/createWorkspace', { request: { name: letter, path: directory } }))
    const plugin = join(directory, 'plugins', `capability-${letter}`)
    const bundle = join(directory, 'bundles', `capability-${letter}`)
    await mkdir(plugin)
    await mkdir(bundle)
    const name = `@local/capability-${letter}`
    await writeFile(join(plugin, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', exports: { '.': './index.js', './package.json': './package.json' },
      peerDependencies: { '@deepseek-ai/dsh-tools': dshVersion } }))
    await writeFile(join(plugin, 'index.js'), `import {defineTool} from '@deepseek-ai/dsh-tools'\nexport const inject=['tools']\nexport function apply(ctx){ctx.effect(()=>ctx.tools.register(defineTool({name:'project_capability_${letter}',description:'Project ${letter} only',parameters:{},output:{schema:{type:'string'},render:(_,value)=>[{type:'text',text:value}]},execute:()=> '${letter.toUpperCase()}_ONLY'})))}\n`)
    execFileSync(process.execPath, ['--check', join(plugin, 'index.js')])
    await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: `${name}-bundle`, version: '1.0.0', type: 'module',
      dependencies: { [name]: `file:../../plugins/capability-${letter}` }, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: `capability-${letter}`, name }] }]))
    const source = join(directory, 'profile/package.json')
    const manifest = z.object({ name: z.string(), private: z.boolean(), dependencies: z.record(z.string(), z.string()),
      dsh: z.object({ profile: z.object({ bundles: z.array(z.string()) }) }) }).parse(JSON.parse(await readFile(source, 'utf8')))
    manifest.dependencies[`${name}-bundle`] = `file:../bundles/capability-${letter}`
    manifest.dsh.profile.bundles.push(`${name}-bundle`)
    await writeFile(source, JSON.stringify(manifest))
    const connection = z.object({ url: z.string(), workspaceId: z.string() }).parse(await host('agentWorkspaces/openWorkspace', { id: project.id }).catch(async (error: unknown) => {
      console.error(await readFile(join(directory, '.rsi/logs/startup-error.log'), 'utf8'))
      for (const generation of await readdir(join(directory, '.rsi/cache'))) {
        if (!generation.startsWith('.')) console.error(await readFile(join(directory, '.rsi/cache', generation, 'assembly.json'), 'utf8'))
      }
      throw error
    }))
    expect(connection.workspaceId).toBe(project.id)
    expect(new URL(connection.url).hostname).toBe('127.0.0.1')
    expect(new URL(connection.url).origin).not.toBe(new URL(url).origin)
    expect(new URL(connection.url).searchParams.get('token')).toBeTruthy()
    const foreignCookie = await fetch(new URL('/api/agentWorkspaces/workspaces', connection.url), { method: 'POST',
      headers: { 'content-type': 'application/json', cookie: parentCookie }, body: JSON.stringify({ type: 'client-request',
        rpcId: randomUUID(), method: 'agentWorkspaces/workspaces', payload: { args: {} } }) })
    expect(foreignCookie.status).toBe(401)
    expect(await host('agentWorkspaces/openWorkspace', { id: project.id })).toMatchObject(connection)
    const workspaceData = z.object({ tables: z.object({ workspaces: z.record(z.string(), z.object({ path: z.string() })) }) })
      .parse(JSON.parse(await readFile(join(directory, '.rsi/home/storages/workspace.json'), 'utf8')))
    expect(Object.values(workspaceData.tables.workspaces).map(item => item.path)).toEqual([join(project.path, 'workspace')])
    const native = await api(url, connection.url)
    const session = z.object({ sessionId: z.string() }).parse(await native('session/create', { request: {} }))
    await native('session/prompt', { request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: 'Use the project capability.' }] } })
    await vi.waitFor(async () => {
      const evidence = z.object({ output: z.string(), success: z.boolean() }).parse(await native('agentEvidence/read', { sessionId: session.sessionId }))
      expect(evidence.success).toBe(true)
      expect(JSON.parse(evidence.output)).toMatchObject({ finalResponse: `${letter.toUpperCase()}_ONLY` })
    }, { timeout: 30000, interval: 100 })
    expect(JSON.parse(await readFile(join(taskDirectory, 'request-tools.json'), 'utf8'))).toEqual([`project_capability_${letter}`])
    expect(await readFile(join(taskDirectory, 'task-result.txt'), 'utf8')).toBe('Task deliverable\n')
    expect(JSON.parse(await readFile(join(taskDirectory, 'agent-context.json'), 'utf8'))).toMatchObject({
      project: project.path, workspace: join(project.path, 'workspace'), plugins: join(project.path, 'plugins'),
      bundles: join(project.path, 'bundles'), profileDirectory: join(project.path, 'profile'),
    })
    const entries = await readdir(directory)
    expect(entries.sort()).toEqual(['.rsi', 'bundles', 'plugins', 'profile', 'workspace'])
    projects.push({ ...project, url: connection.url, sessionId: session.sessionId })
  }
  expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(mainBefore)
  const first = projects[0]!
  await host('agentWorkspaces/stopWorkspace', { id: first.id })
  const restarted = z.object({ url: z.string() }).parse(await host('agentWorkspaces/openWorkspace', { id: first.id }))
  expect(new URL(restarted.url).origin).toBe(new URL(first.url).origin)
  const native = await api(url, restarted.url)
  const history = z.object({ items: z.array(z.object({ sessionId: z.string() })) }).parse(await native('session/list', { _request: {} }))
  expect(history.items.some(item => item.sessionId === first.sessionId)).toBe(true)
  expect(z.object({ success: z.boolean() }).parse(await native('agentEvidence/read', { sessionId: first.sessionId })).success).toBe(true)
})

it.skipIf(process.platform === 'win32')('releases project Session writers after abrupt parent exit and resumes their unchanged history', async () => {
  // SIGKILL bypasses parent cleanup; Windows Job ownership has different termination semantics.
  const { root, start } = await fixture()
  const first = await start()
  const directory = join(root, 'project-a')
  const project = z.object({ id: z.string() }).parse(await first.host('agentWorkspaces/createWorkspace', {
    request: { name: 'a', path: directory },
  }))
  const connection = z.object({ url: z.string() }).parse(await first.host('agentWorkspaces/openWorkspace', { id: project.id }))
  const native = await api(first.url, connection.url)
  const session = z.object({ sessionId: z.string() }).parse(await native('session/create', { request: {} }))
  await native('session/prompt', { request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue',
    content: [{ type: 'text', text: 'Retain this conversation across application restarts.' }] } })
  await vi.waitFor(async () => {
    expect(await native('agentEvidence/read', { sessionId: session.sessionId })).toMatchObject({ success: true, turn: 1 })
  }, { timeout: 30000, interval: 100 })
  const sessionEntry = (await readdir(join(directory, '.rsi/home/sessions'), { recursive: true, withFileTypes: true }))
    .find(entry => entry.isDirectory() && entry.name === session.sessionId)
  if (sessionEntry === undefined) throw new Error('Native Session directory was not created')
  const sessionDirectory = join(sessionEntry.parentPath, sessionEntry.name)
  const generations = (await readdir(sessionDirectory)).filter(name => /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(name))
  expect(generations.length).toBeGreaterThan(0)
  const history = new Map(await Promise.all(generations.map(async name => [name, await readFile(join(sessionDirectory, name))] as const)))
  const identity = z.object({ pid: z.number().int().positive() })
  const parent = identity.parse(JSON.parse(await readFile(join(root, 'runtime-process.json'), 'utf8')))
  const projectProcess = identity.parse(JSON.parse(await readFile(join(directory, 'workspace/runtime-process.json'), 'utf8')))
  expect(parent.pid).not.toBe(process.pid)
  expect(projectProcess.pid).not.toBe(parent.pid)
  let projectStopped = false
  onTestFinished(async () => {
    if (projectStopped) return
    try { process.kill(projectProcess.pid, 'SIGTERM') } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
    }
    await vi.waitFor(() => {
      expect(() => process.kill(projectProcess.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }, { timeout: 15000, interval: 100 })
  })
  // The test owns both identities through the fixture and its per-project process record.
  process.kill(parent.pid, 'SIGKILL')
  expect(await first.child.done).toMatchObject({ signal: 'SIGKILL' })
  await vi.waitFor(async () => {
    expect(identity.parse(JSON.parse(await readFile(join(directory, 'workspace/runtime-disposed.json'), 'utf8')))).toEqual(projectProcess)
    expect(() => process.kill(projectProcess.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  }, { timeout: 15000, interval: 100 })
  projectStopped = true
  for (const [name, before] of history) expect(await readFile(join(sessionDirectory, name))).toEqual(before)
  const second = await start()
  // The crashed manager's cognitive writer lease expires independently of Session cleanup.
  await vi.waitFor(async () => {
    const reopened = z.object({ url: z.string() }).parse(await second.host('agentWorkspaces/openWorkspace', { id: project.id }))
    expect(new URL(reopened.url).origin).toBe(new URL(connection.url).origin)
  }, { timeout: 15000, interval: 100 })
  const reopened = z.object({ url: z.string() }).parse(await second.host('agentWorkspaces/openWorkspace', { id: project.id }))
  const resumed = await api(second.url, reopened.url)
  const retained = z.object({ items: z.array(z.object({ sessionId: z.string() })) }).parse(await resumed('session/list', { _request: {} }))
  expect(retained.items.some(item => item.sessionId === session.sessionId)).toBe(true)
  await resumed('session/prompt', { request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue',
    content: [{ type: 'text', text: 'Continue the preserved conversation.' }] } })
  await vi.waitFor(async () => {
    expect(await resumed('agentEvidence/read', { sessionId: session.sessionId })).toMatchObject({ success: true, turn: 2 })
  }, { timeout: 30000, interval: 100 })
  for (const [name, before] of history) expect((await readFile(join(sessionDirectory, name))).subarray(0, before.length)).toEqual(before)
})
