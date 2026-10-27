/** Project and workflow panels composed exclusively through official public DSH slots. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AgentWorkspaceId, AgentWorkspaceList, CognitiveCommand, CognitiveReview } from '../harness/client.ts'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { WorkflowPage, WorkflowIcon } from './WorkflowPage.tsx'
import { ProjectsPage, ProjectsIcon } from './ProjectsPage.tsx'
import { WorkflowToast, type WorkflowNotice } from './WorkflowToast.tsx'
import { ConsoleFeed } from './feed.ts'
import { conversationUrl, createRsiApi, requestedProject, resolvePageConfiguration } from './api.ts'
import type { AgentDirectorySelection, AgentWorkspaceInjected } from './contract/workspace.ts'
import { en, zh } from './locales.ts'

/** Public browser services needed by the RSI panels. */
export const inject = ['slots', 'locale', 'layout']

declare global {
  interface Window { __RSI_PAGE__?: unknown }
}

/**
 * Mount RSI-owned navigation without replacing native workspace or conversation services.
 * @param ctx - Official browser services and lifecycle owner.
 */
export function mountRsiUi(ctx: Context): void {
  const config = resolvePageConfiguration(window.__RSI_PAGE__)
  const linkedProject = config.projectId === null ? requestedProject(window.location.href) : null
  const lifetime = new AbortController()
  const api = createRsiApi(config, window.location.href, lifetime.signal)
  const catalogue: ConsoleFeed<AgentWorkspaceList> = new ConsoleFeed({ status: api.workspaces },
    () => catalogue.source.getSnapshot().status?.catalogPollIntervalMs ?? config.catalogPollIntervalMs)
  const directory = createSnapshotStore<AgentDirectorySelection>({ id: linkedProject ?? config.projectId, path: null })
  const projectsPanel = brandString<MainPanelId>('rsi-projects')
  const workflowPanel = brandString<MainPanelId>('rsi-workflow')
  const notices = createSnapshotStore<WorkflowNotice | null>(null)
  let sequence = 0
  const notify = (text: string, tone: 'success' | 'error' = 'success') => {
    if (!lifetime.signal.aborted) notices.set({ text, tone, sequence: ++sequence })
  }
  const selected = () => {
    const id = directory.getSnapshot().id
    if (id === null) throw new Error(ctx.locale.bind('rsi')('flowEmpty'))
    return id
  }
  const navigate = (address: string) => {
    lifetime.signal.throwIfAborted()
    window.location.assign(conversationUrl(address, window.location.href))
  }
  const openProject = async (id: AgentWorkspaceId) => {
    const navigation = ctx.layout.beginNavigation()
    const connection = await api.openWorkspace(id)
    if (!navigation.aborted) navigate(connection.url)
  }
  const face: AgentWorkspaceInjected = {
    restartRequiresManager: config.projectId !== null,
    hooks: { workspaceCatalog: catalogue.source, agentDirectory: directory },
    refreshWorkspaces: () => catalogue.refresh(),
    showProjects: () => { ctx.layout.selectPanel(projectsPanel) },
    openProject,
    reviewProject: (id) => {
      const project = catalogue.source.getSnapshot().status?.workspaces.find(item => item.id === id)
      if (project === undefined) { notify(ctx.locale.bind('rsi')('projectUnavailable'), 'error'); return }
      directory.set({ id, path: project.path })
      ctx.layout.selectPanel(workflowPanel)
    },
    createProject: async request => {
      const navigation = ctx.layout.beginNavigation()
      const project = await api.createWorkspace(request)
      await catalogue.refresh()
      if (navigation.aborted) return
      try {
        const connection = await api.openWorkspace(project.id)
        if (!navigation.aborted) navigate(connection.url)
      } catch (error) {
        throw new Error(ctx.locale.bind('rsi')('projectCreatedOpenFailed', { reason: error instanceof Error ? error.message : String(error) }))
      }
    },
    restartWorkspace: async () => {
      const id = selected()
      if (config.projectId !== null) {
        if (config.managerUrl === undefined) throw new Error(ctx.locale.bind('rsi')('flowManagerMissing'))
        const destination = new URL(conversationUrl(config.managerUrl, window.location.href))
        destination.searchParams.set('rsiProject', id)
        navigate(destination.href)
        return false
      }
      const ok = await catalogue.command(async () => {
        await api.stopWorkspace(id)
        const connection = await api.openWorkspace(id)
        navigate(connection.url)
      })
      return ok
    },
    readCognition: () => api.cognition(selected()), readPlugins: () => api.cognitivePlugins(selected()),
    updateCognition: (request: CognitiveCommand) => api.updateCognition(request, selected()),
    reviewCognition: (request: CognitiveReview) => api.reviewCognition(request, selected()),
    captureConversation: taskId => api.captureConversation(taskId, selected()), onNotice: notify,
  }
  ctx.effect(() => ctx.locale.register('rsi', { en, zh }), 'rsi: dictionaries')
  ctx.effect(() => {
    catalogue.start()
    return () => { lifetime.abort(); catalogue.stop() }
  }, 'rsi: catalog and requests')
  ctx.effect(() => ctx.slots.inject('main', function* () {
    yield ctx.slots.register({ name: 'main', key: projectsPanel, locale: 'rsi', inject: () => face }, ProjectsPage)
    yield ctx.slots.register({ name: 'main', key: workflowPanel, locale: 'rsi', inject: () => face }, WorkflowPage)
    if (config.projectId === null && (linkedProject !== null || ctx.layout.panelInfo.getSnapshot().activePanelId === null)) {
      ctx.layout.selectPanel(linkedProject === null ? projectsPanel : workflowPanel)
    }
  }), 'rsi: project and workflow panels')
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', function* () {
    yield ctx.slots.register({ name: 'sidebar.panellist', id: projectsPanel, order: 1,
      label: () => ctx.locale.bind('rsi')('projectTitle') }, ProjectsIcon)
    yield ctx.slots.register({ name: 'sidebar.panellist', id: workflowPanel, order: 2,
      label: () => ctx.locale.bind('rsi')('cogWorkflow') }, WorkflowIcon)
  }), 'rsi: project navigation')
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'rsi-workflow.notice',
    inject: () => ({ hooks: { workflowNotice: notices }, dismissNotice: () => { notices.set(null) } }) }, WorkflowToast)), 'rsi: workflow feedback')
}
