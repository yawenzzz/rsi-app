/** Research runs own cancellation, durable completion, and Agent disposal. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory, AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { resolveConfig } from '../../src/runtime/config.ts'
import { createResearchDriver, RESEARCH_PROMPT } from '../../src/runtime/research-driver.ts'
import type { HealthReceipt } from '../../src/runtime/runtime/health.ts'
import type { ResearchRun } from '../../src/runtime/runtime-state.ts'

const roots: string[] = []
const contexts: Context[] = []
const run: ResearchRun = {
  id: 'driver-run', day: '2026-09-11', startedAt: 1, finishedAt: null,
  state: 'running', sessionId: null, error: null,
}
const sessionId = SessionId(`rsi-research-${run.id}`)

afterEach(async () => {
  vi.useRealTimers()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

type Facility = 'agents' | 'sessions' | 'agentDefaultModel' | 'sessionPersistence'

async function fixture(missing?: Facility) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-research-driver-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  if (missing !== 'sessions') await ctx.plugin(SessionStore)
  if (missing !== 'agents') await ctx.plugin(AgentRegistry)
  if (missing !== 'agentDefaultModel') await ctx.plugin(AgentDefaultModel, { provider: 'fixture', model: 'fixture-model' })
  if (missing !== 'sessions' && missing !== 'sessionPersistence') {
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  }
  const config = resolveConfig({
    objective: 'Collect prospective evidence.', writerLeasePath: join(root, 'writer'),
    ledger: {
      initialCapitalMicros: 100_000_000, perEventLimitMicros: 1_000_000,
      totalExposureLimitMicros: 5_000_000, maxDrawdownMicros: 2_000_000,
    },
    research: { enabled: true, cwd: root, timeoutMs: 30_000, maxOutputTokens: 256 },
  })
  return { ctx, config }
}

class ResearchAdapter extends LlmAdapter {
  readonly entered = Promise.withResolvers<undefined>()
  readonly cancelled = Promise.withResolvers<undefined>()
  readonly requests: GenerateOptions[] = []

  constructor(private readonly outcome: 'complete' | 'error' | 'max-tokens' | 'wait' | 'aborted') { super() }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.entered.resolve(undefined)
    if (this.outcome === 'aborted') {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Provider cancelled the response' } } }
      return
    }
    if (this.outcome === 'wait') {
      const signal = options.signal
      if (signal === undefined) throw new Error('Research model request omitted cancellation')
      signal.throwIfAborted()
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          this.cancelled.resolve(undefined)
          resolve()
        }, { once: true })
      })
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Research cancelled' } } }
      return
    }
    if (this.outcome === 'error') {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'Research provider failed' } } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Prospective evidence recorded.' } }
    yield { type: 'finish', reason: { kind: this.outcome === 'max-tokens' ? 'max-tokens' : 'stop' } }
  }
}

async function loopFixture(outcome: ConstructorParameters<typeof ResearchAdapter>[0]) {
  const result = await fixture()
  const { ctx } = result
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const adapter = new ResearchAdapter(outcome)
  ctx.effect(() => ctx.llm.registerAdapter(['fixture'], adapter))
  await ctx.plugin(AgentLoop)
  const events: SessionEvent[] = []
  const disposed: SessionId[] = []
  ctx.on('session/event', (session, event) => { if (session.id === sessionId) events.push(event) })
  ctx.on('agent/disposed', ({ agent }) => { disposed.push(agent.id) })
  return { ...result, adapter, events, disposed }
}

function installFactory(ctx: Context, createAgent: AgentFactory['createAgent']): void {
  ctx.effect(() => ctx.agents.setFactory({
    createAgent,
    resume: () => Promise.reject(new Error('Fixture does not resume Agents')),
  }))
}

describe('RSI research driver', () => {
  it('does not report provider availability from an aborted model finish', async () => {
    const { ctx, config } = await loopFixture('aborted')
    const report = vi.fn().mockResolvedValue(undefined)
    await expect(createResearchDriver(ctx, config)(run, new AbortController().signal, async () => {}, report))
      .rejects.toThrow('Research Session ended without a completed turn')
    expect(report).not.toHaveBeenCalled()
  })
  it.each(['complete', 'error', 'max-tokens'] as const)('reports observed model finishes independently of the %s run result', async (outcome) => {
    const { ctx, config, events } = await loopFixture(outcome)
    const receipts: HealthReceipt[] = []
    const pending = createResearchDriver(ctx, config)(run, new AbortController().signal, async () => {}, async (receipt) => {
      receipts.push(receipt)
    })
    if (outcome === 'complete') await pending
    else await expect(pending).rejects.toThrow('Research Session ended without a completed turn')
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ state: outcome === 'error' ? 'degraded' : 'healthy',
      error: outcome === 'error' ? 'Research provider failed' : null })
    expect(events.some(event => event.type === 'assistant/message' || event.type === 'assistant/attempt')).toBe(true)
  })

  it.each<Facility>(['agents', 'sessions', 'agentDefaultModel', 'sessionPersistence'])(
    'refuses a composition without %s before creating research', async (missing) => {
      const { ctx, config } = await fixture(missing)
      await expect(createResearchDriver(ctx, config)(run, new AbortController().signal, async () => {}))
        .rejects.toThrow('Autonomous research requires agents, sessions, sessionPersistence and agentDefaultModel')
      expect(ctx.get('agents')?.list() ?? []).toEqual([])
    },
  )

  it('rejects a pre-aborted admission without creating a Session', async () => {
    const { ctx, config } = await fixture()
    const failure = new Error('Admission cancelled')
    await expect(createResearchDriver(ctx, config)(run, AbortSignal.abort(failure), async () => {})).rejects.toBe(failure)
    expect(ctx.sessions.list()).toEqual([])
  })

  it('persists the exact instruction and selected output limit before disposing the Agent', async () => {
    const { ctx, config, adapter, events, disposed } = await loopFixture('complete')
    const result = await createResearchDriver(ctx, config)(run, new AbortController().signal, async () => {})
    expect(result).toEqual({ sessionId })
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ provider: 'fixture', model: 'fixture-model', maxTokens: 256 })
    expect(events.find(event => event.type === 'user/message' && event.data.source.kind === 'user'))
      .toMatchObject({ data: { content: [{ type: 'text', text: RESEARCH_PROMPT }] } })
    expect(disposed).toEqual([sessionId])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    const stored = await ctx.sessionPersistence.open(sessionId, 'read')
    try {
      expect((await stored.read()).events.findLast(event => event.type === 'turn/end'))
        .toMatchObject({ data: { reason: { kind: 'completed' } } })
    } finally {
      await stored.close()
    }
  })

  it('cancels an active model request and disposes before rejecting external cancellation', async () => {
    const { ctx, config, adapter, disposed } = await loopFixture('wait')
    const abort = new AbortController()
    const failure = new Error('Operator stopped research')
    const pending = createResearchDriver(ctx, config)(run, abort.signal, async () => {}).then(() => undefined, (error: unknown) => error)
    await adapter.entered.promise
    const other = ctx.sessions.create(SessionId('other-session'))
    other.append('turn/start', { turn: 1 })
    other.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    abort.abort(failure)
    await adapter.cancelled.promise
    expect(await pending).toBe(failure)
    expect(disposed).toEqual([sessionId])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
  })

  it('publishes a durable native Session before starting model work and retains it after cancellation', async () => {
    const { ctx, config, adapter, disposed } = await loopFixture('wait')
    const linked = Promise.withResolvers<undefined>()
    const abort = new AbortController()
    const failure = new Error('Stop an inspectable research run')
    const pending = createResearchDriver(ctx, config)(run, abort.signal, async (id) => {
      expect(id).toBe(sessionId)
      expect(adapter.requests).toHaveLength(0)
      const stored = await ctx.sessionPersistence.open(id, 'read')
      await stored.close()
      expect(ctx.agents.get(id)).toBeDefined()
      linked.resolve(undefined)
    }).catch((error: unknown) => error)
    await linked.promise
    await adapter.entered.promise
    abort.abort(failure)
    expect(await pending).toBe(failure)
    expect(disposed).toEqual([sessionId])
    const stored = await ctx.sessionPersistence.open(sessionId, 'read')
    await stored.close()
  })

  it('stops before a model request if publishing the Session link fails', async () => {
    const { ctx, config, adapter, disposed } = await loopFixture('complete')
    const failure = new Error('Research link persistence failed')
    await expect(createResearchDriver(ctx, config)(run, new AbortController().signal, async () => { throw failure }))
      .rejects.toBe(failure)
    expect(adapter.requests).toHaveLength(0)
    expect(disposed).toEqual([sessionId])
  })

  it('honors cancellation received while publishing the Session link', async () => {
    const { ctx, config, adapter, disposed } = await loopFixture('complete')
    const abort = new AbortController()
    const failure = new Error('Cancelled while linking research')
    await expect(createResearchDriver(ctx, config)(run, abort.signal, async () => { abort.abort(failure) })).rejects.toBe(failure)
    expect(adapter.requests).toHaveLength(0)
    expect(disposed).toEqual([sessionId])
  })

  it('enforces its deadline against an active model request', async () => {
    const { ctx, config, adapter, disposed } = await loopFixture('wait')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pending = createResearchDriver(ctx, config)(run, new AbortController().signal, async () => {})
        .then(() => undefined, (error: unknown) => error)
      await adapter.entered.promise
      await vi.advanceTimersByTimeAsync(config.research.timeoutMs)
      await adapter.cancelled.promise
      expect(await pending).toMatchObject({ message: 'Research run deadline exceeded' })
      expect(disposed).toEqual([sessionId])
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['error', 'max-tokens'] as const)('refuses a %s turn and disposes its Agent', async (outcome) => {
    const { ctx, config, disposed } = await loopFixture(outcome)
    await expect(createResearchDriver(ctx, config)(run, new AbortController().signal, async () => {}))
      .rejects.toThrow('Research Session ended without a completed turn')
    expect(disposed).toEqual([sessionId])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
  })

  it('propagates a creation failure and clears its deadline', async () => {
    const { ctx, config } = await fixture()
    const failure = new Error('Agent creation failed')
    installFactory(ctx, () => Promise.reject(failure))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await expect(createResearchDriver(ctx, config)(run, new AbortController().signal, async () => {})).rejects.toBe(failure)
      expect(vi.getTimerCount()).toBe(0)
      expect(ctx.sessions.list()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards cancellation while Agent creation has not published a handle', async () => {
    const { ctx, config } = await fixture()
    const entered = Promise.withResolvers<undefined>()
    installFactory(ctx, async (_owner, options) => {
      const signal = options.signal
      if (signal === undefined) throw new Error('Creation did not receive cancellation')
      entered.resolve(undefined)
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      signal.throwIfAborted()
      throw new Error('Creation unexpectedly continued')
    })
    const abort = new AbortController()
    const failure = new Error('Cancelled unpublished creation')
    const pending = createResearchDriver(ctx, config)(run, abort.signal, async () => {}).then(() => undefined, (error: unknown) => error)
    await entered.promise
    abort.abort(failure)
    expect(await pending).toBe(failure)
    expect(ctx.agents.list()).toEqual([])
  })

  it.each(['before-ready', 'after-turn'] as const)('does not report success when the %s durability barrier fails', async (phase) => {
    const { ctx, config, adapter, disposed } = await loopFixture('complete')
    const failure = new Error('Research flush failed')
    let armed = phase === 'before-ready'
    let published = false
    const remove = ctx.on('session/flush', (session) => {
      if (session.id !== sessionId || !armed) return
      remove()
      throw failure
    })
    await expect(createResearchDriver(ctx, config)(run, new AbortController().signal, async () => {
      published = true
      armed = true
    })).rejects.toBe(failure)
    expect(published).toBe(phase === 'after-turn')
    expect(adapter.requests).toHaveLength(phase === 'after-turn' ? 1 : 0)
    expect(disposed).toEqual([sessionId])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
  })

  it('rejects an idle factory result that produced no durable turn completion', async () => {
    const { ctx, config } = await fixture()
    let disposed = false
    installFactory(ctx, async (_owner, options) => {
      let handle!: AgentHandle
      const scope = ctx.plugin({
        name: 'research-test-agent', inject: ['sessions', 'agents', 'sessionPersistence'],
        async apply(agentCtx: Context) {
          const session: Session = agentCtx.sessions.create(options.sessionId)
          const stored = await agentCtx.sessionPersistence.create(session.header)
          const agent: Agent = {
            id: session.id, session, ctx: agentCtx, options: options.agentOptions ?? {},
            inbox: unsupportedInbox(), status: 'idle', cancel() {}, send() {},
            followup() {}, steer() {}, inject() {}, whenIdle: () => Promise.resolve(),
            runMaintenance: task => task(new AbortController().signal),
          }
          await options.setup?.(agentCtx, agent)
          agentCtx.agents.register(agent)
          handle = {
            agent,
            async dispose() { await stored.close(); await scope.dispose(); disposed = true },
          }
        },
      })
      await scope
      return handle
    })
    const outcome = await createResearchDriver(ctx, config)(run, new AbortController().signal, async () => {})
      .catch((error: unknown) => error)
    if (outcome instanceof Error && outcome.message !== 'Research Session ended without a completed turn') throw outcome
    expect(outcome).toMatchObject({ message: 'Research Session ended without a completed turn' })
    expect(disposed).toBe(true)
    expect(ctx.agents.get(sessionId)).toBeUndefined()
  })
})
