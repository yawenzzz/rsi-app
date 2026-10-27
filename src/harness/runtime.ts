/** Reusable project Web runtimes launched through the application's installed dsh CLI. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-app-boot'
import { z } from 'zod'
import type { AgentWorkspace, AgentRuntimeConnection } from './types.ts'
import type { RuntimeProfile } from './runtime-profile.ts'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Process bounds supplied by the application, never by a model tool. */
export interface RuntimePolicy {
  /** Startup deadline in milliseconds. */
  startupTimeoutMs: number
  /** Readiness observation interval in milliseconds. */
  startupPollIntervalMs: number
  /** Grace period before forced process termination, in milliseconds. */
  terminationGraceMs: number
  /** Maximum retained startup bytes per output stream. */
  maxOutputBytes: number
}

/** One process owns native conversations, tools, persistence and its authenticated transport. */
export interface AgentRuntime {
  connection: Omit<AgentRuntimeConnection, 'url'>
  /** Browser entry for this project's stable independent origin. */
  url: string
  /**
   * Forward an operator request only to this Agent's origin.
   * @param endpoint - Native API endpoint.
   * @param args - Named arguments.
   * @returns API value.
   */
  rpc(endpoint: string, args: object): Promise<unknown>
  /**
   * @returns after the managed process range has stopped.
   */
  close(): Promise<void>
  /**
   * @returns whether the managed process is still running.
   */
  alive(): boolean
}

/**
 * Start the installed runtime and verify selected plugin entries before exposing its native conversation UI.
 * @param ctx - Application subprocess and launcher services.
 * @param workspace - Stable project identity and root directory.
 * @param cwd - Prepared task directory used by new conversations and tools.
 * @param profile - Prepared local capability composition.
 * @param env - Scoped control channel and explicit credential references.
 * @param policy - Startup and cleanup limits.
 * @param lifetime - Parent service lifetime.
 * @returns an authenticated Agent runtime with quiescent disposal.
 */
export async function startAgentRuntime(ctx: Context, workspace: AgentWorkspace, cwd: string, profile: RuntimeProfile,
  env: Record<string, string>, policy: RuntimePolicy, lifetime: AbortSignal): Promise<AgentRuntime> {
  const anchor = ctx.profileContext.installAnchor
  const manifest = z.object({ bin: z.object({ dsh: z.string() }) }).parse(JSON.parse(await readFile(anchor, 'utf8')))
  const binary = resolve(dirname(anchor), manifest.bin.dsh)
  await readFile(binary)
  const addressPath = join(workspace.path, '.rsi', 'native-web.json')
  let port = 0
  try {
    port = z.object({ format: z.literal(1), port: z.int().min(1).max(65535) })
      .parse(JSON.parse(await readFile(addressPath, 'utf8'))).port
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const cancellation = new AbortController()
  const signal = AbortSignal.any([lifetime, cancellation.signal])
  let child: SubprocessHandle | undefined
  const state = { running: true }
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => {
    cancellation.abort(new Error('Agent runtime stopped'))
    child?.terminate()
    await child?.waitForExit()
  })()
  try {
    child = ctx.subprocess.spawn({ argv: [process.execPath, binary, '--profile', profile.name, '--patch', profile.patch, '--no-open', '--port', String(port)],
      cwd, env: { ...env, DSH_HOME: profile.home, DSH_AGENT_COMPOSITION_HASH: profile.hash,
        DSH_AGENT_PARENT_STDIN: 'pipe', DSH_TELEMETRY_DISABLED: process.env['DSH_TELEMETRY_DISABLED'] },
      stdio: { stdin: 'pipe', stdout: { maxBytes: policy.maxOutputBytes }, stderr: { maxBytes: policy.maxOutputBytes } },
      graceMs: policy.terminationGraceMs, signal })
    void child.done.then(() => { state.running = false }, () => { state.running = false })
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(policy.startupTimeoutMs)])
    let url: string | undefined
    while (url === undefined) {
      deadline.throwIfAborted()
      if (!state.running) throw new Error(`Agent runtime exited during startup: ${child.collected.stderr?.readFrom(0).text ?? ''}`)
      url = child.collected.stdout?.readFrom(0).text.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+)/)?.[1]
      if (url === undefined) await delay(policy.startupPollIntervalMs, undefined, { signal: deadline })
    }
    const origin = new URL(url).origin
    const exchange = await fetch(url, { redirect: 'manual', signal: deadline })
    const cookie = exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    if (!cookie) throw new Error('Agent runtime did not establish an authenticated connection')
    const rpc = async (endpoint: string, args: object): Promise<unknown> => {
      const response = await fetch(`${origin}/api/${endpoint}`, { method: 'POST', signal,
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }) })
      if (!response.ok) throw new Error(`Agent API ${endpoint} failed with HTTP ${response.status}`)
      const body = z.object({ result: z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value: z.unknown().optional() }),
        z.object({ ok: z.literal(false), error: z.object({ message: z.string() }) })]) }).parse(await response.json())
      if (!body.result.ok) throw new Error(body.result.error.message)
      return body.result.value
    }
    const bundles = z.array(z.object({
      name: z.string(), enabled: z.boolean(), version: z.string().optional(), error: z.unknown().optional(),
      rows: z.array(z.object({ rowId: z.string(), entryId: z.string().optional() })),
      overrides: z.array(z.string()) }))
      .parse(await rpc('pluginManager/listBundles', {}))
    const plugins = z.array(z.object({ entryId: z.string(), fiberPhase: z.string().nullable(), enabled: z.boolean() }))
      .parse(await rpc('pluginManager/listPlugins', {}))
    for (const artifact of profile.bundles) {
      const bundle = bundles.find(item => item.name === artifact.name)
      if (bundle === undefined || !bundle.enabled || bundle.error !== undefined || bundle.version !== artifact.version
        || bundle.rows.length === 0 && bundle.overrides.length === 0) throw new Error(`Agent bundle did not load: ${artifact.name}`)
      for (const row of bundle.rows) {
        if (!plugins.some(item => item.entryId === row.entryId && item.fiberPhase === 'active' && item.enabled)) {
          throw new Error(`Agent bundle entry did not activate: ${row.rowId} (${JSON.stringify(plugins.find(item => item.entryId === row.entryId))})`)
        }
      }
    }
    if (port === 0) await writeFileAtomic(addressPath, JSON.stringify({ format: 1, port: Number(new URL(url).port) }) + '\n', { mode: 0o600 })
    return { connection: { workspaceId: workspace.id, profile: profile.name, compositionHash: profile.hash },
      url, rpc, close,
      alive: () => state.running }
  } catch (error) {
    const directory = join(workspace.path, '.rsi', 'logs')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const diagnostic = join(directory, 'startup-error.log')
    await writeFile(diagnostic, child?.collected.stderr?.readFrom(0).text ?? '', { mode: 0o600 })
    await close()
    throw new Error(`${error instanceof Error ? error.message : String(error)}; inspect ${diagnostic}`, { cause: error })
  }
}
