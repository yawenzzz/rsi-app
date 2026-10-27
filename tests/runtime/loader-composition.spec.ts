/** Real Loader tools, loop transcripts, HTTP observations, and cold paper-state recovery. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebRuntime from '@deepseek-ai/dsh-web'
import RsiService from '../../src/runtime/index.ts'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import type { ResearchRun } from '../../src/runtime/runtime-state.ts'
import type { DecisionId } from '../../src/runtime/queries/types.ts'
import { createProvider } from './fixtures/loader/llm.ts'
import * as EvidenceProvider from './fixtures/loader/web.ts'
import { startPublicApi, type PublicApiFixture } from './fixtures/loader/public-api.ts'

interface ScriptedCall {
  name: string
  arguments: Record<string, unknown> | (() => Record<string, unknown>)
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly calls: readonly ScriptedCall[]) { super() }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const call = this.calls[this.requests.length]
    this.requests.push(options)
    if (call !== undefined) {
      const id = ToolCallId(`fixture-call-${this.requests.length}`)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      const args = typeof call.arguments === 'function' ? call.arguments() : call.arguments
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: JSON.stringify(args) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Research state checked.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const contexts: Context[] = []
const roots: string[] = []
const publicApis: PublicApiFixture[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const api of publicApis.splice(0)) await api.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

async function fixture(researchEnabled = false, releases = false): Promise<{ root: string; api: PublicApiFixture; configPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-loader-'))
  roots.push(root)
  const api = await startPublicApi()
  publicApis.push(api)
  const configPath = join(root, 'cordis.yml')
  const base = await readFile(new URL('./fixtures/loader/cordis.yml', import.meta.url), 'utf8')
  await writeFile(configPath, `${base}${[
    "- name: '@deepseek-ai/dsh-credentials-local'",
    `  config: ${JSON.stringify({ path: join(root, 'credentials.yaml'), watch: false })}`,
    "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    `  config: ${JSON.stringify({ root: join(root, 'sessions'), compression: 'none' })}`,
    "- name: '@deepseek-ai/dsh-storage-json'",
    `  config: ${JSON.stringify({ root: join(root, 'state') })}`,
    '- id: rsi',
    "  name: '@yawenzzz/dsh-rsi/paper'",
    `  config: ${JSON.stringify({
      objective: 'Validate prospective market research with paper capital.',
      writerLeasePath: join(root, 'writer'),
      autoTick: false,
      data: { gammaUrl: api.url, clobUrl: api.url },
      jev: { baseUrl: api.url, apiKeyEnv: 'RSI_JEV_LOADER_KEY' },
      ledger: {
        initialCapitalMicros: 100_000_000,
        perEventLimitMicros: 1_000_000,
        totalExposureLimitMicros: 5_000_000,
        maxDrawdownMicros: 2_000_000,
      },
      research: { enabled: researchEnabled, cwd: root },
      ...releases ? { releases: {
        repositoryPath: join(root, 'repository'), worktreeRoot: join(root, 'worktrees'),
        checks: [{ name: 'candidate-file', command: process.execPath,
          args: ['--input-type=module', '-e', 'import {readFileSync} from "node:fs"; if(readFileSync("candidate.txt","utf8")!=="candidate\\n")process.exit(1)'] }],
      } } : {},
    })}`,
    '',
  ].join('\n')}`)
  return { root, api, configPath }
}

async function load(configPath: string, calls: readonly ScriptedCall[]): Promise<{ ctx: Context; adapter: ScriptedAdapter }> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = new URL('./', pathToFileURL(configPath)).href
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const adapter = new ScriptedAdapter(calls)
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-credentials-local', CredentialsLocal],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-web', WebRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-default-model', AgentDefaultModel],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-subprocess-local', SubprocessLocal],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@yawenzzz/dsh-rsi/paper', RsiService],
    ['./llm.ts', createProvider(adapter)],
    ['./web.ts', EvidenceProvider],
  ])
  const unsupported = (): never => { throw new Error('Fixture only provides module imports') }
  ctx.loader.internal = {
    version: 'v2',
    loadCache: Object.assign(new Map<string, never>(), { get: unsupported, set: unsupported, has: unsupported }),
    register: unsupported, getOrCreateModuleJob: unsupported, resolveSync: unsupported, load: unsupported,
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()]
    .filter(entry => !entry.disabled && entry.fiber === undefined)
    .map(entry => entry.options.name)).toEqual([])
  return { ctx, adapter }
}

function results(session: Session): Array<{ isError: boolean; value: unknown }> {
  return session.snapshotEvents().flatMap((event) => {
    if (event.type !== 'tool/result') return []
    const message = event.data.message
    const text = message.content.filter(item => item.type === 'text').map(item => item.text).join('')
    const value: unknown = message.isError ? text : JSON.parse(text)
    return [{ isError: message.isError === true, value }]
  })
}

async function run(ctx: Context, id: string): Promise<Session> {
  const agent = await ctx.agentLoop.create(SessionId(id), { provider: 'fixture', model: 'fixture' })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect the market and keep research paused.' }] }))
  await agent.whenIdle()
  expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
  return agent.session
}

describe('RSI through the real Loader and agent loop', () => {
  it('records tool output and reopens market observations, candidates, and paused controls', async () => {
    const { configPath, api } = await fixture()
    const calls: ScriptedCall[] = [
      { name: 'rsi_status', arguments: {} },
      { name: 'rsi_tick', arguments: {} },
      { name: 'rsi_candidate', arguments: { spec_json: JSON.stringify({ name: 'prospective candidate', thesis: 'Validate independent future evidence.', minEdge: 0.05, kellyFraction: 0.1 }) } },
      { name: 'rsi_request_resource', arguments: { kind: 'data', reason: 'Official station forecast access.', estimated_monthly_cost: 12 } },
      { name: 'rsi_control', arguments: { expected_revision: 0, action: 'resume', reason: 'Observe candidate eligibility.' } },
      { name: 'rsi_control', arguments: { expected_revision: 1, action: 'pause', reason: 'Remain paused after restart.' } },
      { name: 'rsi_status', arguments: {} },
    ]
    const first = await load(configPath, calls)
    expect(api.requests).toEqual([])
    const session = await run(first.ctx, 'rsi-loader-first')
    const output = results(session)
    expect(output).toHaveLength(calls.length)
    expect(output.every(item => !item.isError)).toBe(true)
    expect(output[0]?.value).toMatchObject({ mode: 'paper', status: 'paused', controlRevision: 0 })
    expect(output.at(-1)?.value).toMatchObject({ mode: 'paper', status: 'paused', controlRevision: 2 })
    expect(first.adapter.requests).toHaveLength(calls.length + 1)
    expect(api.requests.filter(request => request.path === '/book')).toHaveLength(2)
    expect(api.requests.every(request => request.method === 'GET')).toBe(true)
    const finalState = output.at(-1)?.value
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await load(configPath, [{ name: 'rsi_status', arguments: {} }])
    const restored = results(await run(second.ctx, 'rsi-loader-reopened'))
    expect(restored).toEqual([{ isError: false, value: finalState }])
  })

  it('removes tool registrations when the loaded plugin is disposed', async () => {
    const { configPath } = await fixture()
    const { ctx } = await load(configPath, [])
    expect(ctx.tools.schemas().some(tool => tool.name === 'rsi_status')).toBe(true)
    const entry = [...ctx.loader.entries()].find(item => item.options.id === 'rsi')
    expect(entry?.fiber).toBeDefined()
    await entry!.fiber!.dispose()
    expect(ctx.tools.schemas().filter(tool => tool.name.startsWith('rsi_'))).toEqual([])
  })

  it('presents every research operation as a pure generic tool card', async () => {
    const { configPath } = await fixture()
    const { ctx } = await load(configPath, [])
    const presentations = [
      ['rsi_inspect', 'Inspect RSI evidence', 'read', { kind: 'opportunity', id: 'observation' }],
      ['rsi_inspect', 'Inspect RSI evidence', 'read', { kind: 'evidence', id: 'snapshot' }],
      ['rsi_objective', 'Update RSI objective', 'other', { expected_revision: 0, objective: 'Inspect evidence' }],
      ['rsi_research_control', 'Control RSI research', 'other', { paused: true }],
      ['rsi_status', 'Read RSI research status', 'read', {}],
      ['rsi_tick', 'Refresh Polymarket observations', 'other', {}],
      ['rsi_control', 'Change paper trading state', 'other', { expected_revision: 0, action: 'pause', reason: 'Pause' }],
      ['rsi_observation', 'Read retained market evidence', 'read', { observation_id: 'observation' }],
      ['rsi_capture_evidence', 'Capture research source', 'other', { observation_id: 'observation', url: 'https://source.example.test/' }],
      ['rsi_candidate', 'Register research candidate', 'other', { spec_json: '{}' }],
      ['rsi_forecast', 'Record prospective forecast', 'other', { observation_id: 'observation', forecast_json: '{}' }],
      ['rsi_request_resource', 'Record resource request', 'other', { kind: 'data', reason: 'Forecasts', estimated_monthly_cost: 0 }],
      ['rsi_validate_release', 'Validate Harness candidate', 'other', { commit: 'a'.repeat(40) }],
    ] as const
    for (const [name, title, kind, args] of presentations) {
      expect(ctx.tools.get(name)?.presentCall?.(args)).toEqual({ card: 'generic', title, kind })
    }
    expect(ctx.rsi.runtime.status().controlRevision).toBe(0)
  })

  it('records model forecasts against retained observations and reports unavailable release validation', async () => {
    const { configPath } = await fixture()
    const calls: ScriptedCall[] = []
    const { ctx } = await load(configPath, calls)
    const runtime = ctx.rsi.runtime
    await runtime.tick()
    const observationId = runtime.status().observations[0]!.id
    const candidate = await runtime.registerCandidate({ name: 'prospective', thesis: 'Future evidence.', minEdge: 0.05, kellyFraction: 0.1 })
    calls.push(
      { name: 'rsi_observation', arguments: { observation_id: observationId } },
      { name: 'rsi_forecast', arguments: { observation_id: observationId, forecast_json: JSON.stringify({
        candidateId: candidate.id, probability: 0.8, uncertainty: 0.05,
        evidence: [{ url: 'https://fixture.invalid/evidence', text: 'Prospective external evidence.' }],
      }) } },
      { name: 'rsi_validate_release', arguments: { commit: 'a'.repeat(40) } },
    )
    const output = results(await run(ctx, 'rsi-forecast-tool'))
    expect(output[0]).toMatchObject({ isError: false, value: { id: observationId } })
    expect(output[1]).toMatchObject({ isError: false, value: { candidateId: candidate.id, observation: { observationId } } })
    expect(output[2]?.isError).toBe(true)
    expect(output[2]?.value).toEqual(expect.stringContaining('Harness release validation is not configured'))
    expect(runtime.experiments.view().forecasts).toHaveLength(1)
    expect(runtime.status().account.purchases).toBe(0)
  })

  it('captures sources through Web, retains below-edge forecasts, and reopens immutable revisions', async () => {
    const { configPath, api } = await fixture()
    const calls: ScriptedCall[] = []
    const { ctx, adapter } = await load(configPath, calls)
    const runtime = ctx.rsi.runtime
    await runtime.tick()
    const observationId = runtime.status().observations[0]!.id
    const candidate = await runtime.registerCandidate({
      name: 'Economic release', thesis: 'Compare official initial and revised estimates.', minEdge: 0.05, kellyFraction: 0.1,
    })
    const url = `${api.url}/evidence`
    const estimate = (probability: number, patch: Record<string, unknown> = {}) => () => {
      const snapshot = runtime.evidence.list(1)[0]!
      return { observation_id: observationId, forecast_json: JSON.stringify({
        candidateId: candidate.id, probability, uncertainty: 0.05,
        evidence: [{ snapshotId: snapshot.id, url: snapshot.url, text: snapshot.text, ...patch }],
      }) }
    }
    calls.push(
      { name: 'rsi_capture_evidence', arguments: { observation_id: observationId, url } },
      { name: 'rsi_inspect', arguments: () => ({ kind: 'evidence', id: runtime.evidence.list(1)[0]!.id }) },
      { name: 'rsi_forecast', arguments: estimate(0.2) },
      { name: 'rsi_capture_evidence', arguments: () => {
        api.evidenceText = 'Revised official estimate: 2.1%.'
        return { observation_id: observationId, url }
      } },
      { name: 'rsi_forecast', arguments: estimate(0.8) },
      { name: 'rsi_forecast', arguments: estimate(0.9, { text: 'Text absent from the retained source' }) },
      { name: 'rsi_forecast', arguments: estimate(0.9, { snapshotId: 'f'.repeat(64) }) },
      { name: 'rsi_inspect', arguments: { kind: 'evidence' } },
      { name: 'rsi_inspect', arguments: { kind: 'evidence', id: 'f'.repeat(64) } },
      { name: 'rsi_inspect', arguments: { kind: 'opportunity' } },
    )
    const output = results(await run(ctx, 'rsi-source-revisions'))
    expect(output.map(result => result.isError)).toEqual([false, false, false, false, false, true, true, false, true, true])
    const snapshots = runtime.evidence.list(10)
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0]).toMatchObject({ url, text: 'Initial official estimate: 2.4%.', provenance: 'fetched', reportedPublishedAt: null })
    expect(snapshots[1]).toMatchObject({ url, text: api.evidenceText, provenance: 'fetched' })
    expect(output[0]?.value).toMatchObject({ snapshotId: snapshots[0]!.id, provenance: 'fetched' })
    expect(output[1]?.value).toEqual(snapshots[0])
    expect(output[2]?.value).toMatchObject({ probability: 0.2, evidence: [{ snapshotId: snapshots[0]!.id }] })
    expect(output[4]?.value).toMatchObject({ probability: 0.8, revision: 1, evidence: [{ snapshotId: snapshots[1]!.id }] })
    expect(output[5]?.value).toEqual(expect.stringContaining('does not match'))
    expect(output[6]?.value).toEqual(expect.stringContaining('Unknown source evidence'))
    expect(output[7]?.value).toEqual(snapshots.map(({ text, ...receipt }) => ({ ...receipt, bytes: Buffer.byteLength(text) })))
    expect(output[8]?.value).toEqual(expect.stringContaining('Unknown source evidence'))
    expect(output[9]?.value).toEqual(expect.stringContaining('expected string'))
    const research = runtime.experiments.view()
    expect(research.forecasts).toHaveLength(1)
    expect(research.forecasts[0]).toMatchObject({ probability: 0.2 })
    expect(research.forecastRevisions).toHaveLength(1)
    expect(runtime.experiments.rank()[0]).toMatchObject({ forecastEvents: 0, evaluatedEvents: 0, status: 'collecting' })
    expect(runtime.status().account.purchases).toBe(0)
    expect(api.requests.filter(request => request.path === '/evidence')).toHaveLength(2)
    expect(adapter.requests).toHaveLength(calls.length + 1)
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)

    const reopened = await load(configPath, snapshots.map(snapshot => ({ name: 'rsi_inspect', arguments: { kind: 'evidence', id: snapshot.id } })))
    expect(results(await run(reopened.ctx, 'rsi-evidence-reopened'))).toEqual(snapshots.map(value => ({ isError: false, value })))
    expect(reopened.ctx.rsi.runtime.experiments.view()).toEqual(research)
    expect(api.requests.filter(request => request.path === '/evidence')).toHaveLength(2)
  })

  it.each(['', 'configured-legacy-key'])('does not expose or invoke Jev in an agent run (key=%s)', async (key) => {
    vi.stubEnv('RSI_JEV_LOADER_KEY', key)
    const { configPath, api } = await fixture()
    const { ctx, adapter } = await load(configPath, [{ name: 'rsi_status', arguments: {} }])
    expect(ctx.tools.get('rsi_judge')).toBeUndefined()
    const session = await run(ctx, 'rsi-without-jev')
    expect(results(session)[0]?.isError).toBe(false)
    expect(JSON.stringify(adapter.requests)).not.toContain('rsi_judge')
    expect(api.jevRequests).toEqual([])
    expect(() => ctx.rsi.runtime.judge({ state: null, questions: { check: { type: 'noul', instructions: 'Check' } } }))
      .toThrow('not configured')
    expect(api.jevRequests).toEqual([])
  })

  it('inspects exact console references through native logged tool calls', async () => {
    const { configPath } = await fixture()
    const calls: ScriptedCall[] = []
    const { ctx, adapter } = await load(configPath, calls)
    const runtime = ctx.rsi.runtime
    await runtime.tick()
    const observationId = runtime.status().observations[0]!.id
    const candidate = await runtime.registerCandidate({ name: 'Inspection fixture', thesis: 'Retained evidence.', minEdge: 0.05, kellyFraction: 0.1 })
    const observation = runtime.observation(observationId)
    await runtime.forecast(observationId, { candidateId: candidate.id, probability: 0.8, uncertainty: 0.05, evidence: [] })
    const decisionId = `forecast:${candidate.id}:${observation.market.eventId}`
    calls.push(
      { name: 'rsi_inspect', arguments: { kind: 'opportunity', id: observationId } },
      { name: 'rsi_inspect', arguments: { kind: 'strategy', id: candidate.id } },
      { name: 'rsi_inspect', arguments: { kind: 'decision', id: decisionId } },
      { name: 'rsi_inspect', arguments: { kind: 'position', id: 'unheld-token' } },
    )
    const session = await run(ctx, 'rsi-inspection-tool')
    const output = results(session)
    expect(output[0]).toMatchObject({ isError: false, value: { opportunity: { observationId }, bookHash: observation.book.hash } })
    expect(output[1]).toMatchObject({ isError: false, value: { strategy: { id: candidate.id } } })
    expect(output[2]).toMatchObject({ isError: false, value: { decision: { id: decisionId, candidateId: candidate.id } } })
    expect(output[3]).toEqual({ isError: true, value: 'Error: Unknown open position' })
    expect(session.snapshotEvents().filter(event => event.type === 'tool/call').map(event => event.data.name))
      .toEqual(['rsi_inspect', 'rsi_inspect', 'rsi_inspect', 'rsi_inspect'])
    expect(adapter.requests).toHaveLength(5)
    expect(runtime.status().account.purchases).toBe(0)
  })

  it('shares operator Remote controls with chat tools and retained directives', async () => {
    const { configPath } = await fixture()
    const { ctx } = await load(configPath, [
      { name: 'rsi_objective', arguments: { expected_revision: 0, objective: 'Evaluate weather evidence' } },
      { name: 'rsi_research_control', arguments: { paused: true } },
    ])
    const output = results(await run(ctx, 'shared-rsi-directive'))
    expect(output.every(result => !result.isError)).toBe(true)
    expect(ctx.rsi.remoteStatus()).toMatchObject({
      objective: 'Evaluate weather evidence', directiveRevision: 1, research: { paused: true },
    })
    await ctx.rsi.remoteResearch(false)
    await ctx.rsi.remoteObjective(1, 'Compare calibrated forecasts')
    const revision = ctx.rsi.remoteStatus().controlRevision
    await ctx.rsi.remoteControl({ expectedRevision: revision, action: 'resume', reason: 'Operator test' })
    expect(ctx.rsi.remoteStatus()).toMatchObject({
      objective: 'Compare calibrated forecasts', directiveRevision: 2, status: 'running', research: { paused: false },
    })
    expect((await ctx.rsi.remoteRefresh()).observations).toBeGreaterThan(0)
  })

  it('retains real configured-check evidence from the model release-validation tool', async () => {
    const { root, configPath } = await fixture(false, true)
    const calls: ScriptedCall[] = []
    const { ctx } = await load(configPath, calls)
    const repository = join(root, 'repository')
    const hooks = join(root, 'hooks')
    await mkdir(repository)
    await mkdir(hooks)
    async function git(args: string[]): Promise<string> {
      const handle = ctx.subprocess.spawn({
        argv: ['git', '-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgsign=false', ...args],
        cwd: repository, graceMs: 1000,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
      })
      try {
        expect(await handle.done).toEqual({ exitCode: 0, signal: null })
        return handle.collected.stdout!.readFrom(0).text.trim()
      } finally {
        handle.terminate()
        await handle.waitForExit()
      }
    }
    await git(['init'])
    await git(['config', 'core.autocrlf', 'false'])
    await writeFile(join(repository, 'candidate.txt'), 'candidate\n')
    await git(['add', 'candidate.txt'])
    await git(['-c', 'user.name=RSI Fixture', '-c', 'user.email=rsi@example.invalid', 'commit', '-m', 'Candidate'])
    const commit = await git(['rev-parse', 'HEAD'])
    calls.push({ name: 'rsi_validate_release', arguments: { commit } })
    const output = results(await run(ctx, 'rsi-validate-tool'))
    expect(output).toHaveLength(1)
    expect(output[0]).toMatchObject({ isError: false, value: { reused: false, record: { candidateSha: commit, outcome: 'validated' } } })
    expect(await git(['rev-parse', 'HEAD'])).toBe(commit)
    expect(await readFile(join(repository, 'candidate.txt'), 'utf8')).toBe('candidate\n')
    const service = ctx.rsi
    const timeline = service.remoteDecisions({ kinds: ['release'], search: commit, cursor: null, limit: 10 })
    expect(timeline.items).toHaveLength(1)
    const row = timeline.items[0]!
    expect(row).toMatchObject({ kind: 'release', outcome: 'completed', releaseCommit: commit })
    const detail = service.remoteDecision(row.id)
    expect(detail.release).toMatchObject({ candidateSha: commit, outcome: 'validated' })
    expect(detail.release?.checks.every(check => check.passed)).toBe(true)
    expect(service.remoteOverview().activity.some(item => item.id === row.id)).toBe(true)
    await writeFile(join(repository, 'candidate.txt'), 'invalid\n')
    await git(['add', 'candidate.txt'])
    await git(['-c', 'user.name=RSI Fixture', '-c', 'user.email=rsi@example.invalid', 'commit', '-m', 'Invalid candidate'])
    const failedCommit = await git(['rev-parse', 'HEAD'])
    await ctx.fiber.dispose()
    const reopened = await load(configPath, [
      { name: 'rsi_inspect', arguments: { kind: 'decision', id: row.id } },
      { name: 'rsi_validate_release', arguments: { commit: failedCommit } },
    ])
    const inspection = results(await run(reopened.ctx, 'rsi-inspect-release'))
    expect(inspection[0]).toMatchObject({ isError: false, value: { decision: { id: row.id }, release: { candidateSha: commit } } })
    expect(inspection[1]).toMatchObject({ isError: false, value: { record: { candidateSha: failedCommit, outcome: 'failed' } } })
    const after = reopened.ctx.rsi
    const firstPage = after.remoteDecisions({ kinds: ['release'], search: '', cursor: null, limit: 1 })
    expect(firstPage.total).toBe(2)
    expect(firstPage.items[0]).toMatchObject({ outcome: 'failed', releaseCommit: failedCommit })
    expect(after.remoteDecision(firstPage.items[0]!.id).release?.checks.some(check => !check.passed)).toBe(true)
    expect(after.remoteDecisions({ kinds: ['release'], search: '', cursor: firstPage.nextCursor, limit: 1 }).items[0]?.id).toBe(row.id)
    expect(() => after.remoteDecision(brandString<DecisionId>('release:missing'))).toThrow('Unknown release validation record')
  })

  it('rejects a stale model control without replacing the newer permission', async () => {
    const { configPath } = await fixture()
    const { ctx } = await load(configPath, [
      { name: 'rsi_control', arguments: { expected_revision: 0, action: 'resume', reason: 'Current instruction.' } },
      { name: 'rsi_control', arguments: { expected_revision: 0, action: 'pause', reason: 'Stale instruction.' } },
      { name: 'rsi_status', arguments: {} },
    ])
    const output = results(await run(ctx, 'rsi-stale-control'))
    expect(output).toHaveLength(3)
    expect(output[1]?.isError).toBe(true)
    expect(output[1]?.value).toEqual(expect.stringContaining('Paper control revision is stale'))
    expect(output[2]).toMatchObject({ isError: false, value: { status: 'running', controlRevision: 1 } })
  })

  it('runs and persists an autonomous research Session and disposes its Agent', async () => {
    const { configPath } = await fixture(true)
    const { ctx, adapter } = await load(configPath, [{ name: 'rsi_status', arguments: {} }])
    const completed = Promise.withResolvers<ResearchRun>()
    ctx.on('domain/changed', (change) => {
      if (change.domain !== 'rsi_runtime' || change.table !== 'state') return
      const run = ctx.rsi.runtime.status().research.runs.at(-1)
      if (run !== undefined && run.state !== 'running') completed.resolve(run)
    })
    await ctx.rsi.runtime.tick()
    const run = await completed.promise
    expect(run, run.error ?? 'Research must complete').toMatchObject({ state: 'completed', error: null })
    expect(run.sessionId).toBeTypeOf('string')
    const id = SessionId(run.sessionId!)
    expect(ctx.agents.get(id)).toBeUndefined()
    expect(adapter.requests).toHaveLength(2)
    const handle = await ctx.sessionPersistence.open(id, 'read')
    try {
      const { events } = await handle.read()
      expect(events.find(event => event.type === 'tool/call')?.data.name).toBe('rsi_status')
      expect(events.findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
      expect(events.some(event => event.type === 'user/message'
        && event.data.source.kind === 'user')).toBe(true)
    } finally {
      await handle.close()
    }
    await ctx.rsi.runtime.tick()
    expect(ctx.rsi.runtime.status().research.runs).toEqual([run])
    expect(adapter.requests).toHaveLength(2)
  })
})
