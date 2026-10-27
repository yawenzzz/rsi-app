/** Deployment-owned research, paper capital, data, and release limits. */

import { isAbsolute } from 'node:path'
import schema from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { z } from 'zod'
import type { LedgerConfig } from './execution/ledger-types.ts'
import type { MarketDataOptions } from './data/market.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MarketId } from './data/market.ts'
import type { ReleaseConfig } from './evolution/release-types.ts'
import type { JevConfig } from './judgment.ts'

/** Fully resolved deployment settings; capital limits govern paper accounting only. */
export interface Config {
  /** Persistent research objective; required, with at most 4096 characters. */
  objective: string
  /** Absolute anchor shared by every process opening this RSI storage namespace. */
  writerLeasePath: string
  /** Stale-lock recovery threshold in milliseconds; defaults to 30000, minimum 5000. */
  writerLeaseStaleMs: number
  /** Heartbeat milliseconds; defaults to 10000 and must not exceed half the stale threshold. */
  writerLeaseUpdateMs: number
  /** Start background polling when mounted; defaults to false. */
  autoTick: boolean
  /** Background poll interval in milliseconds; defaults to 60000. */
  tickIntervalMs: number
  /** Operator-console polling interval in milliseconds. */
  consolePollIntervalMs: number
  /** Maximum quote age in milliseconds; defaults to 30000. */
  maxObservationAgeMs: number
  /** Maximum age of a forecast used for a purchase, independent of quote age. */
  maxForecastAgeMs: number
  /** Bounds for immutable external research evidence. */
  evidence: {
    /** Maximum number of retained external source snapshots. */
    maxRecords: number
    /** Maximum UTF-8 bytes retained for one external source. */
    maxTextBytes: number
  }
  /** TypeSafe judgments over research state; credentials resolve when the tool runs. */
  jev: JevConfig
  /** Maximum retained market observations; defaults to 20000. */
  maxObservations: number
  /** Maximum retained nonfinancial decision records; capacity fails without deleting evidence. */
  maxDecisionRecords: number
  /** Retained history window used by the console's price-change correlations. */
  correlationWindowMs: number
  /** Time bucket for comparing category price changes. */
  correlationBucketMs: number
  /** Minimum paired bucket changes required to show a correlation. */
  correlationMinSamples: number
  /** Maximum category groups returned by the correlation view. */
  correlationMaxGroups: number
  /** Maximum recent records in status responses; defaults to 10, maximum 100. */
  statusLimit: number
  /** Complete tool response byte budget; defaults to 32768, minimum 256. */
  maxToolOutputBytes: number
  /** Additional paper execution allowance in basis points; defaults to 50. */
  paperSlippageBps: number
  /** Delay before refreshing a paper execution quote, in milliseconds; defaults to 1000. */
  paperExecutionDelayMs: number
  /** Public Gamma/CLOB endpoints and bounded HTTP requests. */
  data: MarketDataOptions
  /** Required explicit paper allocation; per-event exposure must fit total exposure and initial capital. */
  ledger: LedgerConfig
  /** Prospective evidence requirements and immutable research capacity. */
  experiments: {
    /** Independent resolved events needed for evaluation; defaults to 30. */
    minResolvedEvents: number
    /** Lifetime candidate budget used in multiplicity correction; defaults to 16. */
    maxCandidates: number
    /** Maximum retained forecasts; defaults to 10000. */
    maxForecasts: number
    /** Total false-promotion probability allowance, strictly between zero and one; defaults to 0.05. */
    confidenceAlpha: number
    /** Maximum evidence bytes per record; defaults to 8192. */
    maxEvidenceBytes: number
  }
  /** Background model research budget; the working directory is always explicit. */
  research: {
    /** Enable scheduled model research; defaults to false. */
    enabled: boolean
    /** Minimum research interval in milliseconds; defaults to 3600000. */
    intervalMs: number
    /** UTC-day model-run limit; defaults to 4. */
    maxRunsPerDay: number
    /** Per-run deadline in milliseconds; defaults to 120000. */
    timeoutMs: number
    /** Generated token limit per model request; defaults to 4096. */
    maxOutputTokens: number
    /** Absolute working directory for research sessions. */
    cwd: string
  }
  /** Optional local candidate validation; omission disables release validation. */
  releases?: ReleaseConfig | undefined
}

