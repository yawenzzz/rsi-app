/** Application-owned project registration and native Agent runtime management. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { brandString } from '@deepseek-ai/dsh-brand'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveBundleDir } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-settings'
import { acquireWriterLease, type WriterLease } from '../runtime/writer-lease.ts'
import { z } from 'zod'
import { AgentCatalog, workspaceIdSchema } from './catalog.ts'
import { agentProfilePaths, initializeAgentProfile, prepareAgentWorkspace, readAgentProfile, selectAgentBundle, type AgentProfilePaths } from './agent-profile.ts'
import { captureAgentDefaults } from './model-config.ts'
import { CognitionStore } from './cognition-store.ts'
import { cognitiveCommand, cognitiveExecution, cognitivePosition, cognitiveReview, cognitiveTask, sameCognitiveUnit } from './cognition.ts'
import { cognitiveCommandSchema, cognitivePluginRequestSchema, cognitiveReviewSchema } from './cognition-schema.ts'
import { inspectPluginArtifact, requirePluginReviews, selectedPluginArtifacts } from './cognitive-plugins.ts'
import { prepareRuntimeProfile } from './runtime-profile.ts'
import { startAgentRuntime, type AgentRuntime, type RuntimePolicy } from './runtime.ts'
import { openAgentControl, type AgentControlOperation } from './control-bridge.ts'
import { installManagerRpc, managerHandlers, managerRequestSchema } from './rpc.ts'
import { RSI_PACKAGE, rsiPackageDirectory } from '../shared/package.ts'
import type { AgentWorkspace, AgentWorkspaceId, AgentWorkspaceCreateRequest, AgentWorkspaceList,
  AgentWorkspaceSummary, AgentRuntimeConnection, AgentRunId } from './types.ts'
import type { CognitiveSnapshot, CognitiveCommand, CognitiveReview, CognitivePluginRequest,
  CognitivePluginSnapshot, CognitivePluginId } from './cognition-types.ts'

/** Platform policies; project profiles own their capability and model configuration. */
export interface Config extends RuntimePolicy {
  /** Delay between completed project catalog reads, in milliseconds. */
  catalogPollIntervalMs: number
  /** Maximum number of registered project identities. */
  maxWorkspaces: number
  /** Project-relative directory containing editable plugin packages. */
  pluginDirectory: string
  /** Project-relative directory containing cognitive bundle packages. */
  bundleDirectory: string
  /** Project-relative directory containing the authoritative profile. */
  profileDirectory: string
  /** Project-relative working directory for task inputs, scripts and outputs. */
  workspaceDirectory: string
  /** Installed bundle layers used to initialize new project profiles. */
  bundles: string[]
  /** Maximum complete first-party artifact size in bytes. */
  maxPluginBytes: number
  /** Maximum first-party entries traversed per artifact. */
  maxPluginFiles: number
  /** Maximum encoded cognitive event or control response size in bytes. */
  maxRecordBytes: number
  /** Lifetime journal event capacity; reaching it rejects writes. */
  maxCognitionRecords: number
  /** Knowledge threshold retained with human assessments. */
  cognitionKnownThreshold: number
  /** Writer lease expiry in milliseconds. */
  leaseStaleMs: number
  /** Writer lease heartbeat interval in milliseconds. */
  leaseUpdateMs: number
  /** Application-installed model integrations inherited by new projects. */
  modelProviders: {
    /** LLM provider identifier. */
    provider: string
    /** Settings namespace containing non-secret model configuration. */
    settingsNamespace: string
    /** Installed bundle supplying this provider. */
    bundle: string
  }[]
}

