/** Inherit public provider configuration for the same installed DSH runtime, retaining credential references only. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { resolveAdapterOptions, type Options as DeepSeekOptions } from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { resolveAdapterOptions as resolveDeepSeekProtocol, type Options as DeepSeekProtocolOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { resolveBundleDir } from '@deepseek-ai/dsh-app-boot'
import { resolveSpec as resolveCredentialFile } from '@deepseek-ai/dsh-credentials-local'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { readPluginInventory } from '@deepseek-ai/dsh-host-plugin-inventory'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-llm'
/** Model defaults captured only when a project profile is first created. */
export interface AgentModelOptions {
  provider?: string
  model?: string
  reasoningEffort?: string
  credentialEnv: string[]
  modelProviders: { provider: string; settingsNamespace: string; bundle: string }[]
}

const bindingSchema = z.strictObject({
  format: z.literal(1), provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().optional(),
  credentialEnv: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)),
  settings: z.record(z.string(), z.record(z.string(), z.unknown())),
  modelBundles: z.array(z.strictObject({ name: z.string().min(1), version: z.string().min(1), directory: z.string().min(1) })).optional(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
})
/** Non-secret defaults copied into a new Agent profile and editable thereafter. */
export type AgentModelDefaults = z.infer<typeof bindingSchema>

function assertNoInlineSecrets(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(assertNoInlineSecrets); return }
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (/^(apikey|api_key|authorization|password|secret|token)$/i.test(key) && child !== undefined) {
      throw new Error('Inherited model settings must use credential references, not inline secrets')
    }
    if (key === 'headers' && child !== undefined && Object.keys(z.record(z.string(), z.unknown()).parse(child)).length > 0) {
      throw new Error('Inherited model settings require credential references instead of custom authentication headers')
    }
    if (/^baseurl$/i.test(key) && typeof child === 'string') {
      const endpoint = new URL(child)
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new Error('Inherited model endpoints must not embed credentials, query strings or fragments')
      }
    }
    assertNoInlineSecrets(child)
  }
}

function providerConfiguration(section: unknown, path: readonly string[]): Record<string, unknown> {
  let value = section
  for (const key of path) {
    const object = z.record(z.string(), z.unknown()).parse(value)
    value = object[key]
  }
  return z.record(z.string(), z.unknown()).parse(structuredClone(value))
}

function providerSection(path: readonly string[], configuration: Record<string, unknown>): Record<string, unknown> {
  return path.reduceRight<Record<string, unknown>>((value, key) => ({ [key]: value }), configuration)
}

/**
 * Resolve host Settings, including endpoint fallbacks and provider defaults, without making an inference request.
 * @param ctx - Host model selection, settings, LLM registry and trusted environment.
 * @param config - Deployment resource allowances and extra credential references.
 * @param signal - Configuration-capture cancellation.
 * @returns a complete serializable binding containing no credential values.
 */
