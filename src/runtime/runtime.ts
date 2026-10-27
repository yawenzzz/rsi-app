/** Single-host public-data collection, prospective research and paper execution. */

import { createHash, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Domain, DomainFacility, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { Config } from './config.ts'
import { Experiments } from './strategy/experiments.ts'
import { candidateInputSchema, forecastInputSchema } from './strategy/experiment-schema.ts'
import type { ResearchObservationId } from './strategy/experiment-schema.ts'
import type { Candidate, Forecast } from './strategy/experiment-types.ts'
import { PaperLedger } from './execution/ledger.ts'
import type { LedgerControl, ResolutionRef } from './execution/ledger-types.ts'
import { MarketDataClient } from './data/market.ts'
import type { ConditionId, Market } from './data/market.ts'
import { executePaperForecasts } from './execution/paper.ts'
import { forecastRevision, latestForecasts, primaryForecast } from './strategy/forecasts.ts'
import { createObservation, runtimeDomain } from './runtime-state.ts'
import type { Observation, ResearchRun, RuntimeState } from './runtime-state.ts'
import type { RsiStatus, TickResult } from './runtime-types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WebFetchResult } from '@deepseek-ai/dsh-web'
import { openEvidenceStore } from './data/evidence.ts'
import { judgmentInputSchema } from './judgment.ts'
import type { JudgmentProvider, JudgmentResponse } from './judgment.ts'
import type { EvidenceStore, SourceEvidence } from './data/evidence.ts'
export type { TickResult } from './runtime-types.ts'
import { DecisionJournal } from './decision/journal.ts'
import type { ConsoleSource } from './queries/source.ts'
import { Operations } from './runtime/operations.ts'
import type { OperationalState } from './runtime/operations.ts'
import type { ReleaseRecordStore } from './evolution/release-types.ts'
import { observeMarketData } from './runtime/health.ts'
import type { HealthReceipt, ObservedMarketData } from './runtime/health.ts'

/** One bounded research Session; the runtime owns its admission and interruption. */
export type ResearchDriver = (
  run: ResearchRun, signal: AbortSignal, sessionReady: (id: SessionId) => Promise<void>,
  modelResult?: (result: HealthReceipt) => Promise<void>,
) => Promise<{ sessionId: string }>

/** Dependencies supplied by the owning plugin or an isolated integration fixture. */
export interface RuntimeDependencies {
  storageDomain: DomainFacility
  data: MarketDataClient
  /** Optional configured release authority, shared by tools and console reads. */
  releases: Pick<ReleaseRecordStore, 'list' | 'get'> | null
  /** Throws after the process loses its writer lease. */
  assertWriter(): void
  researchDriver?: ResearchDriver
  /** Retrieve source text through the configured Web provider. */
  fetchEvidence?(url: string, signal: AbortSignal): Promise<WebFetchResult>
  /** Bounded TypeSafe provider; host composition supplies the official SDK adapter. */
  judge?: JudgmentProvider
  /** Error sink for contained background failures. */
  reportError(error: unknown): void
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * Own durable research records and one serialized collection loop.
 * @param config - Explicit deployment settings.
 * @param deps - Host facilities, public data and writer authority.
 * @param domain - Open runtime observation and admission domain.
 * @param ledger - Paper account with independent executor-side risk checks.
 * @param experiments - Immutable candidate and forward-outcome registry.
 */
export class RsiRuntime {
  private readonly abort = new AbortController()
  private readonly state: KvTable<'state', RuntimeState>
  private readonly observations: KvTable<string, Observation>
  private tickPending: Promise<TickResult> | undefined
  private researchPending: Promise<void> | undefined
  private researchAbort: AbortController | undefined
  private workAbort = new AbortController()
  private operationalWork: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposal: Promise<void> | undefined
  private readonly captures = new Set<Promise<SourceEvidence>>()
  private readonly judgments = new Set<Promise<JudgmentResponse>>()

  private constructor(
    readonly config: Config,
    private readonly deps: RuntimeDependencies,
    private readonly domain: Domain<typeof runtimeDomain>,
    readonly ledger: PaperLedger,
    readonly experiments: Experiments,
    readonly journal: DecisionJournal,
    readonly operations: Operations,
    readonly evidence: EvidenceStore,
  ) {
    this.state = domain.table('state')
    this.observations = domain.table('observations')
  }

  /**
   * Open all durable owners and mark interrupted research without resetting its allowance.
   * @param config - Validated settings.
   * @param deps - Host-owned runtime dependencies.
   * @returns a ready runtime; collection begins only when start is called.
   */
  static async open(config: Config, deps: RuntimeDependencies): Promise<RsiRuntime> {
    deps.assertWriter()
    const domain = await deps.storageDomain.open(runtimeDomain)
    let ledger: PaperLedger | undefined
    let experiments: Experiments | undefined
    let journal: DecisionJournal | undefined
    let operations: Operations | undefined
    let evidence: EvidenceStore | undefined
    try {
      operations = await Operations.open(deps.storageDomain, () => { deps.assertWriter() })
      const admissions = operations
      journal = await DecisionJournal.open(deps.storageDomain, config.maxDecisionRecords, () => { deps.assertWriter() })
      ledger = await PaperLedger.open(deps.storageDomain, config.ledger, { now: Date.now },
        () => { deps.assertWriter() }, () => { admissions.assertRunning() })
      experiments = await Experiments.open(deps.storageDomain, config.experiments, Date.now,
        () => { deps.assertWriter() }, () => { admissions.assertRunning() })
      evidence = await openEvidenceStore(deps.storageDomain, config.evidence,
        () => { deps.assertWriter() }, () => { admissions.assertRunning() })
      const runtime = new RsiRuntime(config, deps, domain, ledger, experiments, journal, operations, evidence)
      if (runtime.state.get('state') === undefined) {
        await runtime.state.put('state', {
          objective: config.objective, directiveRevision: 0, researchPaused: false,
          nextTickAt: 0, lastTickAt: null, lastTickError: null,
          health: { gamma: null, clob: null, model: null },
          researchRuns: [], resourceRequests: [],
        })
      } else {
        await runtime.updateState( state => ({
          ...state,
          researchRuns: state.researchRuns.map(run => run.state === 'running'
            ? { ...run, state: 'interrupted', finishedAt: Date.now(), error: 'Host restarted during research' }
            : run),
        }))
      }
      return runtime
    } catch (error) {
      await Promise.allSettled([
        domain.close(), ledger?.close(), experiments?.close(), journal?.close(), operations?.close(), evidence?.close(),
      ])
      throw error
    }
  }

  /** Start the opt-in timer; calls on an already scheduled runtime have no effect. */
  start(): void {
    this.assertOpen()
    if (!this.config.autoTick || this.timer !== undefined || this.operations.view().stopped) return
    this.schedule()
  }

  /**
   * Read compact durable state without exposing unbounded histories or credentials.
   * @returns paper account, ranked candidates, recent observations and outstanding requests.
   */
  status(): RsiStatus {
    const state = this.currentState()
    const account = this.ledger.view()
    const observations = [...this.observations.entries()].slice(-this.config.statusLimit).map(([id, observation]) => {
      const token = observation.market.tokens.find(member => member.id === observation.book.tokenId)
      assert(token)
      return {
        id, marketId: observation.market.id, eventId: observation.market.eventId,
        question: observation.market.question, tokenId: observation.book.tokenId, outcome: token.outcome,
        averageCostMicros: observation.averageCostMicros, observedAt: observation.book.observedAt,
        endDate: observation.market.endDate,
      }
    })
    return {
      mode: 'paper' as const, status: account.status, controlRevision: account.controlRevision,
      objective: state.objective,
      directiveRevision: state.directiveRevision,
      consolePollIntervalMs: this.config.consolePollIntervalMs,
      account: {
        initialCapitalMicros: account.config.initialCapitalMicros, cashMicros: account.cashMicros,
        committedCostMicros: account.committedCostMicros, realizedProfitMicros: account.realizedProfitMicros,
        costBasisEquityMicros: account.equityMicros, positions: account.positions.length,
        purchases: account.trades.length, settlements: account.settlements.length,
      },
      candidates: this.experiments.rank(), observations,
      observationCount: this.observations.size,
      lastTickError: state.lastTickError,
      research: { enabled: this.config.research.enabled, paused: state.researchPaused,
        runs: state.researchRuns.slice(-this.config.statusLimit) },
      requests: state.resourceRequests.slice(-this.config.statusLimit),
    }
  }

  /**
   * Read the domain owners synchronously for Host-side console projections.
   * @returns detached facts and read-only release lookups; Remote callers receive bounded projections only.
   */
  consoleSource(): ConsoleSource {
    this.assertOpen()
    return {
      now: Date.now(), config: this.config, state: structuredClone(this.currentState()),
      account: this.ledger.view(), research: this.experiments.view(), ranks: this.experiments.rank(),
      observations: structuredClone([...this.observations.entries()].map(([, observation]) => observation)), journal: this.journal.view(),
      operations: this.operations.view(), releases: this.deps.releases,
    }
  }

  /**
   * Read the exact retained metadata, depth and fee estimate backing one forecast.
   * @param id - Observation identity returned by status or tick.
   * @returns a detached immutable source observation.
   */
  observation(id: string): Observation {
    const value = this.observations.get(id)
    if (value === undefined) throw new Error('Unknown observation')
    return structuredClone(value)
  }

  /**
   * Capture external source text for a known event without accepting model-supplied acquisition claims.
   * @param observationId - Market observation identifying the event being researched.
   * @param url - HTTP(S) source retrieved by the configured Web provider.
   * @param signal - Caller cancellation, combined with runtime shutdown and emergency stop.
   * @returns immutable fetched evidence; failed, truncated, or oversized responses reject.
   */
  captureEvidence(observationId: string, url: string, signal?: AbortSignal): Promise<SourceEvidence> {
    this.assertOpen()
    this.operations.assertRunning()
    const observation = this.observation(observationId)
    const address = z.url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol)).parse(url)
    const combined = AbortSignal.any([this.abort.signal, this.workAbort.signal, ...(signal === undefined ? [] : [signal])])
    const operation = (async () => {
      combined.throwIfAborted()
      if (this.deps.fetchEvidence === undefined) throw new Error('Source capture requires a configured Web fetch provider')
      const response = await this.deps.fetchEvidence(address, combined)
      combined.throwIfAborted()
      if (response.statusCode < 200 || response.statusCode >= 300 || response.truncated) {
        throw new Error('Source capture requires a complete successful HTTP response')
      }
      return await this.evidence.append({ eventId: observation.market.eventId, url: response.url,
        text: response.body.content, reportedPublishedAt: null, provenance: 'fetched' })
    })()
    this.captures.add(operation)
    void operation.finally(() => { this.captures.delete(operation) }).catch(() => {})
    return operation
  }

  /**
   * Evaluate narrow semantic questions against supplied state and named retained evidence.
   * Results become durable through the calling tool's Session; this method writes no forecast.
   * @param input - JSON state, typed questions, and optional named source snapshot identifiers.
   * @param signal - Caller cancellation, combined with shutdown and emergency stop.
   * @returns provider answers with exact submitted-input identity; unavailable providers reject.
   */
  judge(input: unknown, signal?: AbortSignal): Promise<JudgmentResponse> {
    this.assertOpen()
    this.operations.assertRunning()
    const request = judgmentInputSchema.parse(input)
    const provider = this.deps.judge
    if (provider === undefined) throw new Error('Jev judgment provider is not configured')
    const state = request.evidence === undefined ? request.state : {
      context: request.state,
      evidence: Object.fromEntries(Object.entries(request.evidence).map(([name, id]) => [name, this.evidence.get(id)])),
    }
    const combined = AbortSignal.any([this.abort.signal, this.workAbort.signal, ...(signal === undefined ? [] : [signal])])
    const operation = (async () => {
      combined.throwIfAborted()
      const answer = await provider({ state, questions: request.questions }, combined)
      combined.throwIfAborted()
      return answer
    })()
    this.judgments.add(operation)
    void operation.finally(() => { this.judgments.delete(operation) }).catch(() => {
      // The caller receives the rejection; this branch only contains the cleanup promise.
    })
    return operation
  }

  /**
   * Change paper execution permission using the latest control revision.
   * @param command - Compare-and-set pause or resume request.
   * @returns the compact state after the durable control commit.
   */
  async control(command: LedgerControl): Promise<RsiStatus> {
    this.assertOpen()
    if (command.action === 'resume') this.operations.assertRunning()
    await this.ledger.control(command)
    return this.status()
  }

  /**
   * Pause new research and cancel the admitted run, or allow subsequent scheduled research.
   * @param paused - Whether research admissions must stop.
   * @returns status after the durable change; active-run cancellation settles asynchronously.
   */
  async pauseResearch(paused: boolean): Promise<RsiStatus> {
    this.assertOpen()
    if (!paused) this.operations.assertRunning()
    await this.updateState(state => ({ ...state, researchPaused: paused }))
    if (paused) {
      this.researchAbort?.abort(new Error('Research paused by the operator'))
    }
    return this.status()
  }

  /**
   * Replace the objective, pausing purchases and invalidating current research first.
   * @param expectedRevision - Exact directive revision read by the operator.
   * @param objective - Complete new research objective.
   * @returns the new objective and incremented directive revision.
   */
  async changeObjective(expectedRevision: number, objective: string): Promise<RsiStatus> {
    this.assertOpen()
    const text = z.string().trim().min(1).max(4096).parse(objective)
    if (this.currentState().directiveRevision !== expectedRevision) throw new Error('Research directive revision is stale')
    const account = this.ledger.view()
    await this.ledger.control({ expectedRevision: account.controlRevision, action: 'pause', reason: 'Research objective changed' })
    await this.updateState((state) => {
      if (state.directiveRevision !== expectedRevision) throw new Error('Research directive revision is stale')
      return { ...state, objective: text, directiveRevision: state.directiveRevision + 1 }
    })
    this.researchAbort?.abort(new Error('Research objective changed'))
    return this.status()
  }

  /**
   * Register a new immutable candidate from validated model JSON.
   * @param input - Candidate fields; all changes produce another candidate version.
   * @returns the committed candidate.
   */
  async registerCandidate(input: unknown): Promise<Candidate> {
    this.assertOpen()
    return await this.experiments.registerCandidate(candidateInputSchema.parse(input))
  }

  /**
   * Attach a prospective estimate to data collected by this runtime.
   * @param observationId - Retained data identity; prices and timestamps are not model-supplied.
   * @param input - Candidate identity, probability, uncertainty and supporting evidence.
   * @returns the immutable primary estimate or an appended revision for the same outcome.
   */
  async forecast(observationId: string, input: unknown): Promise<Forecast> {
    this.assertOpen()
    const observation = this.observation(observationId)
    this.requireFresh(observation)
    const estimate = forecastInputSchema.parse(input)
    for (const item of estimate.evidence) {
      if (item.snapshotId === undefined) continue
      const source = this.evidence.get(item.snapshotId)
      if (source.eventId !== observation.market.eventId || source.url !== item.url || !source.text.includes(item.text)) {
        throw new Error('Forecast source reference does not match the retained event, URL, or text')
      }
    }
    const forecast = await this.experiments.recordForecast(estimate, {
      observationId: brandString<ResearchObservationId>(observationId),
      observedAt: observation.book.observedAt,
      eventId: observation.market.eventId, marketId: observation.market.id, tokenId: observation.book.tokenId,
      eventEndsAt: Date.parse(observation.market.endDate), costMicros: observation.averageCostMicros,
      baselineProbability: observation.baselineProbability,
    })
    return forecast
  }

  /**
   * Retain a resource request once per exact requirement while research can continue.
   * @param kind - Resource category, such as data, deployment or wallet setup.
   * @param reason - Concrete task blocked by the missing resource.
   * @param estimatedMonthlyCost - Requested recurring cost; recording it authorizes no spending.
   * @returns the durable request, including its stable identity.
   */
  async requestResource(
    kind: string,
    reason: string,
    estimatedMonthlyCost: number,
  ): Promise<RuntimeState['resourceRequests'][number]> {
    this.assertOpen()
    const id = createHash('sha256').update(JSON.stringify([kind, reason, estimatedMonthlyCost])).digest('hex')
    const existing = this.currentState().resourceRequests.find(request => request.id === id)
    if (existing !== undefined) return structuredClone(existing)
    const request = { id, kind, reason, estimatedMonthlyCost, requestedAt: Date.now() }
    await this.updateState( (state) => {
      this.assertOpen()
      if (state.resourceRequests.some(member => member.id === id)) return state
      if (state.resourceRequests.length >= this.config.experiments.maxCandidates) throw new Error('Resource-request capacity reached')
      return { ...state, resourceRequests: [...state.resourceRequests, request] }
    })
    return request
  }

  /**
   * Collect one bounded batch, reconcile reported outcomes and execute eligible paper forecasts.
   * @param signal - Cancellation of the owning tick; concurrent callers share the first admitted tick.
   * @returns counts and bounded per-market errors; failed collection remains durable diagnostics.
   */
  tick(signal?: AbortSignal): Promise<TickResult> {
    this.assertOpen()
    this.operations.assertRunning()
    if (this.tickPending !== undefined) return this.tickPending
    const signals = [this.abort.signal, this.workAbort.signal]
    if (signal !== undefined) signals.push(signal)
    const combined = AbortSignal.any(signals)
    const operation = this.runTick(combined)
    this.tickPending = operation
    void operation.finally(() => { this.tickPending = undefined }).catch(() => {})
    return operation
  }

  /** Stop new work, cancel and join active work, then close all durable owners. */
  close(): Promise<void> {
    this.disposal ??= this.runClose()
    return this.disposal
  }

  /**
   * Stop new admissions durably before cancellation, and drain purchases through account control.
   * @param revision - Current emergency-control revision.
   * @param stopped - Desired emergency state; resume leaves the paper account paused.
   * @param reason - Operator's recorded reason.
   * @returns committed latch; research cancellation settles asynchronously for self-calling Agents.
   */
  async changeOperations(revision: number, stopped: boolean, reason: string): Promise<OperationalState> {
    const pending = this.operationalWork.then(() => this.applyOperations(revision, stopped, reason))
    this.operationalWork = pending.catch(() => {})
    return pending
  }

  private async applyOperations(revision: number, stopped: boolean, reason: string): Promise<OperationalState> {
    this.assertOpen()
    const next = await this.operations.change(revision, stopped, reason)
    if (stopped) {
      clearTimeout(this.timer)
      this.timer = undefined
      this.workAbort.abort(new Error('RSI emergency stop'))
      this.researchAbort?.abort(new Error('RSI emergency stop'))
      await this.updateState(state => ({ ...state, researchPaused: true }))
      const account = this.ledger.view()
      await this.ledger.control({ expectedRevision: account.controlRevision, action: 'pause', reason })
    } else {
      this.workAbort = new AbortController()
      await this.updateState(state => ({ ...state, researchPaused: false }))
      this.start()
    }
    await this.journal.append({ decision: { at: Date.now(), kind: 'control', outcome: 'completed',
      summary: stopped ? 'operations.stopped' : 'operations.resumed', question: null, amountMicros: null,
      observationId: null, candidateId: null, sessionId: null },
    references: [{ kind: 'revision', value: String(next.revision) }], checks: [], pricing: null, explanation: reason })
    return next
  }

  private async runClose(): Promise<void> {
    this.abort.abort(new Error('RSI runtime stopped'))
    clearTimeout(this.timer)
    await Promise.allSettled([this.tickPending, this.researchPending, this.operationalWork, ...this.captures, ...this.judgments])
    await Promise.all([
      this.ledger.close(), this.experiments.close(), this.journal.close(),
      this.operations.close(), this.evidence.close(), this.domain.close(),
    ])
  }

  private assertOpen(): void {
    this.abort.signal.throwIfAborted()
    this.deps.assertWriter()
  }

  private currentState(): RuntimeState {
    const state = this.state.get('state')
    assert(state)
    return state
  }

  private updateState(transform: (state: RuntimeState) => RuntimeState): Promise<RuntimeState> {
    return this.state.update('state', (state) => {
      this.deps.assertWriter()
      return transform(state)
    })
  }

  private schedule(): void {
    const wait = Math.min(this.config.tickIntervalMs, Math.max(0, this.currentState().nextTickAt - Date.now()))
    this.timer = setTimeout(() => {
      this.timer = undefined
      void Promise.resolve().then(() => this.tick())
        .catch((error: unknown) => { this.deps.reportError(error) })
        .then(() => this.scheduleNext())
    }, wait)
  }

  private async scheduleNext(): Promise<void> {
    if (this.abort.signal.aborted || this.operations.view().stopped) return
    try {
      this.deps.assertWriter()
    } catch {
      // A lost lease forbids another timer admission; close still drains accepted work.
      await this.close()
      return
    }
    this.schedule()
  }

  private requireFresh(observation: Observation): void {
    const now = Date.now()
    const timestamps = [observation.market.observedAt, observation.book.timestamp, observation.book.observedAt, observation.fees.observedAt]
    for (const at of timestamps) {
      if (at > now || now - at > this.config.maxObservationAgeMs) throw new Error('Observation is stale or dated in the future')
    }
    if (Date.parse(observation.market.endDate) <= now || !observation.market.acceptingOrders || observation.market.closed) {
      throw new Error('Market is not open for prospective trading')
    }
  }

  private async runTick(signal: AbortSignal): Promise<TickResult> {
    const result: TickResult = { observations: 0, skipped: 0, errors: [] }
    const observed = observeMarketData(this.deps.data, this.currentState().health, this.config.maxObservationAgeMs, Date.now)
    const data = observed.data
    let failure: unknown
    try {
      const markets = await data.discover(signal)
      for (const market of markets) {
        signal.throwIfAborted()
        if (Date.parse(market.endDate) <= Date.now()) { result.skipped++; continue }
        try {
          const fees = await data.feeParameters(market.conditionId, signal)
          for (const token of market.tokens) {
            const book = await data.book(token.id, signal)
            if (book.conditionId !== market.conditionId) throw new Error('Book belongs to another market')
            const quantity = Math.ceil(book.minOrderSize)
            const observation = createObservation(market, book, fees, quantity, this.config.paperSlippageBps)
            if (observation === null || observation.averageCostMicros >= 1_000_000) { result.skipped++; continue }
            this.requireFresh(observation)
            this.assertOpen()
            if (this.observations.size >= this.config.maxObservations) throw new Error('Observation capacity reached; retained evidence is not deleted automatically')
            await this.observations.put(observation.id, observation)
            result.observations++
          }
        } catch (error) {
          signal.throwIfAborted()
          result.skipped++
          if (result.errors.length < this.config.statusLimit) result.errors.push(errorText(error).slice(0, 512))
        }
      }
      await this.reconcile(signal, data)
      await this.executeEligible(signal, markets, data)
    } catch (error) {
      failure = error
    }
    if (!this.abort.signal.aborted) {
      this.deps.assertWriter()
      await this.updateState( state => ({ ...state, lastTickAt: Date.now(),
        nextTickAt: Date.now() + this.config.tickIntervalMs,
        health: { ...state.health, ...observed.updates },
        lastTickError: failure === undefined ? result.errors[0] ?? null : errorText(failure).slice(0, 512),
      }))
      await this.journal.append({
        decision: { at: Date.now(), kind: 'data', outcome: failure === undefined && result.errors.length === 0 ? 'completed' : 'failed',
          summary: 'data.scan', question: null, amountMicros: null, observationId: null, candidateId: null, sessionId: null },
        references: [{ kind: 'observations', value: String(result.observations) }, { kind: 'skipped', value: String(result.skipped) }],
        checks: [], pricing: null, explanation: failure === undefined ? result.errors.join('\n') : errorText(failure).slice(0, 512),
      })
    }
    if (!this.abort.signal.aborted) this.maybeResearch()
    if (failure !== undefined) throw failure instanceof Error ? failure : new Error(errorText(failure), { cause: failure })
    return result
  }

  private async reconcile(signal: AbortSignal, data: ObservedMarketData): Promise<void> {
    const research = this.experiments.view()
    const pending = research.forecasts.filter(forecast => !research.settlements.some(settlement =>
      settlement.marketId === forecast.observation.marketId && settlement.tokenId === forecast.observation.tokenId))
    const conditions = new Map<ConditionId, Observation>()
    for (const forecast of pending) {
      const observation = this.observation(forecast.observation.observationId)
      conditions.set(observation.market.conditionId, observation)
    }
    for (const position of this.ledger.view().positions) {
      if (conditions.has(position.conditionId)) continue
      const observation = [...this.observations.entries()].find(([, entry]) => entry.market.conditionId === position.conditionId)?.[1]
      if (observation === undefined) throw new Error('Paper position has no retained market evidence')
      conditions.set(position.conditionId, observation)
    }
    for (const [conditionId, observation] of conditions) {
      const resolution = await data.resolution(conditionId, signal)
      if (resolution.status !== 'reported-final') continue
      this.assertOpen()
      for (const payout of resolution.payouts) {
        const retained = this.experiments.view().settlements.find(settlement =>
          settlement.marketId === observation.market.id && settlement.tokenId === payout.tokenId)
        if (retained !== undefined && (retained.payout !== payout.payout || retained.eventId !== observation.market.eventId)) {
          throw new Error('Reported payout conflicts with retained settlement evidence')
        }
        const matching = pending.some(forecast =>
          forecast.observation.marketId === observation.market.id && forecast.observation.tokenId === payout.tokenId)
        if (matching) await this.experiments.settle({
          marketId: observation.market.id, eventId: observation.market.eventId, tokenId: payout.tokenId,
          payout: payout.payout, resolvedAt: resolution.observedAt,
          source: new URL('/markets', this.config.data.gammaUrl).href,
        })
        if (this.ledger.view().positions.some(position => position.tokenId === payout.tokenId)) {
          await this.ledger.settle({
            resolutionRef: brandString<ResolutionRef>(`gamma:${conditionId}:${payout.tokenId}:${payout.payout}`),
            marketId: observation.market.id, conditionId, eventId: observation.market.eventId, tokenId: payout.tokenId,
            final: true, payoutPerShareMicros: Math.round(payout.payout * 1_000_000), resolvedAt: resolution.observedAt,
          })
        }
      }
    }
  }

  private async executeEligible(signal: AbortSignal, markets: Market[], data: ObservedMarketData): Promise<void> {
    const research = this.experiments.view()
    const eligible = new Set(this.experiments.rank()
      .filter(candidate => candidate.status === 'paper-eligible').map(candidate => candidate.candidateId))
    const attempts = latestForecasts(research).flatMap((forecast) => {
      if (!eligible.has(forecast.candidateId)) return []
      if (research.settlements.some(settlement => settlement.marketId === forecast.observation.marketId
        && settlement.tokenId === forecast.observation.tokenId)) return []
      const market = markets.find(item => item.id === forecast.observation.marketId)
      if (market === undefined) return []
      const candidate = research.candidates.find(item => item.id === forecast.candidateId)
      assert(candidate)
      return [{ candidate, forecast, primaryForecast: primaryForecast(research, forecast), market }]
    })
    await executePaperForecasts({
      config: this.config, ledger: this.ledger, journal: this.journal, data,
      observation: id => this.observation(id), assertOpen: () => { this.assertOpen() },
      isCurrent: forecast => latestForecasts(this.experiments.view()).some(current =>
        current.candidateId === forecast.candidateId && current.observation.eventId === forecast.observation.eventId
        && current.observation.observationId === forecast.observation.observationId && current.receivedAt === forecast.receivedAt
        && forecastRevision(current) === forecastRevision(forecast)),
      retainObservation: async (observation) => {
        this.assertOpen()
        if (this.observations.size >= this.config.maxObservations) throw new Error('Execution evidence capacity reached')
        await this.observations.put(observation.id, observation)
      },
    }, attempts, signal)
  }

  private maybeResearch(): void {
    if (!this.config.research.enabled || this.currentState().researchPaused
      || this.operations.view().stopped || this.researchPending !== undefined) return
    const driver = this.deps.researchDriver
    if (driver === undefined) throw new Error('Autonomous research has no configured driver')
    const now = Date.now()
    const runs = this.currentState().researchRuns
    const day = new Date(now).toISOString().slice(0, 10)
    if (runs.filter(run => run.day === day).length >= this.config.research.maxRunsPerDay) return
    const last = runs.at(-1)
    if (last !== undefined && now - last.startedAt < this.config.research.intervalMs) return
    const run: ResearchRun = { id: randomUUID(), day, startedAt: now, finishedAt: null, state: 'running', sessionId: null, error: null }
    const controller = new AbortController()
    this.researchAbort = controller
    const operation = this.runResearch(run, driver, AbortSignal.any([this.abort.signal, controller.signal]))
    this.researchPending = operation
    void operation.catch((error: unknown) => { this.deps.reportError(error) }).finally(() => { this.researchPending = undefined })
  }

  private async runResearch(run: ResearchRun, driver: ResearchDriver, signal: AbortSignal): Promise<void> {
    this.assertOpen()
    await this.updateState((state) => {
      signal.throwIfAborted()
      this.operations.assertRunning()
      return { ...state, researchRuns: [...state.researchRuns, run] }
    })
    try {
      const result = await driver(run, signal, async (id) => {
        await this.updateState(state => ({ ...state, researchRuns: state.researchRuns.map(entry =>
          entry.id === run.id ? bindResearchSession(entry, id) : entry) }))
      }, async (receipt) => {
        await this.updateState(state => ({ ...state, health: { ...state.health, model: { ...receipt,
          lastSuccessAt: receipt.lastSuccessAt ?? state.health.model?.lastSuccessAt ?? null,
          lastErrorAt: receipt.lastErrorAt ?? state.health.model?.lastErrorAt ?? null,
        } } }))
      })
      signal.throwIfAborted()
      this.deps.assertWriter()
      await this.updateState( state => ({ ...state, researchRuns: state.researchRuns.map(entry => entry.id === run.id
        ? { ...bindResearchSession(entry, result.sessionId), state: 'completed', finishedAt: Date.now() } : entry) }))
    } catch (error) {
      this.deps.assertWriter()
      await this.updateState( state => ({ ...state, researchRuns: state.researchRuns.map(entry => entry.id === run.id
        ? { ...entry, state: 'failed', error: errorText(error).slice(0, 512), finishedAt: Date.now() } : entry) }))
      throw error
    }
  }
}

/** Keep the native Session identity stable after a run first publishes it. */
function bindResearchSession(run: ResearchRun, id: string): ResearchRun {
  if (run.sessionId !== null && run.sessionId !== id) throw new Error('Research run already identifies a different Session')
  return { ...run, sessionId: id }
}