const positive = () => schema.number().min(1).step(1)
/** Project runtime settings; no seed, Git, build, baseline or evaluator fields are accepted. */
export const Config: schema<Config> = schema.object({
  catalogPollIntervalMs: positive().default(3000).description('Project catalog observation interval in milliseconds.'),
  maxWorkspaces: positive().default(32).description('Maximum registered project Agents.'),
  pluginDirectory: schema.string().default('plugins').description('Relative plugin source directory.'),
  bundleDirectory: schema.string().default('bundles').description('Relative cognitive bundle directory.'),
  profileDirectory: schema.string().default('profile').description('Relative authoritative profile directory.'),
  workspaceDirectory: schema.string().default('workspace').description('Relative working directory for task files.'),
  bundles: schema.array(schema.string()).default(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', RSI_PACKAGE])
    .description('Installed runtime layers used to initialize each project profile.'),
  maxPluginBytes: positive().default(4_194_304).description('Complete first-party source bytes per capability bundle.'),
  maxPluginFiles: positive().default(512).description('Maximum traversed first-party source entries per bundle.'),
  maxRecordBytes: positive().default(1_048_576).description('Maximum encoded cognitive record and control response bytes.'),
  maxCognitionRecords: positive().default(10000).description('Retained cognitive event capacity.'),
  cognitionKnownThreshold: schema.number().min(0.001).max(1).default(0.5).description('Explicit-knowledge threshold retained with human reviews.'),
  startupTimeoutMs: positive().max(2_147_483_647).default(60000).description('Agent process startup deadline in milliseconds.'),
  startupPollIntervalMs: positive().default(100).description('Startup readiness observation interval in milliseconds.'),
  terminationGraceMs: positive().default(3000).description('Managed process termination grace in milliseconds.'),
  maxOutputBytes: positive().default(131072).description('Bounded startup diagnostics per stream.'),
  leaseStaleMs: positive().min(5000).default(30000).description('Project writer lease expiry in milliseconds.'),
  leaseUpdateMs: positive().min(1000).default(10000).description('Project writer heartbeat interval in milliseconds.'),
  modelProviders: schema.array(schema.object({ provider: schema.string().required(), settingsNamespace: schema.string().required(),
    bundle: schema.string().required() })).default([]).description('Application-installed additional model providers inherited by new profiles.'),
})

/**
 * Resolve deployment defaults and reject overlapping source, task and state directories.
 * @param input - Loader configuration.
 * @returns validated project runtime policy.
 */
export function resolveConfig(input: unknown): Config {
  const config = schema.resolve(input, Config, {})[0] as Config
  const directories = [config.pluginDirectory, config.bundleDirectory, config.profileDirectory, config.workspaceDirectory, '.rsi']
    .map(path => path.replaceAll('\\', '/'))
  for (const [index, path] of directories.entries()) {
    if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).some(part => !part || part === '..' || part === '.')) {
      throw new Error('Agent directories must remain relative to their project')
    }
    if (directories.some((other, at) => at !== index && `${other}/`.startsWith(`${path}/`))) {
      throw new Error('Agent source, task and state directories must not overlap')
    }
  }
  if (config.leaseUpdateMs > config.leaseStaleMs / 2) throw new Error('Agent writer heartbeat must not exceed half its expiry')
  return config
}

interface OwnedWorkspace {
  record: AgentWorkspace
  paths: AgentProfilePaths
  lease: WriterLease
  store: CognitionStore
  runtime?: AgentRuntime
  control?: Awaited<ReturnType<typeof openAgentControl>>
  starting?: Promise<AgentRuntimeConnection>
  error: string | null
  loadedPlugins: CognitivePluginId[]
}

function projectConnection(runtime: AgentRuntime): AgentRuntimeConnection {
  return { ...runtime.connection, url: runtime.url }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Project identities, capability profiles and their native conversation processes. */
    agentWorkspaces: AgentWorkspaces
  }
}

/** Project-scoped runtime service; ordinary conversations execute in the selected Agent process. */
export class AgentWorkspaces extends Service {
  static inject = ['loader', 'profileContext', 'subprocess', 'settings', 'agentDefaultModel', 'llm', 'credentials', 'webServer']
  static Config = Config
  private readonly config: Config
  private readonly catalog: AgentCatalog
  private readonly owned = new Map<AgentWorkspaceId, OwnedWorkspace>()
  private readonly opening = new Map<AgentWorkspaceId, Promise<OwnedWorkspace>>()
  private readonly lifetime = new AbortController()
  private closing: Promise<void> | undefined

  /**
   * @param ctx - Application services and lifecycle owner.
   * @param input - Deployment runtime policy.
   */
  constructor(ctx: Context, input: Config) {
    super(ctx, 'agentWorkspaces')
    this.config = resolveConfig(input)
    this.catalog = new AgentCatalog(join(ctx.profileContext.home, 'agent-workspaces.json'), this.config.maxWorkspaces)
    ctx.inject(['connection'], (scope) => { installManagerRpc(scope, this, this.config.maxRecordBytes) })
  }

  /**
   * List project identities without starting their processes.
   * @returns registered Agents without starting their processes.
   */
  async workspaces(): Promise<AgentWorkspaceList> {
    return { catalogPollIntervalMs: this.config.catalogPollIntervalMs,
      workspaces: await Promise.all((await this.catalog.list()).map(record => this.summary(record))) }
  }