export async function captureAgentDefaults(ctx: Context, config: AgentModelOptions, signal: AbortSignal): Promise<AgentModelDefaults> {
  const hostSelection = ctx.get('agentDefaultModel')?.currentSelection()
  const settings = ctx.get('settings')
  const llm = ctx.get('llm')
  if (hostSelection === undefined || settings === undefined || llm === undefined) {
    throw new Error('Host model inheritance requires the model selection, Settings and LLM services')
  }
  const reasoningEffort = config.reasoningEffort ?? hostSelection.reasoningEffort
  const selection = { ...hostSelection, provider: config.provider ?? hostSelection.provider,
    model: config.model ?? hostSelection.model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) } }
  signal.throwIfAborted()
  const descriptors = settings.describe({ redactSecrets: true })
  const selectionSnapshot = descriptors.find(row => row.ns === 'agent-default-model')
  const integration = config.modelProviders.find(value => value.provider === selection.provider)
  const directory = llm.listConfigurableProviders().find(value => value.provider === selection.provider)
  const namespace = integration?.settingsNamespace ?? directory?.settingsNs
    ?? (selection.provider === 'deepseek-official' ? 'llm-deepseek'
      : selection.provider === 'deepseek-account' ? 'llm-deepseek-account' : 'llm-pi-ai')
  const providerSnapshot = descriptors.find(row => row.ns === namespace)
  if (providerSnapshot?.secrets?.some(secret => secret.set)) {
    throw new Error('Inherited model settings must use credential references, not inline secrets')
  }
  const inventory = await readPluginInventory(ctx)
  signal.throwIfAborted()
  const credentialId = inventory.entries.find(entry => entry.moduleName === '@deepseek-ai/dsh-credentials-local'
    && entry.fiberPhase === 'active')?.entryId
  const credentialEntry = credentialId === undefined ? undefined
    : [...ctx.get('loader')?.entries() ?? []].find(entry => entry.id === credentialId)
  const credentialFiber = credentialEntry?.fiber
  const credentialState = credentialFiber?.state
  const credentialValue: unknown = credentialFiber?.config
  const sections: Record<string, Record<string, unknown>> = {}
  const references = new Set(config.credentialEnv)
  const capturedSections = new Map<string, number>()
  if (providerSnapshot !== undefined) capturedSections.set(namespace, providerSnapshot.revision)
  let modelBundles: AgentModelDefaults['modelBundles']
  if (integration !== undefined) {
    if (providerSnapshot === undefined) throw new Error('The selected model provider has no active Settings namespace')
    const profile = ctx.get('profileContext')
    if (profile === undefined || credentialFiber === undefined) throw new Error('Additional model inheritance requires a profile and managed credentials')
    const providerDirectory = resolveBundleDir('dsh', integration.bundle, profile.installAnchor, profile.dir)
    const manifest = z.object({ name: z.literal(integration.bundle), version: z.string().min(1) })
      .parse(JSON.parse(await readFile(join(providerDirectory, 'package.json'), { encoding: 'utf8', signal })))
    sections[namespace] = z.record(z.string(), z.unknown()).parse(structuredClone(providerSnapshot.value))
    modelBundles = [{ name: manifest.name, version: manifest.version, directory: providerDirectory }]
  } else if (selection.provider === 'deepseek-official') {
    const raw = providerSnapshot?.value
    if (raw === undefined) throw new Error('DeepSeek Settings are not registered on the host')
    // Settings owns Config validation; descriptors expose its plain resolved fields.
    const parsed = structuredClone(raw) as DeepSeekOptions
    const resolved = resolveAdapterOptions(parsed, launchEnvironmentOf(ctx))
    references.add(resolved.apiKeyEnv)
    const { baseURL: _endpoint, apiKeyEnv: _reference, ...defaults } = parsed
    sections[namespace] = { ...defaults, baseURL: resolved.baseURL, apiKeyEnv: resolved.apiKeyEnv }
  } else if (selection.provider === 'deepseek-account') {
    if (providerSnapshot === undefined || credentialFiber === undefined) {
      throw new Error('DeepSeek account inheritance requires account settings and a managed credential store')
    }
    const account = descriptors.find(row => row.ns === 'deepseek-account')
    if (account === undefined) throw new Error('DeepSeek account settings are not registered on the host')
    if (account.secrets?.some(secret => secret.set)) throw new Error('Inherited account settings cannot contain inline secret headers')
    const source = providerConfiguration(providerSnapshot.value, [])
    const protocol = resolveDeepSeekProtocol(source as DeepSeekProtocolOptions, launchEnvironmentOf(ctx))
    sections[namespace] = { ...source, baseURL: protocol.baseURL }
    sections['deepseek-account'] = providerConfiguration(account.value, [])
    capturedSections.set(account.ns, account.revision)
  } else {
    const raw = providerSnapshot?.value
    if (raw === undefined) throw new Error('The selected host provider has no inheritable Settings namespace')
    const path = directory?.settingsPath ?? ['providers', selection.provider]
    const source = providerConfiguration(raw, path)
    assertNoInlineSecrets(source)
    if (source.apiKeyEnv !== undefined) references.add(z.string().trim().min(1).parse(source.apiKeyEnv))
    else {
      const auth = directory?.nativeAuth
      if (auth === undefined || auth.env.length === 0 && !auth.oauth) {
        throw new Error('Host model inheritance requires an explicit credential reference or declared native authentication')
      }
      if (auth.oauth && credentialFiber === undefined) throw new Error('Inherited OAuth authentication requires a managed credential store')
      for (const name of auth.env) references.add(name)
    }
    for (const name of directory?.baseURLEnv ?? []) references.add(name)
    sections[namespace] = providerSection(path, source)
  }
  if (credentialFiber !== undefined) {
    const profile = ctx.get('profileContext')
    if (profile === undefined) throw new Error('Managed credential inheritance requires the host profile')
    const credentialConfig = z.object({ path: z.string().optional(), dshHome: z.string().optional() }).parse(credentialValue)
    const resolved = resolveCredentialFile({
      ...credentialConfig.path === undefined ? {} : { path: credentialConfig.path },
      dshHome: credentialConfig.dshHome ?? profile.home,
    })
    sections['credentials'] = { path: resolved.filename, watch: false }
  }
  assertNoInlineSecrets(sections)
  const effective = await llm.resolveCallConfig(selection, signal)
  signal.throwIfAborted()
  const credentialStillActive = credentialId === undefined || (await readPluginInventory(ctx)).entries
    .some(entry => entry.entryId === credentialId && entry.fiberPhase === 'active')
  signal.throwIfAborted()
  const settled = settings.describe({ redactSecrets: true })
  if ([...capturedSections].some(([ns, revision]) => settled.find(row => row.ns === ns)?.revision !== revision)
    || (credentialFiber !== undefined && (credentialEntry?.fiber !== credentialFiber
      || !credentialStillActive || credentialFiber.state !== credentialState || credentialFiber.config !== credentialValue))
    || settled.find(row => row.ns === 'agent-default-model')?.revision !== selectionSnapshot?.revision) {
    throw new Error('Host model Settings changed during initialization; retry to capture one consistent selection')
  }
  const inputs = { format: 1 as const, provider: effective.provider, model: effective.model,
    ...effective.reasoningEffort === undefined ? {} : { reasoningEffort: String(effective.reasoningEffort) },
    credentialEnv: [...references], settings: sections,
    ...modelBundles === undefined ? {} : { modelBundles } }
  // JSON serialization removes optional undefined fields before hashing or writing the binding.
  const canonical: unknown = JSON.parse(JSON.stringify(inputs))
  const snapshot = bindingSchema.omit({ hash: true }).parse(canonical)
  return { ...snapshot, hash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') }
}
