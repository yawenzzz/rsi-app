/** Deployment defaults, discoverable settings, and rejected risk/configuration inputs. */
import { resolve } from 'node:path'
import schema from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { describe, expect, it } from 'vitest'
import { Config, configSchema, resolveConfig } from '../../src/runtime/config.ts'

const cwd = resolve('config-fixture-research')
const writerLeasePath = resolve('config-fixture-writer.lock')
const base = () => ({
  objective: 'Measure prospective net advantage', writerLeasePath,
  ledger: {
    initialCapitalMicros: 100_000_000, perEventLimitMicros: 1_000_000,
    totalExposureLimitMicros: 5_000_000, maxDrawdownMicros: 2_000_000,
  },
  research: { cwd },
})
const release = () => ({
  repositoryPath: resolve('config-fixture-repository'), worktreeRoot: resolve('config-fixture-worktrees'),
  checks: [{ name: 'behavior', command: 'node', args: ['--version'] }],
})

describe('resolveConfig', () => {
  it('resolves deployment defaults and keeps the account allocation explicit', () => {
    const input = base()
    const before = structuredClone(input)
    const result = resolveConfig(input)
    expect(result).toEqual({
      objective: input.objective, writerLeasePath, writerLeaseStaleMs: 30_000, writerLeaseUpdateMs: 10_000,
      autoTick: false, tickIntervalMs: 60_000, consolePollIntervalMs: 3000, maxObservationAgeMs: 30_000, maxObservations: 20_000,
      maxForecastAgeMs: 3_600_000, evidence: { maxRecords: 10_000, maxTextBytes: 131_072 },
      jev: { baseUrl: 'https://api.typesafe.ai', model: 'jev-1.13.0', apiKeyEnv: 'TYPESAFE_API_KEY',
        timeoutMs: 15_000, maxInputBytes: 131_072, maxResponseBytes: 131_072, maxQuestions: 32 },
      statusLimit: 10, maxDecisionRecords: 50_000, maxToolOutputBytes: 32_768, paperSlippageBps: 50, paperExecutionDelayMs: 1000,
      correlationWindowMs: 2_592_000_000, correlationBucketMs: 3_600_000, correlationMinSamples: 30, correlationMaxGroups: 8,
      data: { gammaUrl: 'https://gamma-api.polymarket.com', clobUrl: 'https://clob.polymarket.com', timeoutMs: 15_000, maxMarkets: 20, marketIds: [], concurrency: 4, maxResponseBytes: 2_000_000 },
      ledger: { ...input.ledger, maxAuditEntries: 100 },
      experiments: { minResolvedEvents: 30, maxCandidates: 16, maxForecasts: 10_000, confidenceAlpha: 0.05, maxEvidenceBytes: 8192 },
      research: { enabled: false, intervalMs: 3_600_000, maxRunsPerDay: 4, timeoutMs: 120_000, maxOutputTokens: 4096, cwd },
    })
    expect(input).toEqual(before)
    expect(configSchema.parse(result)).toEqual(result)
    expect(resolveConfig(result)).toEqual(result)
  })

  it('uses identical defaults through Loader and programmatic entry, including nullable defaults', () => {
    const input = { ...base(), autoTick: null, data: { timeoutMs: null }, objective: '  Measure prospective returns  ' }
    const loaded: unknown = schema.resolve(input, Config, {})[0]
    expect(resolveConfig(loaded)).toEqual(resolveConfig(input))
    expect(resolveConfig(input)).toMatchObject({ autoTick: false, data: { timeoutMs: 15_000 }, objective: 'Measure prospective returns' })
  })

  it('retains explicit tunables and resolves optional release limits', () => {
    const result = resolveConfig({
      ...base(), autoTick: true, tickIntervalMs: 5000, writerLeaseStaleMs: 5000, writerLeaseUpdateMs: 2500,
      maxToolOutputBytes: 256, paperSlippageBps: 0, maxForecastAgeMs: 120_000,
      evidence: { maxRecords: 100, maxTextBytes: 4096 },
      data: { gammaUrl: 'http://localhost:9000/gamma', concurrency: 1, marketIds: ['123'] },
      experiments: { minResolvedEvents: 4, confidenceAlpha: 0.01 },
      research: { cwd, enabled: true, maxRunsPerDay: 2 }, releases: release(),
    })
    expect(result).toMatchObject({
      autoTick: true, tickIntervalMs: 5000, writerLeaseStaleMs: 5000, writerLeaseUpdateMs: 2500,
      maxToolOutputBytes: 256, paperSlippageBps: 0, maxForecastAgeMs: 120_000,
      evidence: { maxRecords: 100, maxTextBytes: 4096 },
      data: { gammaUrl: 'http://localhost:9000/gamma', concurrency: 1, marketIds: ['123'], clobUrl: 'https://clob.polymarket.com' },
      experiments: { minResolvedEvents: 4, confidenceAlpha: 0.01, maxCandidates: 16 },
      research: { enabled: true, maxRunsPerDay: 2, timeoutMs: 120_000 },
      releases: { ...release(), commandTimeoutMs: 300_000, terminationGraceMs: 3000, maxOutputBytes: 16_384 },
    })
  })

  it.each(['objective', 'writerLeasePath', 'ledger', 'research'])('rejects an absent required %s', (key) => {
    const input = Object.fromEntries(Object.entries(base()).filter(([property]) => property !== key))
    expect(() => resolveConfig(input)).toThrow()
  })

  it.each([
    { jev: { baseUrl: 'file:///private' } }, { jev: { baseUrl: 'https://user:secret@example.test' } },
    { jev: { baseUrl: 'https://example.test?key=secret' } }, { jev: { baseUrl: 'https://example.test#fragment' } },
    { jev: { apiKeyEnv: 'INVALID-KEY' } }, { jev: { model: ' ' } }, { jev: { timeoutMs: 0 } },
    { jev: { maxInputBytes: 0 } }, { jev: { maxResponseBytes: 0 } }, { jev: { maxQuestions: 0 } },
    { objective: '   ' }, { objective: 'x'.repeat(4097) }, { writerLeasePath: 'relative.lock' },
    { writerLeasePath: null }, { research: { cwd: 'relative' } }, { research: {} },
    { data: { gammaUrl: 'file:///etc/passwd' } }, { data: { clobUrl: 'bad-url' } },
    { maxToolOutputBytes: 255 }, { statusLimit: 101 }, { paperSlippageBps: -1 }, { paperSlippageBps: 10_001 },
    { maxDecisionRecords: 0 }, { correlationWindowMs: 0 }, { correlationBucketMs: 0 },
    { correlationMinSamples: 1 }, { correlationMaxGroups: 17 },
    { correlationWindowMs: 1000, correlationBucketMs: 2000 },
    { writerLeaseStaleMs: 4999 }, { writerLeaseUpdateMs: 999 },
    { writerLeaseStaleMs: 5000, writerLeaseUpdateMs: 2501 },
    { maxObservations: Number.MAX_SAFE_INTEGER + 1 }, { data: { concurrency: 33 } },
    { data: { maxMarkets: 1001 } }, { data: { maxResponseBytes: 0 } },
    { data: { marketIds: ['not-an-id'] } }, { evidence: { maxRecords: 0 } }, { evidence: { maxTextBytes: 0 } },
    { experiments: { confidenceAlpha: 0 } }, { experiments: { confidenceAlpha: 1 } },
  ])('rejects invalid deployment values: %j', (patch) => {
    expect(() => resolveConfig({ ...base(), ...patch })).toThrow()
  })

  it.each(['tickIntervalMs', 'maxObservationAgeMs', 'maxForecastAgeMs', 'paperExecutionDelayMs', 'writerLeaseStaleMs', 'writerLeaseUpdateMs'])(
    'rejects overflowing, fractional, and nonpositive %s', (key) => {
      for (const value of [MAX_TIMER_DELAY_MS + 1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => resolveConfig({ ...base(), [key]: value })).toThrow()
      }
    },
  )

  it.each([
    { perEventLimitMicros: 5_000_001 }, { totalExposureLimitMicros: 100_000_001 },
    { maxDrawdownMicros: 100_000_001 }, { initialCapitalMicros: 0 }, { perEventLimitMicros: 1.5 },
    { initialCapitalMicros: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects unsafe paper allocations: %j', (patch) => {
    expect(() => resolveConfig({ ...base(), ledger: { ...base().ledger, ...patch } })).toThrow()
  })

  it.each([
    { mode: 'live' }, { data: { unexpected: true } }, { experiments: { bypassValidation: true } },
    { ledger: { ...base().ledger, extraCapitalMicros: 1 } }, { research: { cwd, privateKey: 'not-a-key' } },
    { releases: { ...release(), autoDeploy: true } },
    { evidence: { trustSubmittedText: true } }, { jev: { apiKey: 'must-not-enter-config' } },
  ])('rejects unknown settings at every object level: %j', (patch) => {
    expect(() => resolveConfig({ ...base(), ...patch })).toThrow()
    expect(() => resolveConfig(schema.resolve({ ...base(), ...patch }, Config, {})[0])).toThrow()
  })

  it.each([
    { repositoryPath: 'relative' }, { worktreeRoot: 'relative' }, { checks: [] },
    { checks: [{ name: 'same', command: 'node', args: [] }, { name: 'same', command: 'node', args: [] }] },
    { checks: [{ name: 'same', command: 'node', args: [] }, { name: ' same ', command: 'node', args: [] }] },
    { checks: [{ name: ' ', command: 'node', args: [] }] },
    { checks: [{ name: 'check', command: ' ', args: [] }] },
    { checks: [{ name: 'check', command: 'node', args: [], shell: true }] },
    { commandTimeoutMs: MAX_TIMER_DELAY_MS + 1 }, { terminationGraceMs: 0 }, { maxOutputBytes: 255 },
  ])('rejects unsafe release validation settings: %j', (patch) => {
    expect(() => resolveConfig({ ...base(), releases: { ...release(), ...patch } })).toThrow()
  })

  it('exposes every deployment field as a documented Schemastery object node', () => {
    expect(Config.type).toBe('object')
    const visit = (node: schema, value: object) => {
      expect(node.dict).toBeDefined()
      const entries: Array<[string, unknown]> = Object.entries(value)
      for (const [key, entry] of entries) {
        const field = node.dict![key]!
        expect(field.meta.description, key).toBeTruthy()
        expect(field.type, key).not.toBe('any')
        if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
          visit(field.type === 'union' ? field.list!.find(member => member.type === 'object')! : field, entry)
        }
      }
    }
    visit(Config, resolveConfig({ ...base(), releases: release() }))
    expect(Config.dict!.writerLeasePath!.meta.required).toBe(true)
    expect(Config.dict!.writerLeaseStaleMs!.meta.default).toBe(30_000)
    expect(Config.dict!.research!.dict!.cwd!.meta.required).toBe(true)
  })
})
