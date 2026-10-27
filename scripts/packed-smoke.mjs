/** Prove the packed plugin runs with a clean, registry-installed official DSH runtime. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { 'release-url': { type: 'string' } } })
const releaseUrl = values['release-url']
if (releaseUrl !== undefined) {
  const url = new URL(releaseUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('.tgz')) {
    throw new Error('Use a public HTTPS .tgz release URL without embedded credentials or query parameters')
  }
}

const checkout = await realpath(fileURLToPath(new URL('..', import.meta.url)))
const manifest = JSON.parse(await readFile(join(checkout, 'package.json'), 'utf8'))
const version = manifest.engines.dsh
await access(join(checkout, 'dist/index.js'))
const root = await realpath(await mkdtemp(join(tmpdir(), 'rsi-packed-smoke-')))
const controller = new AbortController()
const children = new Set()
const projectPids = new Set()
const startedAt = Date.now()
const result = { status: 'failed', runtimeVersion: version, plugin: manifest.name, pluginVersion: manifest.version,
  startedAt: new Date(startedAt).toISOString(), ...(releaseUrl === undefined ? {} : { releaseUrl }), checks: [] }
const stop = signal => controller.abort(new Error(`Packed smoke interrupted by ${signal}`))
const onInterrupt = () => stop('SIGINT')
const onTerminate = () => stop('SIGTERM')
process.on('SIGINT', onInterrupt)
process.on('SIGTERM', onTerminate)

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const redact = text => String(text).replace(/([?&]token=)[^\s"'<>]+/g, '$1[redacted]')
const inside = (parent, child) => {
  const path = relative(parent, child)
  return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
}
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/KEY|TOKEN|SECRET|PASSWORD|AUTH/i.test(key)
  && !/^(?:DSH_|RSI_|CODEX_|OPENAI_|DEEPSEEK_|ANTHROPIC_|GEMINI_|npm_)/i.test(key)
  && key !== 'NODE_OPTIONS'))
const home = join(root, 'home')
const env = { ...clean, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
  NPM_CONFIG_USERCONFIG: join(root, '.npmrc'), NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/' }

function terminate(child, signal = 'SIGTERM') {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) { if (error.code !== 'ESRCH') throw error }
}

function start(command, args, cwd) {
  controller.signal.throwIfAborted()
  const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  const state = { child, stdout: '', stderr: '', done: null, settled: false, error: null }
  const append = (key, text) => { state[key] = (state[key] + text).slice(-2 * 1024 * 1024) }
  child.stdout.setEncoding('utf8').on('data', text => append('stdout', text))
  child.stderr.setEncoding('utf8').on('data', text => append('stderr', text))
  state.done = new Promise(resolve => {
    child.once('error', error => { state.error = error; resolve({ code: null, signal: null }) })
    child.once('close', (code, signal) => resolve({ code, signal }))
  }).finally(() => { state.settled = true; children.delete(state) })
  children.add(state)
  return state
}

async function shutdown(state) {
  if (state.settled) return
  terminate(state.child)
  const force = setTimeout(() => terminate(state.child, 'SIGKILL'), 15000)
  try { await state.done } finally { clearTimeout(force) }
}

async function command(command, args, cwd, timeout = 300000) {
  const state = start(command, args, cwd)
  let timedOut = false
  let force
  const cancel = () => {
    terminate(state.child)
    force ??= setTimeout(() => terminate(state.child, 'SIGKILL'), 3000)
  }
  controller.signal.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => { timedOut = true; cancel() }, timeout)
  try {
    const outcome = await state.done
    if (timedOut || outcome.code !== 0 || outcome.signal !== null) {
      throw new Error(`${command} failed (exit ${outcome.code}, signal ${outcome.signal}, timeout ${timedOut}):\n${redact(state.stderr || state.error?.message || state.stdout).slice(-12000)}`)
    }
    controller.signal.throwIfAborted()
    return state.stdout
  } finally {
    clearTimeout(timer)
    clearTimeout(force)
    controller.signal.removeEventListener('abort', cancel)
  }
}

async function until(probe, timeout = 60000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    controller.signal.throwIfAborted()
    const value = await probe()
    if (value) return value
    await delay(100)
  }
  throw new Error('Packed smoke timed out waiting for an observed state')
}

async function connect(url) {
  const parsed = new URL(url)
  assert.equal(parsed.protocol, 'http:')
  assert.equal(parsed.hostname, '127.0.0.1')
  const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) })
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  assert.equal(login.status, 303)
  assert.ok(cookie)
  const origin = parsed.origin
  const rpc = async (method, args = {}) => {
    const response = await fetch(`${origin}/api/${method}`, { method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]),
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) })
    assert.equal(response.status, 200, `HTTP ${response.status} from ${method}`)
    const body = await response.json()
    if (!body.result?.ok) throw new Error(`${method}: ${body.result?.error?.message ?? 'Invalid RPC response'}`)
    return body.result.value
  }
  const html = await fetch(`${origin}/`, { headers: { cookie }, signal: AbortSignal.timeout(15000) })
  assert.equal(html.status, 200)
  assert.match(await html.text(), /__RSI_PAGE__/)
  return { origin, rpc }
}

async function conversation(client, sessionId) {
  await client.rpc('session/prompt', { request: { requestId: randomUUID(), sessionId, mode: 'queue',
    content: [{ type: 'text', text: 'Inspect this Agent context and its configured context budget.' }] } })
  await until(async () => {
    const list = await client.rpc('session/list', { _request: {} })
    const session = list.items.find(item => item.sessionId === sessionId)
    return session && !session.running && (session.projections?.values?.sessionStats?.turns ?? 0) > 0
  })
  const evidence = await client.rpc('agentEvidence/read', { sessionId })
  assert.equal(evidence.success, true)
  return JSON.parse(JSON.parse(evidence.output).finalResponse)
}

const mockProvider = `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import schema from '@deepseek-ai/schemastery'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
export const inject = ['llm', 'settings']
export const Config = schema.object({ contextWindow: schema.number().min(1).default(272000).volatile() })
class Model extends LlmAdapter {
  constructor(config) { super(); this.config = config }
  async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: this.config.contextWindow.get() } } }
  async listModels(provider) { return [await this.resolveModel(provider, 'mock')] }
  async *stream(options) {
    if (!(options.tools ?? []).some(tool => tool.name === 'agent_context')) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Packed smoke' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const lastUser = options.messages.findLastIndex(message => message.role === 'user')
    const tool = options.messages.slice(lastUser + 1).find(message => message.role === 'tool')
    if (!tool) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name: 'agent_context', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (tool.isError) throw new Error('Agent context inspection failed')
    const context = JSON.parse(tool.content.filter(item => item.type === 'text').map(item => item.text).join(''))
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({ context, contextWindow: this.config.contextWindow.get() }) } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
export function apply(ctx, config) {
  writeFileSync(join(process.cwd(), 'smoke-process.json'), JSON.stringify({ pid: process.pid }))
  ctx.effect(() => ctx.llm.registerAdapter(['rsi-packed-test'], new Model(config)))
  ctx.effect(() => ctx.settings.configure({ auto: false }))
}
`

try {
  await writeFile(env.NPM_CONFIG_USERCONFIG, 'registry=https://registry.npmjs.org/\n', { mode: 0o600 })
  const packed = join(root, 'packed')
  const installation = join(root, 'installation')
  await mkdir(packed)
  await mkdir(installation)
  console.log('[packed-smoke] Packing the built RSI plugin')
  const receipt = JSON.parse(await command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packed], checkout))[0]
  assert.equal(receipt.name, manifest.name)
  assert.ok(receipt.files.some(file => file.path === 'dist/index.js'))
  assert.ok(receipt.files.some(file => file.path === 'dist/client.js'))
  assert.ok(!receipt.files.some(file => /^(?:src|node_modules|vendor)\//.test(file.path)))
  result.checks.push('tarball-has-built-artifacts')
  const tarball = join(packed, receipt.filename)
  await writeFile(join(installation, 'package.json'), JSON.stringify({ name: 'rsi-clean-install', private: true, type: 'module' }))
  console.log(`[packed-smoke] Installing official DSH ${version} from the public registry`)
  await command('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', `@deepseek-ai/dsh@${version}`], installation)
  const runtimeDirectory = await realpath(join(installation, 'node_modules/@deepseek-ai/dsh'))
  assert.ok(inside(installation, runtimeDirectory))
  const runtimeManifest = JSON.parse(await readFile(join(runtimeDirectory, 'package.json'), 'utf8'))
  assert.equal(runtimeManifest.version, version)
  result.checks.push('official-runtime-registry-install')
  const binary = resolve(runtimeDirectory, runtimeManifest.bin.dsh)
  console.log('[packed-smoke] Installing the tarball through the official plugin command')
  await command(process.execPath, [binary, '--profile', 'rsi', '--from-default-profile', 'web', '--dump-config'], root)
  const profile = join(home, 'profiles/rsi')
  await writeFile(join(profile, '.npmrc'), 'registry=https://registry.npmjs.org/\n@deepseek-ai:registry=https://registry.npmjs.org/\n')
  await command(process.execPath, [binary, 'plugin', '--profile', 'rsi', 'add', releaseUrl ?? tarball, '--ignore-scripts'], root)
  const installedPlugin = await realpath(join(profile, 'node_modules', manifest.name))
  assert.ok(inside(root, installedPlugin) && !inside(checkout, installedPlugin))
  assert.equal(JSON.parse(await readFile(join(installedPlugin, 'package.json'), 'utf8')).version, manifest.version)
  result.checks.push('official-plugin-command-install')
  new Script(await readFile(join(installedPlugin, 'dist/client.js'), 'utf8'), { filename: `${manifest.name}/dist/client.js` })
  result.checks.push('client-factory-syntax')

  const provider = join(root, 'mock-provider')
  await mkdir(provider)
  await writeFile(join(provider, 'package.json'), JSON.stringify({ name: 'rsi-packed-test-provider', version: '1.0.0', private: true,
    type: 'module', exports: { '.': './index.js', './package.json': './package.json' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    peerDependencies: { '@deepseek-ai/dsh-llm': version, '@deepseek-ai/schemastery': runtimeManifest.dependencies['@deepseek-ai/schemastery'] ?? '~3.18.5' } }))
  await writeFile(join(provider, 'index.js'), mockProvider)
  await writeFile(join(provider, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'rsi-packed-model', name: 'rsi-packed-test-provider' }] }]))
  await command(process.execPath, [binary, 'plugin', '--profile', 'rsi', 'add', provider, '--ignore-scripts'], root)
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([
    { id: 'agent-default-model', config: { provider: 'rsi-packed-test', model: 'mock' } },
    { id: 'rsi-app', config: { role: 'manager', projects: { modelProviders: [
      { provider: 'rsi-packed-test', settingsNamespace: 'rsi-packed-model', bundle: 'rsi-packed-test-provider' },
    ] } } },
    { id: 'session-title-llm', disabled: true },
  ], null, 2) + '\n')

  console.log('[packed-smoke] Booting and exercising isolated project Agents')
  const server = start(process.execPath, [binary, '--profile', 'rsi', '--no-open', '--port', '0'], root)
  const loginUrl = await until(() => {
    if (server.settled) throw new Error(`Official DSH exited during startup:\n${redact(server.stderr || server.error?.message).slice(-12000)}`)
    return server.stdout.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+)/)?.[1]
  })
  const manager = await connect(loginUrl)
  const projects = []
  for (const name of ['a', 'b']) {
    const project = await manager.rpc('agentWorkspaces/createWorkspace', { request: { name, path: join(root, `project-${name}`) } })
    const connection = await manager.rpc('agentWorkspaces/openWorkspace', { id: project.id })
    const client = await connect(connection.url)
    assert.notEqual(client.origin, manager.origin)
    assert.ok((await client.rpc('settings/describe')).writable)
    const record = JSON.parse(await readFile(join(project.path, 'workspace/smoke-process.json'), 'utf8'))
    projectPids.add(record.pid)
    const source = JSON.parse(await readFile(join(project.path, 'profile/package.json'), 'utf8'))
    const self = source.dependencies[manifest.name]
    assert.ok(self.startsWith('file:'))
    assert.ok(inside(root, await realpath(resolve(join(project.path, 'profile'), self.slice(5)))))
    projects.push({ project, client, connection, pid: record.pid })
  }
  assert.notEqual(projects[0].client.origin, projects[1].client.origin)
  result.checks.push('two-isolated-origins', 'settings-writable', 'runtime-paths-isolated')
  const first = projects[0]
  const session = await first.client.rpc('session/create', { request: {} })
  const initial = await conversation(first.client, session.sessionId)
  assert.equal(initial.context.agentId, first.project.id)
  assert.equal(initial.contextWindow, 272000)
  assert.equal(initial.context.workspace, join(first.project.path, 'workspace'))
  result.checks.push('native-agent-context')
  await first.client.rpc('settings/update', { ns: 'rsi-packed-model', patch: { contextWindow: 872000 } })
  const nextSession = await first.client.rpc('session/create', { request: {} })
  assert.equal((await conversation(first.client, nextSession.sessionId)).contextWindow, 872000)
  const secondSettings = await projects[1].client.rpc('settings/describe')
  assert.equal(secondSettings.namespaces.find(row => row.ns === 'rsi-packed-model').value.contextWindow, 272000)
  result.checks.push('live-context-update', 'other-project-unmodified')
  await manager.rpc('agentWorkspaces/stopWorkspace', { id: first.project.id })
  projectPids.delete(first.pid)
  const reopened = await manager.rpc('agentWorkspaces/openWorkspace', { id: first.project.id })
  const resumed = await connect(reopened.url)
  assert.equal(resumed.origin, first.client.origin)
  projectPids.add(JSON.parse(await readFile(join(first.project.path, 'workspace/smoke-process.json'), 'utf8')).pid)
  const settings = await resumed.rpc('settings/describe')
  assert.equal(settings.writable, true)
  assert.equal(settings.namespaces.find(row => row.ns === 'rsi-packed-model').value.contextWindow, 872000)
  assert.ok((await resumed.rpc('session/list', { _request: {} })).items.some(item => item.sessionId === session.sessionId))
  const retained = await resumed.rpc('agentEvidence/read', { sessionId: nextSession.sessionId })
  assert.equal(retained.success, true)
  result.checks.push('stable-origin-after-restart', 'settings-survive-restart', 'history-survives-restart')
  await shutdown(server)
  result.status = 'passed'
} catch (error) {
  result.error = redact(error.message ?? error).split('\n')[0].replaceAll(root, '<temporary>')
  console.error(`Packed smoke failed: ${redact(error.stack ?? error.message ?? error)}`)
  process.exitCode = 1
} finally {
  try {
    await Promise.allSettled([...children].map(shutdown))
    for (const pid of projectPids) {
      try { process.kill(pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    for (const pid of projectPids) {
      const end = Date.now() + 15000
      for (;;) {
        try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') break; throw error }
        if (Date.now() >= end) throw new Error(`Owned project process ${pid} did not exit`)
        await delay(100)
      }
    }
    await rm(root, { recursive: true, force: true })
    result.cleanup = 'completed'
  } catch (error) {
    result.status = 'failed'
    result.cleanup = 'failed'
    result.error = redact(error.message ?? error).split('\n')[0].replaceAll(root, '<temporary>')
    console.error(`Packed smoke cleanup failed: ${result.error}`)
    process.exitCode = 1
  } finally {
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
    result.durationMs = Date.now() - startedAt
    await mkdir(join(checkout, '.artifacts'), { recursive: true })
    await writeFile(join(checkout, `.artifacts/${releaseUrl === undefined ? 'packed-smoke-result' : 'github-release-smoke-result'}.json`),
      JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  }
}
if (result.status === 'passed') console.log(`Packed smoke passed: official DSH ${version}; 2 isolated Agents; settings writable; 872K retained after restart; no runtime checkout dependencies.`)