  /**
   * Register a project and initialize only its profile and local state directories.
   * @param request - Project name and directory.
   * @returns the committed Agent without a baseline build or a running conversation.
   */
  async createWorkspace(request: AgentWorkspaceCreateRequest): Promise<AgentWorkspaceSummary> {
    this.lifetime.signal.throwIfAborted()
    const record = await this.catalog.create(request, async (workspace) => {
      const paths = agentProfilePaths(workspace.path, `agent-${workspace.id}`, this.config)
      try { await stat(join(paths.profile, 'package.json')); await readAgentProfile(paths); return } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      const defaults = await captureAgentDefaults(this.ctx, { credentialEnv: [], modelProviders: this.config.modelProviders },
        this.lifetime.signal)
      await initializeAgentProfile(paths, [...this.config.bundles, ...(defaults.modelBundles ?? []).map(bundle => bundle.name)])
      const { manifest } = await readAgentProfile(paths)
      manifest.dependencies[RSI_PACKAGE] = `file:${rsiPackageDirectory}`
      for (const bundle of defaults.modelBundles ?? []) manifest.dependencies[bundle.name] = `file:${bundle.directory}`
      await writeFileAtomic(join(paths.profile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
      const welcome = this.ctx.settings.describe({ redactSecrets: true }).find(item => item.ns === 'ui-settings-general')?.value
      const credentialRow = [...this.ctx.loader.entries()].find(entry => entry.options.id === 'credentials')
      const credentialConfig = z.object({ path: z.string().optional() }).parse(credentialRow?.fiber?.config ?? {})
      const credentials = credentialConfig.path ?? join(this.ctx.profileContext.home, '.credentials.yaml')
      await writeFileAtomic(join(paths.profile, 'cordis.patch.yml'), JSON.stringify([
        { id: 'agent-default-model', config: { provider: defaults.provider, model: defaults.model,
          ...defaults.reasoningEffort === undefined ? {} : { reasoningEffort: defaults.reasoningEffort } } },
        ...Object.entries(defaults.settings).map(([id, config]) => ({ id, config })),
        ...defaults.settings['credentials'] === undefined ? [{ id: 'credentials', config: { path: credentials, watch: false } }] : [],
        { id: 'rsi-app', config: { role: 'agent' } },
        ...welcome === undefined ? [] : [{ id: 'ui-settings-general', config: welcome }],
      ], null, 2) + '\n', { mode: 0o600 })
      await writeFileAtomic(join(workspace.path, '.rsi', 'credential-references.json'), JSON.stringify(defaults.credentialEnv) + '\n', { mode: 0o600 })
    })
    return this.summary(record)
  }

  /**
   * Start or reuse the selected Agent's native Web conversation runtime.
   * @param id - Explicit Agent identity; no default fallback exists.
   * @returns the stable same-origin project path and loaded composition identity.
   */
  async openWorkspace(id: AgentWorkspaceId): Promise<AgentRuntimeConnection> {
    const workspace = await this.workspace(workspaceIdSchema.parse(id))
    if (workspace.runtime?.alive()) return projectConnection(workspace.runtime)
    if (workspace.starting !== undefined) return workspace.starting
    const pending = this.start(workspace)
    workspace.starting = pending
    void pending.then(() => { delete workspace.starting }, () => { delete workspace.starting })
    return pending
  }

  /**
   * Stop an idle Agent so its next open loads the current project profile.
   * @param id - Explicit Agent identity.
   * @returns after the process and control channel close.
   */
  async stopWorkspace(id: AgentWorkspaceId): Promise<void> {
    const workspace = await this.workspace(workspaceIdSchema.parse(id))
    if (workspace.starting !== undefined) await workspace.starting
    if (workspace.runtime?.alive()) {
      const sessions = z.object({ items: z.array(z.object({ running: z.boolean() })) })
        .parse(await workspace.runtime.rpc('session/list', { _request: {} }))
      if (sessions.items.some(item => item.running)) throw new Error('Stop active conversations before restarting this Agent')
    }
    await this.stop(workspace)
  }

  /**
   * Read cognitive history owned by the selected project.
   * @param id - Owning Agent.
   * @returns its retained cognitive state.
   */
  async cognition(id: AgentWorkspaceId): Promise<CognitiveSnapshot> { return (await this.workspace(id)).store.snapshot() }

  /**
   * Commit a proposal while preserving explicit human assessment ownership.
   * @param request - Model-safe cognitive mutation.
   * @param id - Owning Agent.
   * @returns committed cognitive state.
   */
  async updateCognition(request: CognitiveCommand, id: AgentWorkspaceId): Promise<CognitiveSnapshot> {
    const workspace = await this.workspace(id)
    const input = cognitiveCommandSchema.parse(request)
    const state = workspace.store.snapshot()
    if (input.action === 'complete' || input.action === 'advance') {
      const task = cognitiveTask(state, input.taskId)
      if (input.action === 'complete' || task.phase !== 'clarify' && task.units.every(unit => cognitivePosition(state, task, unit).quadrant === 'I')) {
        requirePluginReviews(state, task)
      }
    }
    return workspace.store.append(cognitiveCommand(state, input))
  }

  /**
   * Record direct human assessment against retained evidence.
   * @param request - Direct human scores over retained evidence.
   * @param id - Owning Agent.
   * @returns committed cognitive state.
   */
  async reviewCognition(request: CognitiveReview, id: AgentWorkspaceId): Promise<CognitiveSnapshot> {
    if (this.ctx.get('agents')?.currentInitiator() !== undefined) throw new Error('Cognitive reviews require direct human input')
    const workspace = await this.workspace(id)
    return workspace.store.append(cognitiveReview(workspace.store.snapshot(), cognitiveReviewSchema.parse(request),
      this.config.cognitionKnownThreshold))
  }

  /**
   * Inspect registered source artifacts and their profile selection.
   * @param id - Owning Agent.
   * @returns local bundle source status and profile selection.
   */
  async cognitivePlugins(id: AgentWorkspaceId): Promise<CognitivePluginSnapshot> {
    const workspace = await this.workspace(id)
    const { snapshot } = await readAgentProfile(workspace.paths)
    const plugins = await Promise.all(workspace.store.snapshot().plugins.map(async (artifact) => {
      let unchanged = false
      try {
        const source = await inspectPluginArtifact(workspace.paths.bundles, artifact.directory, this.config, workspace.paths.plugins)
        unchanged = source.contentHash === artifact.contentHash
      } catch (error) { if (!(error instanceof Error)) throw error }
      return { artifact, state: !unchanged ? 'changed' as const : snapshot.bundles.includes(artifact.name) ? 'selected' as const : 'disabled' as const }
    }))
    return { directory: workspace.paths.bundles, pluginDirectory: workspace.paths.plugins, required: true, plugins,
      profile: { name: snapshot.name, directory: snapshot.directory, bundles: snapshot.bundles, contentHash: snapshot.contentHash } }
  }

  /**
   * Bind tested local bundle source to exact cognitive revisions.
   * @param request - Bundle files and exact cognitive revisions.
   * @param id - Owning Agent.
   * @returns retained registration.
   */
  async registerCognitivePlugin(request: CognitivePluginRequest, id: AgentWorkspaceId): Promise<CognitiveSnapshot> {
    const input = cognitivePluginRequestSchema.parse(request)
    const workspace = await this.workspace(id)
    const state = workspace.store.snapshot()
    if (state.revision !== input.revision) throw new Error('Cognitive state changed; read it again')
    const task = cognitiveTask(state, input.taskId)
    if (task.phase !== 'repair' || task.status !== 'active') throw new Error('Register cognitive bundles during Repair')
    const source = await inspectPluginArtifact(workspace.paths.bundles, input.directory, this.config, workspace.paths.plugins)
    if (this.config.bundles.includes(source.name)) throw new Error('Project bundles cannot replace platform bundles')
    if (state.plugins.some(plugin => plugin.units.some(unit => input.units.some(reference => sameCognitiveUnit(reference, unit))))) {
      throw new Error('Create a new cognitive revision before replacing its implementation')
    }
    if (workspace.store.snapshot().revision !== input.revision) throw new Error('Cognitive state changed while reading the bundle')
    return workspace.store.append({ kind: 'plugin', value: { ...source, id: brandString<CognitivePluginId>(randomUUID()),
      taskId: task.id, units: input.units, createdAt: new Date().toISOString() } })
  }

  /**
   * Select a registered local bundle for the next project runtime.
   * @param pluginId - Registration owned by this Agent.
   * @param enabled - Selection for the next runtime.
   * @param id - Owning Agent.
   * @returns saved selection.
   */
  async setCognitivePluginEnabled(pluginId: CognitivePluginId, enabled: boolean, id: AgentWorkspaceId): Promise<CognitivePluginSnapshot> {
    const workspace = await this.workspace(id)
    const artifact = workspace.store.snapshot().plugins.find(item => item.id === pluginId)
    if (artifact === undefined) throw new Error('Bundle is not registered to this Agent')
    await selectAgentBundle(workspace.paths, artifact, enabled, this.config, () => { workspace.lease.assertHeld() })
    return this.cognitivePlugins(id)
  }

  /**
   * Retain the latest settled native conversation as task evidence without assigning a score.
   * @param taskId - Task being evaluated.
   * @param id - Owning Agent.
   * @returns cognitive state with actual Session evidence.
   */
  async captureConversation(taskId: string, id: AgentWorkspaceId): Promise<CognitiveSnapshot> {
    const workspace = await this.workspace(id)
    const task = workspace.store.snapshot().tasks.find(item => item.id === taskId)
    if (task === undefined || task.phase === 'clarify' || task.status !== 'active') throw new Error('Select an active task after Clarify')
    const runtime = workspace.runtime
    if (runtime === undefined || !runtime.alive()) throw new Error('Open the Agent conversation before retaining evidence')
    const list = z.object({ items: z.array(z.object({
      sessionId: z.string(), running: z.boolean(), blank: z.boolean(), updatedAt: z.number() })) })
      .parse(await runtime.rpc('session/list', { _request: {} }))
    const latest = list.items.filter(item => !item.blank).sort((left, right) => right.updatedAt - left.updatedAt)[0]
    if (latest === undefined || latest.running) throw new Error('Finish a conversation before retaining evidence')
    const evidence = z.object({
      sessionId: z.string(), turn: z.number(), success: z.boolean(), output: z.string(), compositionHash: z.string() })
      .parse(await runtime.rpc('agentEvidence/read', { sessionId: latest.sessionId }))
    if (evidence.compositionHash !== runtime.connection.compositionHash) throw new Error('Conversation used a different capability composition')
    const state = workspace.store.snapshot()
    const loaded = state.plugins.filter(item => workspace.loadedPlugins.includes(item.id))
    selectedPluginArtifacts(state, task, loaded)
    const plugins = loaded.map(item => item.id)
    return workspace.store.append(cognitiveExecution(task, { runId: brandString<AgentRunId>(randomUUID()),
      sessionId: evidence.sessionId, output: evidence.output, success: evidence.success, error: null }, plugins))
  }

  private async summary(record: AgentWorkspace): Promise<AgentWorkspaceSummary> {
    const paths = agentProfilePaths(record.path, `agent-${record.id}`, this.config)
    const owned = this.owned.get(record.id)
    try {
      const { snapshot } = await readAgentProfile(paths)
      return { ...record, workspacePath: paths.workspace, status: owned?.starting !== undefined ? 'starting' : owned?.runtime?.alive() ? 'ready'
        : owned?.error ? 'failed' : 'stopped', profile: snapshot.name, bundleCount: snapshot.bundles.length, error: owned?.error ?? null }
    } catch (error) {
      return { ...record, workspacePath: paths.workspace, status: 'failed', profile: paths.name, bundleCount: 0, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async workspace(id: AgentWorkspaceId): Promise<OwnedWorkspace> {
    this.lifetime.signal.throwIfAborted()
    const existing = this.owned.get(id)
    if (existing !== undefined) return existing
    const pending = this.opening.get(id)
    if (pending !== undefined) return pending
    const operation = this.acquire(id)
    this.opening.set(id, operation)
    void operation.then(() => { this.opening.delete(id) }, () => { this.opening.delete(id) })
    return operation
  }

  private async acquire(id: AgentWorkspaceId): Promise<OwnedWorkspace> {
    const record = await this.catalog.get(id)
    const state = join(record.path, '.rsi', 'state')
    await mkdir(state, { recursive: true, mode: 0o700 })
    const lease = await acquireWriterLease({ path: join(state, 'writer'), staleMs: this.config.leaseStaleMs,
      updateMs: this.config.leaseUpdateMs }, (error) => {
      this.ctx.logger.error(error)
      void this.close().catch((failure: unknown) => { this.ctx.logger.error(failure) })
    })
    try {
      const workspace: OwnedWorkspace = { record, paths: agentProfilePaths(record.path, `agent-${record.id}`, this.config), lease,
        store: new CognitionStore(state, () => { lease.assertHeld() }, this.config.maxRecordBytes, this.config.maxCognitionRecords),
        error: null, loadedPlugins: [] }
      this.lifetime.signal.throwIfAborted()
      this.owned.set(id, workspace)
      return workspace
    } catch (error) { await lease.release(); throw error }
  }

  private async dispatch(workspace: OwnedWorkspace, operation: AgentControlOperation, request: unknown): Promise<unknown> {
    switch (operation) {
      case 'ui': {
        const input = managerRequestSchema.parse(request)
        return managerHandlers(this)[input.method](input.args, this.lifetime.signal)
      }
      case 'context': return { agentId: workspace.record.id, name: workspace.record.name, project: workspace.record.path,
        workspace: workspace.paths.workspace, plugins: workspace.paths.plugins, bundles: workspace.paths.bundles,
        profileDirectory: workspace.paths.profile,
        profile: workspace.runtime?.connection.profile, compositionHash: workspace.runtime?.connection.compositionHash }
      case 'cognition': return workspace.store.snapshot()
      case 'update': return this.updateCognition(cognitiveCommandSchema.parse(request), workspace.record.id)
      case 'plugins': return this.cognitivePlugins(workspace.record.id)
      case 'register': return this.registerCognitivePlugin(cognitivePluginRequestSchema.parse(request), workspace.record.id)
      case 'select': {
        const input = z.strictObject({ id: z.uuid().transform(brandString<CognitivePluginId>), enabled: z.boolean() }).parse(request)
        return this.setCognitivePluginEnabled(input.id, input.enabled, workspace.record.id)
      }
    }
  }

  private async start(workspace: OwnedWorkspace): Promise<AgentRuntimeConnection> {
    await this.stop(workspace)
    workspace.error = null
    try {
      const cwd = await prepareAgentWorkspace(workspace.paths)
      const providers = new Map<string, string>([[RSI_PACKAGE, rsiPackageDirectory]])
      const selected = (await readAgentProfile(workspace.paths)).snapshot.bundles
      for (const provider of this.config.modelProviders) {
        if (!selected.includes(provider.bundle)) continue
        providers.set(provider.bundle, resolveBundleDir('dsh', provider.bundle, this.ctx.profileContext.installAnchor, this.ctx.profileContext.dir))
      }
      const manifest = z.object({ version: z.string() }).parse(JSON.parse(await readFile(this.ctx.profileContext.installAnchor, 'utf8')))
      const profile = await prepareRuntimeProfile(workspace.paths, this.config.bundles.filter(name => name !== RSI_PACKAGE), providers, this.config, manifest.version)
      workspace.control = await openAgentControl((operation, request) => this.dispatch(workspace, operation, request),
        this.config.maxRecordBytes)
      const referencesPath = join(workspace.record.path, '.rsi', 'credential-references.json')
      const references = z.array(z.string()).parse(JSON.parse(await readFile(referencesPath, 'utf8')))
      const env: Record<string, string> = { ...workspace.control.env, DSH_RSI_PROJECT_ID: workspace.record.id,
        DSH_RSI_MANAGER_URL: this.ctx.webServer.getOrigin() }
      for (const reference of references) {
        const value = await this.ctx.credentials.resolve(credentialRef(reference))
        if (value !== undefined) env[reference] = value.value
      }
      const loaded = workspace.store.snapshot().plugins.filter(item => profile.bundles.some(bundle =>
        bundle.name === item.name && bundle.version === item.version && bundle.contentHash === item.contentHash))
      workspace.runtime = await startAgentRuntime(this.ctx, workspace.record, cwd, profile, env, this.config, this.lifetime.signal)
      workspace.loadedPlugins = loaded.map(item => item.id)
      return projectConnection(workspace.runtime)
    } catch (error) {
      await this.stop(workspace)
      workspace.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  private async stop(workspace: OwnedWorkspace): Promise<void> {
    try { await workspace.runtime?.close() } finally {
      delete workspace.runtime
      await workspace.control?.close()
      delete workspace.control
    }
  }

  private close(): Promise<void> {
    this.closing ??= (async () => {
      this.lifetime.abort(new Error('Agent workspace manager stopped'))
      await Promise.allSettled(this.opening.values())
      const results = await Promise.allSettled([...this.owned.values()].map(async (workspace) => {
        try {
          try { await workspace.starting } catch (_error) { /* Startup owns its failed process cleanup. */ }
          await this.stop(workspace)
        } finally { workspace.store.close(); await workspace.lease.release() }
      }))
      this.owned.clear()
      const failures = results.filter(result => result.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map((result): unknown => result.reason), 'Agent processes did not all stop cleanly')
    })()
    return this.closing
  }

  protected [Service.init](): void { this.ctx.effect(() => () => this.close(), 'agent-workspaces: owned runtimes') }
}

export default AgentWorkspaces
