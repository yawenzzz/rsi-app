/** Provider settings inheritance uses only published DSH services and retains credential references. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ReasoningEffortId, type LlmCallConfig, type LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type { SettingsDescriptor, SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { expect, it, onTestFinished, vi } from 'vitest'
import { captureAgentDefaults, type AgentModelOptions } from '../src/harness/model-config.ts'

function descriptor(ns: string, value: unknown): SettingsDescriptor {
  return { ns: brandString<SettingsNamespace>(ns), value, revision: 1, schema: {}, applies: 'live', autoGenerate: false }
}

async function fixture(provider: string, namespace: string, value: unknown, directory?: LlmConfigurableProvider,
  environment: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-provider-inheritance-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  })
  const selection: LlmCallConfig = { provider, model: 'fixture-model', reasoningEffort: ReasoningEffortId('medium') }
  const descriptors = [descriptor('agent-default-model', selection), descriptor(namespace, value)]
  const resolveCallConfig = vi.fn(async (input: LlmCallConfig) => input)
  const credentialFiber = { state: ctx.fiber.state, config: { path: join(root, 'shared-credentials.yaml') } }
  const credentialEntry = { id: 'credentials', options: { id: 'credentials', name: '@deepseek-ai/dsh-credentials-local' },
    parent: { tree: { ctx } }, disabled: false, fiber: credentialFiber }
  const install = join(root, 'installation')
  const profile = join(root, 'profile')
  await mkdir(install)
  await mkdir(profile)
  await writeFile(join(install, 'package.json'), JSON.stringify({ name: 'fixture-dsh', version: '1.0.0' }))
  ctx.provide('agentDefaultModel', { currentSelection: () => selection })
  ctx.provide('settings', { describe: () => descriptors })
  ctx.provide('llm', { listConfigurableProviders: () => directory === undefined ? [] : [directory], resolveCallConfig })
  ctx.provide('loader', { entries: () => [credentialEntry] })
  ctx.provide('profileContext', { dir: profile, home: join(root, 'home'), installAnchor: join(install, 'package.json') })
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: environment }]))
  const options: AgentModelOptions = { credentialEnv: [], modelProviders: [] }
  return { root, ctx, selection, descriptors, resolveCallConfig, credentialFiber, credentialEntry, install, profile, options }
}

it('retains a custom pi-ai provider catalog and model overrides without the private resolver', async () => {
  const source = { apiKeyEnv: 'ACME_API_KEY', api: 'openai-responses', baseURL: 'https://models.example/v1',
    modelOverrides: { 'fixture-model': { contextWindow: 872000, maxTokens: 128000 } }, streamIdleTimeoutMs: 900000 }
  const f = await fixture('acme', 'custom-models', { providers: { acme: source, other: { apiKeyEnv: 'OTHER_API_KEY' } } }, {
    provider: 'acme', displayName: 'Acme', settingsNs: 'custom-models', settingsPath: ['providers', 'acme'], declared: true,
  })
  const inherited = await captureAgentDefaults(f.ctx, f.options, new AbortController().signal)
  expect(inherited.settings['custom-models']).toEqual({ providers: { acme: source } })
  expect(inherited.credentialEnv).toEqual(['ACME_API_KEY'])
  expect(inherited.settings.credentials).toEqual({ path: f.credentialFiber.config.path, watch: false })
  expect(inherited.provider).toBe('acme')
  expect(inherited.reasoningEffort).toBe('medium')
  source.modelOverrides['fixture-model'].contextWindow = 272000
  expect(inherited.settings['custom-models']).toMatchObject({ providers: { acme: { modelOverrides: { 'fixture-model': { contextWindow: 872000 } } } } })
})

it('retains catalog-native authentication and endpoint environment references without credential values', async () => {
  const f = await fixture('azure', 'llm-pi-ai', { providers: { azure: { models: [{ id: 'fixture-model' }] } } }, {
    provider: 'azure', displayName: 'Azure', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'azure'],
    nativeAuth: { env: ['AZURE_OPENAI_API_KEY'], oauth: false }, baseURLEnv: ['AZURE_OPENAI_BASE_URL'],
  })
  const inherited = await captureAgentDefaults(f.ctx, f.options, new AbortController().signal)
  expect(inherited.credentialEnv).toEqual(['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_BASE_URL'])
  expect(inherited.settings['llm-pi-ai']).toEqual({ providers: { azure: { models: [{ id: 'fixture-model' }] } } })
})

it('inherits Codex subscription preferences and the active credential location', async () => {
  const preferences = { contextMode: 'custom', customContextModels: { 'gpt-6-astra': 872000 }, speedMode: 'standard' }
  const f = await fixture('openai-codex', 'codex-subscription', preferences)
  const bundle = 'fixture-codex-bundle'
  const directory = join(f.install, 'node_modules', bundle)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: bundle, version: '1.2.3' }))
  f.options.modelProviders = [{ provider: 'openai-codex', settingsNamespace: 'codex-subscription', bundle }]
  const inherited = await captureAgentDefaults(f.ctx, f.options, new AbortController().signal)
  expect(inherited.settings['codex-subscription']).toEqual(preferences)
  expect(inherited.settings.credentials).toEqual({ path: f.credentialFiber.config.path, watch: false })
  expect(inherited.modelBundles).toEqual([{ name: bundle, version: '1.2.3', directory }])
  expect(inherited.credentialEnv).toEqual([])
})

it('uses the public DeepSeek API-key resolver for launch-time endpoint defaults', async () => {
  const f = await fixture('deepseek-official', 'llm-deepseek', { apiKeyEnv: 'DEEPSEEK_API_KEY' }, {
    provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [],
  }, {
    DEEPSEEK_BASE_URL: 'https://deepseek.example', DEEPSEEK_API_KEY: 'not-for-profile-storage',
  })
  const inherited = await captureAgentDefaults(f.ctx, f.options, new AbortController().signal)
  expect(inherited.settings['llm-deepseek']).toMatchObject({ apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://deepseek.example' })
  expect(inherited.credentialEnv).toEqual(['DEEPSEEK_API_KEY'])
  expect(JSON.stringify(inherited)).not.toContain('not-for-profile-storage')
})

it('keeps DeepSeek account model overrides, account settings and credentials together', async () => {
  const f = await fixture('deepseek-account', 'llm-deepseek-account', {
    modelOverrides: { 'fixture-model': { contextWindow: 1000000 } },
  }, { provider: 'deepseek-account', displayName: 'DeepSeek Account', settingsNs: 'llm-deepseek-account', settingsPath: [] })
  f.descriptors.push(descriptor('deepseek-account', { inferenceOrigin: 'https://api.deepseek.com', platformOrigin: 'https://platform.deepseek.com' }))
  const inherited = await captureAgentDefaults(f.ctx, f.options, new AbortController().signal)
  expect(inherited.settings['llm-deepseek-account']).toMatchObject({ modelOverrides: { 'fixture-model': { contextWindow: 1000000 } } })
  expect(inherited.settings['deepseek-account']).toMatchObject({ inferenceOrigin: 'https://api.deepseek.com' })
  expect(inherited.settings.credentials).toEqual({ path: f.credentialFiber.config.path, watch: false })
  expect(inherited.credentialEnv).toEqual([])
})

it.each([
  { apiKey: 'inline-secret', apiKeyEnv: 'ACME_KEY' },
  { apiKeyEnv: 'ACME_KEY', headers: { Authorization: 'inline-secret' } },
  { apiKeyEnv: 'ACME_KEY', baseURL: 'https://user:password@example.com' },
])('rejects inline credentials before any model resolution', async source => {
  const f = await fixture('acme', 'llm-pi-ai', { providers: { acme: source } })
  await expect(captureAgentDefaults(f.ctx, f.options, new AbortController().signal)).rejects.toThrow(/secret|headers|credentials/)
  expect(f.resolveCallConfig).not.toHaveBeenCalled()
})

it('refuses a stale provider revision after asynchronous model validation', async () => {
  const f = await fixture('acme', 'llm-pi-ai', { providers: { acme: { apiKeyEnv: 'ACME_KEY' } } })
  const validation = Promise.withResolvers<LlmCallConfig>()
  f.resolveCallConfig.mockImplementationOnce(() => validation.promise)
  const pending = captureAgentDefaults(f.ctx, f.options, new AbortController().signal)
  await vi.waitFor(() => { expect(f.resolveCallConfig).toHaveBeenCalledOnce() })
  f.descriptors[1]!.revision++
  validation.resolve(f.selection)
  await expect(pending).rejects.toThrow('Settings changed')
})

it('refuses a replaced credential provider while model validation is outstanding', async () => {
  const f = await fixture('acme', 'llm-pi-ai', { providers: { acme: { apiKeyEnv: 'ACME_KEY' } } })
  const validation = Promise.withResolvers<LlmCallConfig>()
  f.resolveCallConfig.mockImplementationOnce(() => validation.promise)
  const pending = captureAgentDefaults(f.ctx, f.options, new AbortController().signal)
  await vi.waitFor(() => { expect(f.resolveCallConfig).toHaveBeenCalledOnce() })
  f.credentialEntry.fiber = { state: f.ctx.fiber.state, config: { path: join(f.root, 'replacement.yaml') } }
  validation.resolve(f.selection)
  await expect(pending).rejects.toThrow('Settings changed')
})
