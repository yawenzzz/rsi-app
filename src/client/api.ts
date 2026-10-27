/** Browser client for the official DSH HTTP gateway and RSI-owned project operations. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { cognitivePluginSnapshotSchema, cognitiveSnapshotSchema } from '../harness/cognition-schema.ts'
import type { AgentRuntimeConnection, AgentWorkspaceCreateRequest, AgentWorkspaceId, AgentWorkspaceList,
  AgentWorkspaceSummary, CognitiveCommand, CognitiveReview } from '../harness/client.ts'

const projectId = z.string().regex(/^[aw]-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i)
  .transform(brandString<AgentWorkspaceId>)
const workspace: z.ZodType<AgentWorkspaceSummary> = z.object({
  id: projectId, name: z.string(), path: z.string(), workspacePath: z.string(), createdAt: z.string(), lastOpenedAt: z.string(),
  status: z.enum(['stopped', 'starting', 'ready', 'failed']), profile: z.string(), bundleCount: z.number(), error: z.string().nullable(),
})
const catalog: z.ZodType<AgentWorkspaceList> = z.object({ catalogPollIntervalMs: z.number().positive(), workspaces: z.array(workspace) })
const connection: z.ZodType<AgentRuntimeConnection> = z.object({
  workspaceId: projectId, profile: z.string(), url: z.string(), compositionHash: z.string(),
})
const result = z.object({ result: z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown().optional() }),
  z.object({ ok: z.literal(false), error: z.object({ message: z.string() }) }),
]) })

/** Per-document identity and transport supplied by the RSI Host plugin. */
export interface RsiPageConfiguration {
  projectId: AgentWorkspaceId | null
  managementPath: string
  requestTimeoutMs: number
  catalogPollIntervalMs: number
  managerUrl?: string
}

const pageSchema: z.ZodType<RsiPageConfiguration> = z.object({
  projectId: projectId.nullable().default(null), managementPath: z.string().default('api/'),
  requestTimeoutMs: z.number().int().positive().max(2_147_483_647).default(120000),
  catalogPollIntervalMs: z.number().int().positive().default(3000),
  managerUrl: z.string().optional(),
})

/**
 * Resolve page configuration without relying on fork-specific DSH bootstrap globals.
 * @param value - Host-injected RSI page metadata, or undefined for the management page.
 * @returns explicit page identity and request limits.
 */
export function resolvePageConfiguration(value: unknown): RsiPageConfiguration { return pageSchema.parse(value ?? {}) }

/**
 * Read an explicitly linked project without starting or changing its runtime.
 * @param address - Current management-page URL.
 * @returns requested project identity, or null when no project is linked.
 */
export function requestedProject(address: string): AgentWorkspaceId | null {
  const selected = new URL(address).searchParams.get('rsiProject')
  return selected === null ? null : projectId.parse(selected)
}

/**
 * Validate a server-selected conversation destination before browser navigation.
 * @param address - Relative or absolute URL returned by the project manager.
 * @param base - Current document URL.
 * @returns an HTTP(S) destination without embedded account credentials.
 */
export function conversationUrl(address: string, base: string): string {
  const url = new URL(address, base)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported project conversation URL')
  return url.href
}

/**
 * Bind project operations to the authenticated management endpoint of one document.
 * @param config - Resolved page transport.
 * @param pageUrl - Current document URL used to resolve a relative API path.
 * @param signal - Client plugin lifetime.
 * @param transport - Browser fetch or an isolated test transport.
 * @returns validated project and cognitive operations.
 */
export function createRsiApi(config: RsiPageConfiguration, pageUrl: string, signal: AbortSignal, transport: typeof fetch = fetch) {
  const base = new URL(config.managementPath, pageUrl)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Unsupported project management URL')
  const request = async <T>(method: string, args: object, schema: z.ZodType<T>): Promise<T> => {
    const response = await transport(new URL(`agentWorkspaces/${method}`, base), {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)]),
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: `agentWorkspaces/${method}`, payload: { args } }),
    })
    if (!response.ok) throw new Error(`Project request failed (HTTP ${response.status})`)
    const envelope = result.parse(await response.json()).result
    if (!envelope.ok) throw new Error(envelope.error.message)
    return schema.parse(envelope.value)
  }
  return {
    workspaces: () => request('workspaces', {}, catalog),
    createWorkspace: (input: AgentWorkspaceCreateRequest) => request('createWorkspace', { request: input }, workspace),
    openWorkspace: (id: AgentWorkspaceId) => request('openWorkspace', { id }, connection),
    stopWorkspace: (id: AgentWorkspaceId) => request('stopWorkspace', { id }, z.unknown()),
    cognition: (id: AgentWorkspaceId) => request('cognition', { id }, cognitiveSnapshotSchema),
    cognitivePlugins: (id: AgentWorkspaceId) => request('cognitivePlugins', { id }, cognitivePluginSnapshotSchema),
    updateCognition: (input: CognitiveCommand, id: AgentWorkspaceId) => request('updateCognition', { request: input, id }, cognitiveSnapshotSchema),
    reviewCognition: (input: CognitiveReview, id: AgentWorkspaceId) => request('reviewCognition', { request: input, id }, cognitiveSnapshotSchema),
    captureConversation: (taskId: string, id: AgentWorkspaceId) => request('captureConversation', { taskId, id }, cognitiveSnapshotSchema),
  }
}