const integer = () => schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
const milliseconds = () => integer().max(MAX_TIMER_DELAY_MS)

/** Loader metadata and the sole owner of deployment defaults. Cross-field checks run in resolveConfig. */
export const Config: schema<Config> = schema.object({
  objective: schema.string().min(1).max(4096).required().description('Research objective; surrounding whitespace is removed.'),
  writerLeasePath: schema.string().required().description('Absolute shared writer-lease anchor path.'),
  writerLeaseStaleMs: milliseconds().min(5000).default(30_000).description('Stale writer-lease threshold in milliseconds.'),
  writerLeaseUpdateMs: milliseconds().min(1000).default(10_000).description('Heartbeat milliseconds; at most half the stale threshold.'),
  autoTick: schema.boolean().default(false).description('Poll market data automatically while mounted.'),
  tickIntervalMs: milliseconds().default(60_000).description('Background polling interval in milliseconds.'),
  consolePollIntervalMs: milliseconds().min(1000).default(3000).description('Operator-console status polling interval in milliseconds.'),
  maxObservationAgeMs: milliseconds().default(30_000).description('Maximum accepted quote age in milliseconds.'),
  maxForecastAgeMs: milliseconds().default(3_600_000).description('Maximum accepted forecast age in milliseconds; quotes refresh independently.'),
  evidence: schema.object({
    maxRecords: integer().default(10_000).description('Maximum retained external evidence snapshots.'),
    maxTextBytes: integer().default(131_072).description('Maximum UTF-8 bytes in one retained source text.'),
  }).description('Immutable external research evidence capacity.'),
  jev: schema.object({
    baseUrl: schema.string().default('https://api.typesafe.ai').description('TypeSafe API root; credentials are sent only to this configured endpoint.'),
    model: schema.string().min(1).default('jev-1.13.0').description('Jev model version or provider alias.'),
    apiKeyEnv: schema.string().default('TYPESAFE_API_KEY').role('credential-ref').description('Credential reference for the TypeSafe API key, editable in Settings > Jev.'),
    timeoutMs: milliseconds().default(15_000).description('Complete Jev request deadline in milliseconds; automatic retries are disabled.'),
    maxInputBytes: integer().default(131_072).description('Maximum UTF-8 bytes for the complete Jev request.'),
    maxResponseBytes: integer().default(131_072).description('Maximum Jev HTTP response bytes.'),
    maxQuestions: integer().default(32).description('Maximum independent judgments in one Jev request.'),
  }).description('TypeSafe Jev research judgments and request limits.'),
  maxObservations: integer().default(20_000).description('Maximum retained market observations.'),
  maxDecisionRecords: integer().default(50_000).description('Maximum retained scan and rejection records.'),
  correlationWindowMs: integer().default(2_592_000_000).description('Correlation history window in milliseconds.'),
  correlationBucketMs: integer().default(3_600_000).description('Correlation sampling bucket in milliseconds.'),
  correlationMinSamples: integer().min(2).default(30).description('Minimum paired price changes for correlation.'),
  correlationMaxGroups: integer().max(16).default(8).description('Maximum category correlation groups.'),
  statusLimit: integer().max(100).default(10).description('Maximum recent records returned in status.'),
  maxToolOutputBytes: integer().min(256).default(32_768).description('Complete serialized tool response byte limit.'),
  paperSlippageBps: schema.number().step(1).min(0).max(10_000).default(50).description('Paper execution slippage allowance in basis points.'),
  paperExecutionDelayMs: milliseconds().default(1000).description('Milliseconds before refreshing a proposed paper purchase quote.'),
  data: schema.object({
    gammaUrl: schema.string().default('https://gamma-api.polymarket.com').description('Public Gamma HTTP(S) base URL.'),
    clobUrl: schema.string().default('https://clob.polymarket.com').description('Public CLOB HTTP(S) base URL.'),
    timeoutMs: milliseconds().default(15_000).description('HTTP deadline including queue wait and body receipt, in milliseconds.'),
    maxMarkets: integer().max(1000).default(20).description('Maximum Gamma rows inspected per discovery, including rejected rows.'),
    marketIds: schema.array(schema.transform(schema.string().min(1), brandString<MarketId>)).default([])
      .description('Explicit market watchlist; empty selects bounded active-market discovery.'),
    concurrency: integer().max(32).default(4).description('Maximum simultaneous public-data requests.'),
    maxResponseBytes: integer().default(2_000_000).description('Maximum bytes in each complete HTTP response body.'),
  }).description('Public market data sources and request limits.'),
  ledger: schema.object({
    initialCapitalMicros: integer().required().description('Initial paper capital in integer micro dollars.'),
    perEventLimitMicros: integer().required().description('Maximum aggregate event cost; at most totalExposureLimitMicros.'),
    totalExposureLimitMicros: integer().required().description('Maximum total committed cost; at most initialCapitalMicros.'),
    maxDrawdownMicros: integer().required().description('Maximum paper drawdown; at most initialCapitalMicros.'),
    maxAuditEntries: integer().default(100).description('Recent activity limit; financial receipts remain retained.'),
  }).required().description('Explicit paper allocation and risk limits, fixed on first open.'),
  experiments: schema.object({
    minResolvedEvents: integer().default(30).description('Minimum independent resolved events for promotion evaluation.'),
    maxCandidates: integer().default(16).description('Lifetime candidate limit included in multiplicity correction.'),
    maxForecasts: integer().default(10_000).description('Maximum retained prospective forecasts.'),
    confidenceAlpha: schema.number().min(0).max(1).default(0.05).description('Total false-promotion allowance, strictly between zero and one.'),
    maxEvidenceBytes: integer().default(8192).description('Maximum evidence bytes per record.'),
  }).description('Prospective research capacity and fixed evaluation policy.'),
  research: schema.object({
    enabled: schema.boolean().default(false).description('Enable scheduled model research.'),
    intervalMs: milliseconds().default(3_600_000).description('Minimum research interval in milliseconds.'),
    maxRunsPerDay: integer().default(4).description('Maximum model research runs per UTC day.'),
    timeoutMs: milliseconds().default(120_000).description('Per-run model research deadline in milliseconds.'),
    maxOutputTokens: integer().default(4096).description('Maximum generated tokens per model request.'),
    cwd: schema.string().required().description('Absolute working directory for research sessions.'),
  }).required().description('Model research schedule, cost limits, and working directory.'),
  releases: schema.union([schema.const(undefined), schema.object({
    repositoryPath: schema.string().required().description('Absolute local repository path containing candidate commits.'),
    worktreeRoot: schema.string().required().description('Absolute parent directory for detached validation worktrees.'),
    checks: schema.array(schema.object({
      name: schema.string().min(1).required().description('Unique check name retained in validation evidence.'),
      command: schema.string().min(1).required().description('Deployment-owned executable; never supplied by a model tool.'),
      args: schema.array(schema.string()).required().description('Literal arguments passed to the executable.'),
    })).min(1).required().description('At least one deployment-owned candidate validation command.'),
    commandTimeoutMs: milliseconds().default(300_000).description('Per-command validation deadline in milliseconds.'),
    terminationGraceMs: milliseconds().default(3000).description('Grace period before terminating a validation process, in milliseconds.'),
    maxOutputBytes: integer().min(256).default(16_384).description('Retained validation output byte budget.'),
  })]).description('Optional detached Git candidate validation; does not deploy code.'),
})

