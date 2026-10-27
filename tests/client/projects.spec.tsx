// @vitest-environment jsdom
/** Project navigation preserves user input on failure and invokes explicit project operations. */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentWorkspaceId, AgentWorkspaceList } from '../../src/harness/types.ts'
import type { AgentWorkspaceProps } from '../../src/client/contract/workspace.ts'
import { ProjectsPage } from '../../src/client/ProjectsPage.tsx'
import { en } from '../../src/client/locales.ts'

afterEach(cleanup)

const id = brandString<AgentWorkspaceId>('a-11111111-2222-4333-8444-555555555555')
const catalog: AgentWorkspaceList = { catalogPollIntervalMs: 3000, workspaces: [{
  id, name: 'Research', path: '/projects/research', workspacePath: '/projects/research/workspace',
  createdAt: '2026-10-26T00:00:00.000Z', lastOpenedAt: '2026-10-26T00:00:00.000Z',
  status: 'ready', profile: `agent-${id}`, bundleCount: 3, error: null,
}] }

function fixture() {
  const createProject = vi.fn(async () => {})
  const openProject = vi.fn(async () => {})
  const reviewProject = vi.fn(() => {})
  const onNotice = vi.fn()
  const labels: Record<string, string> = en
  const t: AgentWorkspaceProps['t'] = (key, params) => {
    let value = labels[key] ?? key
    for (const [name, replacement] of Object.entries(params ?? {})) value = value.replaceAll(`{${name}}`, String(replacement))
    return value
  }
  const props: AgentWorkspaceProps = {
    restartRequiresManager: false,
    t, createProject, openProject, reviewProject, onNotice,
    useWorkspaceCatalog: selector => selector({ status: catalog, loading: false, busy: false, error: null }),
    useAgentDirectory: selector => selector({ id: null, path: null }),
    refreshWorkspaces: async () => {}, restartWorkspace: async () => true, showProjects: () => {},
    readCognition: async () => { throw new Error('Not used by project navigation') },
    readPlugins: async () => { throw new Error('Not used by project navigation') },
    updateCognition: async () => { throw new Error('Not used by project navigation') },
    reviewCognition: async () => { throw new Error('Not used by project navigation') },
    captureConversation: async () => { throw new Error('Not used by project navigation') },
  }
  return { props, createProject, openProject, reviewProject }
}

it('opens and reviews the explicitly selected project', () => {
  const f = fixture()
  const view = render(<ProjectsPage {...f.props} />)
  expect(view.getByText('Running')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: en.projectOpen }))
  expect(f.openProject).toHaveBeenCalledWith(id)
  fireEvent.click(view.getByRole('button', { name: en.projectReview }))
  expect(f.reviewProject).toHaveBeenCalledWith(id)
})

it('keeps the registration values after a server error', async () => {
  const f = fixture()
  f.createProject.mockRejectedValueOnce(new Error('Project directory overlaps Research'))
  const view = render(<ProjectsPage {...f.props} />)
  fireEvent.change(view.getByLabelText(en.projectName), { target: { value: 'Other project' } })
  fireEvent.change(view.getByLabelText(en.projectPath), { target: { value: '/projects/research/child' } })
  fireEvent.click(view.getByRole('button', { name: en.projectCreateOpen }))
  expect(await view.findByRole('alert')).toHaveProperty('textContent', 'Project directory overlaps Research')
  expect(view.getByLabelText<HTMLInputElement>(en.projectName).value).toBe('Other project')
  expect(view.getByLabelText<HTMLInputElement>(en.projectPath).value).toBe('/projects/research/child')
  await waitFor(() => { expect(view.getByRole<HTMLButtonElement>('button', { name: en.projectCreateOpen }).disabled).toBe(false) })
})

it('rejects relative paths before creating a project', async () => {
  const f = fixture()
  const view = render(<ProjectsPage {...f.props} />)
  fireEvent.change(view.getByLabelText(en.projectName), { target: { value: 'Example' } })
  fireEvent.change(view.getByLabelText(en.projectPath), { target: { value: '../example' } })
  fireEvent.click(view.getByRole('button', { name: en.projectCreateOpen }))
  expect(await view.findByRole('alert')).toHaveProperty('textContent', en.projectRequired)
  expect(f.createProject).not.toHaveBeenCalled()
})
