/** RSI-owned project navigation and cognitive-page inputs. */
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentWorkspaceId, AgentWorkspaceList, CognitiveSnapshot, CognitivePluginSnapshot, CognitiveCommand,
  CognitiveReview, AgentWorkspaceCreateRequest } from '../../harness/client.ts'
import type { ConsoleSnapshot } from '../feed.ts'

/** Project whose cognitive records are displayed in this document. */
export interface AgentDirectorySelection { id: AgentWorkspaceId | null; path: string | null }

/** Project operations and observations supplied by the browser registration. */
export interface AgentWorkspaceInjected {
  restartRequiresManager: boolean
  refreshWorkspaces(): Promise<void>
  restartWorkspace(): Promise<boolean>
  readCognition(): Promise<CognitiveSnapshot>
  readPlugins(): Promise<CognitivePluginSnapshot>
  updateCognition(request: CognitiveCommand): Promise<CognitiveSnapshot>
  reviewCognition(request: CognitiveReview): Promise<CognitiveSnapshot>
  captureConversation(taskId: string): Promise<CognitiveSnapshot>
  showProjects(): void
  openProject(id: AgentWorkspaceId): Promise<void>
  reviewProject(id: AgentWorkspaceId): void
  createProject(request: AgentWorkspaceCreateRequest): Promise<void>
  onNotice(text: string, tone?: 'success' | 'error'): void
  hooks: {
    workspaceCatalog: HostObservable<ConsoleSnapshot<AgentWorkspaceList>>
    agentDirectory: HostObservable<AgentDirectorySelection>
  }
}

/** Localized commands and bound observations for the project pages. */
export type AgentWorkspaceProps = PropsLocale<'rsi'> & InjectFace<AgentWorkspaceInjected>