const positiveInteger = z.number().int().positive()
const duration = positiveInteger.max(MAX_TIMER_DELAY_MS)
const absolutePath = z.string().min(1).refine(isAbsolute, 'Path must be absolute')
const httpUrl = z.url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol), 'URL must use HTTP or HTTPS')

/** Strict fully resolved settings validation, including paper risk and writer-lease relationships. */
export const configSchema: z.ZodType<Config> = z.strictObject({
  objective: z.string().trim().min(1).max(4096),
  writerLeasePath: absolutePath,
  writerLeaseStaleMs: duration.min(5000),
  writerLeaseUpdateMs: duration.min(1000),
  autoTick: z.boolean(),
  tickIntervalMs: duration,
  consolePollIntervalMs: duration.min(1000),
  maxObservationAgeMs: duration,
  maxForecastAgeMs: duration,
  evidence: z.strictObject({ maxRecords: positiveInteger, maxTextBytes: positiveInteger }),
  jev: z.strictObject({
    baseUrl: httpUrl.refine((value) => {
      const url = new URL(value)
      return !url.username && !url.password && !url.search && !url.hash
    }, 'Jev base URL must not contain credentials, a query, or a fragment'),
    model: z.string().trim().min(1), apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    timeoutMs: duration, maxInputBytes: positiveInteger, maxResponseBytes: positiveInteger, maxQuestions: positiveInteger,
  }),
  maxObservations: positiveInteger,
  maxDecisionRecords: positiveInteger,
  correlationWindowMs: positiveInteger,
  correlationBucketMs: positiveInteger,
  correlationMinSamples: positiveInteger.min(2),
  correlationMaxGroups: positiveInteger.max(16),
  statusLimit: positiveInteger.max(100),
  maxToolOutputBytes: positiveInteger.min(256),
  paperSlippageBps: z.number().int().min(0).max(10_000),
  paperExecutionDelayMs: duration,
  data: z.strictObject({
    gammaUrl: httpUrl, clobUrl: httpUrl, timeoutMs: duration,
    maxMarkets: positiveInteger.max(1000), marketIds: z.array(z.string().regex(/^\d+$/).transform(brandString<MarketId>)),
    concurrency: positiveInteger.max(32), maxResponseBytes: positiveInteger,
  }),
  ledger: z.strictObject({
    initialCapitalMicros: positiveInteger,
    perEventLimitMicros: positiveInteger,
    totalExposureLimitMicros: positiveInteger,
    maxDrawdownMicros: positiveInteger,
    maxAuditEntries: positiveInteger,
  }).refine(value => value.perEventLimitMicros <= value.totalExposureLimitMicros
    && value.totalExposureLimitMicros <= value.initialCapitalMicros
    && value.maxDrawdownMicros <= value.initialCapitalMicros,
  'Paper limits must fit initial capital and per-event exposure must fit total exposure'),
  experiments: z.strictObject({
    minResolvedEvents: positiveInteger, maxCandidates: positiveInteger, maxForecasts: positiveInteger,
    confidenceAlpha: z.number().gt(0).lt(1), maxEvidenceBytes: positiveInteger,
  }),
  research: z.strictObject({
    enabled: z.boolean(), intervalMs: duration, maxRunsPerDay: positiveInteger,
    timeoutMs: duration, maxOutputTokens: positiveInteger, cwd: absolutePath,
  }),
  releases: z.strictObject({
    repositoryPath: absolutePath,
    worktreeRoot: absolutePath,
    checks: z.array(z.strictObject({
      name: z.string().trim().min(1), command: z.string().trim().min(1), args: z.array(z.string()),
    })).min(1).refine(checks => new Set(checks.map(check => check.name)).size === checks.length, 'Release check names must be unique'),
    commandTimeoutMs: duration, terminationGraceMs: duration, maxOutputBytes: positiveInteger.min(256),
  }).optional(),
}).refine(value => value.correlationWindowMs >= value.correlationBucketMs, 'Correlation window must contain at least one bucket')
  .refine(value => value.writerLeaseUpdateMs <= value.writerLeaseStaleMs / 2,
    'writerLeaseUpdateMs must not exceed half of writerLeaseStaleMs')

