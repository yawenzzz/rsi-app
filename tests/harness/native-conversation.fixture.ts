/** Real project-process fixture with a local model provider and owned temporary state. */
import { mkdtemp, mkdir, readFile, rm, copyFile, symlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { expect, onTestFinished, onTestFailed, vi } from 'vitest'
import { z } from 'zod'

/** Standalone plugin checkout; DSH itself comes only from the installed npm package. */
export const repository = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(import.meta.url)
const dshManifestPath = require.resolve('@deepseek-ai/dsh/package.json')
const dshManifest = z.object({ version: z.string(), bin: z.object({ dsh: z.string() }) })
  .parse(JSON.parse(readFileSync(dshManifestPath, 'utf8')))
const dshBinary = resolve(dirname(dshManifestPath), dshManifest.bin.dsh)
/** Exact official runtime version accepted by the fixture capability plugins. */
export const dshVersion = dshManifest.version

/**
 * Authenticate against the fixture application and address one project route.
 * @param url - Application launch URL.
 * @param mount - Authenticated project URL, or the application URL when omitted.
 * @returns an authenticated JSON-RPC caller.
 */
export async function nativeConversationApi(url: string, mount = '/') {
  const login = mount === '/' ? new URL(url) : new URL(mount, url)
  const response = await fetch(login, { redirect: 'manual' })
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const base = new URL('/', login)
  expect(cookie).not.toBe('')
  expect(base.search).toBe('')
  return async (endpoint: string, args: object): Promise<unknown> => {
    const response = await fetch(new URL(`api/${endpoint}`, base), { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }) })
    const body = z.object({ result: z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value: z.unknown().optional() }),
      z.object({ ok: z.literal(false), error: z.object({ message: z.string() }) })]) }).parse(await response.json())
    if (!body.result.ok) throw new Error(body.result.error.message)
    return body.result.value
  }
}

/**
 * Prepare an isolated RSI application using the shipped profile and local model fixture.
 * @returns owned paths and a launcher; test teardown joins every spawned process.
 */
export async function nativeConversationFixture() {
  const root = await mkdtemp(join(tmpdir(), 'project-native-chat-'))
  const ctx = new Context()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  await ctx.plugin(SubprocessLocal)
  const home = join(root, 'home')
  const profile = join(home, 'profiles', 'rsi')
  const provider = join(root, 'provider')
  await mkdir(join(profile, 'node_modules', '@local'), { recursive: true })
  await mkdir(provider)
  await mkdir(join(provider, 'node_modules', '@deepseek-ai'), { recursive: true })
  for (const dependency of ['@deepseek-ai/dsh-llm', '@deepseek-ai/schemastery']) {
    await symlink(dirname(require.resolve(`${dependency}/package.json`)), join(provider, 'node_modules', dependency),
      process.platform === 'win32' ? 'junction' : 'dir')
  }
  await copyFile(fileURLToPath(new URL('./fixtures/native-conversation/provider.mjs', import.meta.url)), join(provider, 'index.js'))
  await writeFile(join(provider, 'package.json'), JSON.stringify({ name: '@local/project-test-provider', version: '1.0.0', type: 'module',
    exports: { '.': './index.js', './package.json': './package.json' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(join(provider, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'project-test-provider', name: '@local/project-test-provider' }] }]))
  await symlink(provider, join(profile, 'node_modules', '@local', 'project-test-provider'), process.platform === 'win32' ? 'junction' : 'dir')
  await mkdir(join(profile, 'node_modules', '@yawenzzz'), { recursive: true })
  await symlink(repository, join(profile, 'node_modules', '@yawenzzz/dsh-rsi'), process.platform === 'win32' ? 'junction' : 'dir')
  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@yawenzzz/dsh-rsi', '@local/project-test-provider']
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'test-profile', private: true,
    dependencies: { '@local/project-test-provider': `file:${provider}`, '@yawenzzz/dsh-rsi': `file:${repository}` }, dsh: { profile: { bundles } } }))
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([
    { id: 'agent-default-model', config: { provider: 'project-test', model: 'project-model' } },
    { id: 'rsi-app', config: { role: 'manager', projects: { leaseStaleMs: 5000, leaseUpdateMs: 1000,
      modelProviders: [{ provider: 'project-test', settingsNamespace: 'project-test-provider', bundle: '@local/project-test-provider' }] } } },
    { id: 'session-title-llm', disabled: true },
  ]))
  const start = async () => {
    const child = ctx.subprocess.spawn({ argv: [process.execPath, dshBinary, '--profile', 'rsi', '--no-open', '--port', '0'],
      cwd: root, env: { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
      stdio: { stdin: 'ignore', stdout: { maxBytes: 262144 }, stderr: { maxBytes: 262144 } }, graceMs: 3000 })
    onTestFinished(async () => { child.terminate(); await child.waitForExit() })
    onTestFailed(async () => {
      console.error(child.collected.stderr?.readFrom(0).text)
      for (const project of ['project-a', 'project-b']) {
        try { console.error(await readFile(join(root, project, '.rsi/logs/startup-error.log'), 'utf8')) } catch (_error) { /* No startup failure was retained. */ }
      }
    })
    let url = ''
    await vi.waitFor(() => {
      url = child.collected.stdout?.readFrom(0).text.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+)/)?.[1] ?? ''
      expect(url, child.collected.stderr?.readFrom(0).text).not.toBe('')
    }, { timeout: 60000, interval: 100 })
    const host = await nativeConversationApi(url)
    return { child, url, host }
  }
  return { root, profile, start }
}
