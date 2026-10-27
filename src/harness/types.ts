/** Project Agent identities and native conversation connections. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
/** Stable identity of a project-owned Agent. */
export type AgentWorkspaceId = Branded<'AgentWorkspaceId'>
/** Identity of retained task execution evidence. */
export type AgentRunId = Branded<'AgentRunId'>
/** Persistent ownership of one project and its profile. */
export interface AgentWorkspace {
  id: AgentWorkspaceId
  name: string
  path: string
  createdAt: string
  lastOpenedAt: string
}
/** Operator request to register a project without initializing a source repository. */
export interface AgentWorkspaceCreateRequest { name: string; path: string }
/** Current process state and project composition metadata. */
export interface AgentWorkspaceSummary extends AgentWorkspace {
  /** Absolute task directory used by the project runtime and its native Workspace. */
  workspacePath: string
  status: 'stopped' | 'starting' | 'ready' | 'failed'
  profile: string
  bundleCount: number
  error: string | null
}
/** Registered project Agents; execution never selects an implicit default. */
export interface AgentWorkspaceList { catalogPollIntervalMs: number; workspaces: AgentWorkspaceSummary[] }
/** Native project conversation on its own stable loopback origin. */
export interface AgentRuntimeConnection {
  workspaceId: AgentWorkspaceId
  profile: string
  /** Authenticated startup URL for the project's stable loopback origin. */
  url: string
  compositionHash: string
}

/** Settled native conversation evidence, read by the owning project process. */
export interface AgentConversationEvidence {
  sessionId: SessionId
  turn: number
  success: boolean
  output: string
  compositionHash: string
}