/**
 * Resolve one deployment configuration before effects, storage, or network requests.
 * Schemastery fills missing or null defaulted fields; required fields cannot be null.
 * Unknown settings and invalid relationships reject through the strict validator.
 * @param input - Loader configuration or a programmatic deployment request.
 * @returns Fully resolved settings with every deployment default applied once.
 */
export function resolveConfig(input: unknown): Config {
  const resolved: unknown = schema.resolve(input, Config, {})[0]
  return configSchema.parse(resolved)
}

import { Context, Service } from '@deepseek-ai/cordis'
import { installPaperRpc } from './rpc.ts'
import type { RsiStatus } from './runtime-types.ts'
import type { TickResult } from './runtime.ts'
import type { LedgerControl } from './execution/ledger-types.ts'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-web'
import { MarketDataClient } from './data/market.ts'
import { RsiRuntime } from './runtime.ts'
import { createResearchDriver } from './research-driver.ts'
import { createReleaseValidator, openReleaseStore } from './evolution/releases.ts'
import type { ReleaseRecordStore, ReleaseValidator } from './evolution/release-types.ts'
import { installTools } from './tools.ts'
import { acquireWriterLease } from './writer-lease.ts'
import type { WriterLease } from './writer-lease.ts'
import { queryOverview } from './queries/overview.ts'
import type { OperationalState } from './runtime/operations.ts'
import { queryOpportunities, queryOpportunity } from './queries/opportunities.ts'
import { queryStrategies, queryStrategy } from './queries/strategies.ts'
import { queryRisk, queryPosition } from './queries/portfolio.ts'
import { queryDecisions, queryDecision } from './queries/decisions.ts'
import type { CandidateId } from './strategy/experiment-schema.ts'
import type { TokenId } from './data/market.ts'
import type {
  OverviewView, OpportunityQuery, OpportunityPage, OpportunityDetail, ConsolePage,
  StrategyView, StrategyDetail, RiskView, PositionDetail, DecisionQuery, DecisionView, DecisionDetail, DecisionId,
} from './queries/types.ts'


declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Shared single-host research, paper control and retained-evidence service. */
    rsi: RsiService
  }
}

/** Ready host service; tool results are the only model-visible projection of its records. */
export class RsiService extends Service {
  static inject = ['storageDomain', 'tools']
  static Config = Config
  private readonly config: Config
  private current: RsiRuntime | undefined

  /**
   * Validate deployment settings before acquiring process ownership.
   * @param ctx - Plugin scope owning all tools and asynchronous work.
   * @param config - Loader settings for public data, research and paper capital.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'rsi')
    this.config = resolveConfig(config)
    ctx.inject(['connection'], (scope) => { installPaperRpc(scope, this, this.config.maxToolOutputBytes) })
  }

  /**
   * Access the fully initialized runtime for scheduler integrations.
   * @returns the same host-owned runtime used by chat tools.
   */
  get runtime(): RsiRuntime {
    if (this.current === undefined) throw new Error('RSI research is not initialized')
    return this.current
  }

  /**
   * Read the Jev credential reference and model without exposing a secret.
   * @returns deployment-selected reference for the shared credential settings editor.
   */
  remoteJevSettings(): { apiKeyEnv: string; model: string } {
    return { apiKeyEnv: this.config.jev.apiKeyEnv, model: this.config.jev.model }
  }

  /**
   * Read the product's shared research and account state.
   * @returns current status for the operator console.
   */
  remoteStatus(): RsiStatus {
    return this.runtime.status()
  }

  /**
   * Read the dashboard.
   * @returns current overview derived from committed research and financial records.
   */
  remoteOverview(): OverviewView { return queryOverview(this.runtime.consoleSource()) }

  /**
   * Search the latest observation for each outcome token.
   * @param query - Validated filters and bounded cursor pagination.
   * @returns latest outcome-token opportunities.
   */
  remoteOpportunities(query: OpportunityQuery): OpportunityPage {
    return queryOpportunities(this.runtime.consoleSource(), query)
  }

  /**
   * Inspect an immutable market observation.
   * @param id - Immutable observation reference.
   * @returns full retained market evidence and the current sizing explanation.
   */
  remoteOpportunity(id: string): OpportunityDetail { return queryOpportunity(this.runtime.consoleSource(), id) }

  /**
   * Compare recorded candidates.
   * @returns all bounded immutable strategy versions and evaluated scores.
   */
  remoteStrategies(): StrategyView[] { return queryStrategies(this.runtime.consoleSource()) }

  /**
   * Inspect one candidate and its prospective history.
   * @param id - Immutable candidate identity.
   * @returns score history and recent prospective forecast receipts.
   */
  remoteStrategy(id: CandidateId): StrategyDetail { return queryStrategy(this.runtime.consoleSource(), id) }

  /**
   * Read the paper account.
   * @returns exact paper capital, limits, positions and exposure attribution.
   */
  remoteRisk(): RiskView { return queryRisk(this.runtime.consoleSource()) }

  /**
   * Inspect a held token's original purchases.
   * @param id - Held outcome token.
   * @returns original financial lots backing the holding.
   */
  remotePosition(id: TokenId): PositionDetail { return queryPosition(this.runtime.consoleSource(), id) }

  /**
   * Search the unified decision timeline.
   * @param query - Event kinds, search and bounded cursor pagination.
   * @returns a unified timeline of committed facts.
   */
  remoteDecisions(query: DecisionQuery): ConsolePage<DecisionView> { return queryDecisions(this.runtime.consoleSource(), query) }

  /**
   * Inspect one event's retained receipts.
   * @param id - Stable namespaced decision reference.
   * @returns exact source references and recorded evidence.
   */
  remoteDecision(id: DecisionId): DecisionDetail { return queryDecision(this.runtime.consoleSource(), id) }

  /**
   * Commit the operator's emergency admission control.
   * @param revision - Exact operational revision shown by the overview.
   * @param stopped - Desired emergency state.
   * @param reason - Operator reason retained for audit.
   * @returns durable admission state; resume does not authorize paper purchases.
   */
  remoteOperations(revision: number, stopped: boolean, reason: string): Promise<OperationalState> {
    return this.runtime.changeOperations(revision, stopped, reason)
  }

  /**
   * Refresh public observations and reconcile the shared account.
   * @returns the committed batch outcome.
   */
  remoteRefresh(): Promise<TickResult> {
    return this.runtime.tick()
  }

  /**
   * Change paper purchase permission without changing research permissions.
   * @param command - Exact current control revision and requested action.
   * @returns status after the durable control change.
   */
  remoteControl(command: LedgerControl): Promise<RsiStatus> {
    return this.runtime.control(command)
  }

  /**
   * Pause or resume the research scheduler.
   * @param paused - Whether new research must stop and the current run must cancel.
   * @returns durable research permission and latest account status.
   */
  remoteResearch(paused: boolean): Promise<RsiStatus> {
    return this.runtime.pauseResearch(paused)
  }

  /**
   * Replace the operator's objective and pause purchases based on the prior objective.
   * @param expectedRevision - Exact directive revision displayed in the console.
   * @param objective - Complete new objective, between one and 4096 characters.
   * @returns the committed objective and directive revision.
   */
  remoteObjective(expectedRevision: number, objective: string): Promise<RsiStatus> {
    return this.runtime.changeObjective(expectedRevision, objective)
  }

  protected async [Service.init](): Promise<void> {
    let lease: WriterLease | undefined
    let releaseStore: ReleaseRecordStore | undefined
    let releases: ReleaseValidator | undefined
    let runtime: RsiRuntime | undefined
    const close = async () => {
      const results = await Promise.allSettled([runtime?.close(), releases?.dispose()])
      const failures = results.flatMap((result): unknown[] => {
        if (result.status !== 'rejected') return []
        const reason: unknown = result.reason
        return [reason]
      })
      if (failures.length) throw new AggregateError(failures, 'RSI runtime disposal failed')
      await releaseStore?.close()
      await lease?.release()
    }
    try {
      lease = await acquireWriterLease({
        path: this.config.writerLeasePath, staleMs: this.config.writerLeaseStaleMs, updateMs: this.config.writerLeaseUpdateMs,
      }, (error) => {
        this.ctx.logger.error(error)
        void close().catch((failure: unknown) => { this.ctx.logger.error(failure) })
      })
      const writer = lease
      if (this.config.research.enabled && this.ctx.get('agentDefaultModel') === undefined) {
        throw new Error('Autonomous research requires a configured default model')
      }
      if (this.config.releases !== undefined) {
        const subprocess = this.ctx.get('subprocess')
        if (subprocess === undefined) throw new Error('Release validation requires the subprocess service')
        releaseStore = await openReleaseStore(this.ctx.storageDomain, () => { writer.assertHeld() })
        releases = createReleaseValidator(this.config.releases, subprocess, releaseStore)
      }
      runtime = await RsiRuntime.open(this.config, {
        storageDomain: this.ctx.storageDomain,
        data: new MarketDataClient(this.config.data),
        releases: releaseStore ?? null,
        assertWriter: () =>{  writer.assertHeld() },
        ...(this.config.research.enabled ? { researchDriver: createResearchDriver(this.ctx, this.config) } : {}),
        fetchEvidence: async (url, signal) => {
          const web = this.ctx.get('web')
          if (web === undefined) throw new Error('Source capture requires the Web service')
          return await web.fetch({ url }, signal)
        },
        reportError: (error) =>{  this.ctx.logger.warn(error) },
      })
      this.current = runtime
      this.ctx.effect(() => close, 'rsi.close')
      installTools(this.ctx, runtime, releases)
      runtime.start()
    } catch (error) {
      await close()
      throw error
    }
  }
}

export default RsiService
