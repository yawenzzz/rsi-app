// @vitest-environment jsdom
/** Workflow navigation keeps restart ownership with the management process. */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { fromPartial } from '@total-typescript/shoehorn'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentWorkspaceId, AgentWorkspaceList, CognitiveSnapshot } from '../../src/harness/client.ts'
import type { AgentWorkspaceProps } from '../../src/client/contract/workspace.ts'
import { WorkflowPage } from '../../src/client/WorkflowPage.tsx'
import { en } from '../../src/client/locales.ts'

afterEach(cleanup)

function fixture(selected: boolean, child: boolean) {
  const id = brandString<AgentWorkspaceId>('a-11111111-2222-4333-8444-555555555555')
  const catalog: AgentWorkspaceList = { catalogPollIntervalMs: 3000, workspaces: [{
    id, name: 'Research', path: '/projects/research', workspacePath: '/projects/research/workspace',
    createdAt: '2026-10-26T00:00:00.000Z', lastOpenedAt: '2026-10-26T00:00:00.000Z',
    status: 'ready', profile: `agent-${id}`, bundleCount: 3, error: null,
  }] }
  const state: CognitiveSnapshot = { revision: 0, units: [], tasks: [], evidence: [], assessments: [], transitions: [], plugins: [] }
  const labels: Record<string, string> = en
  const t: AgentWorkspaceProps['t'] = key => labels[key] ?? key
  const showProjects = vi.fn()
  const restartWorkspace = vi.fn(async () => !child)
  const onNotice = vi.fn()
  const readCognition = vi.fn(async () => state)
  const props = fromPartial<AgentWorkspaceProps>({ t, restartRequiresManager: child, showProjects, restartWorkspace, onNotice, readCognition,
    useWorkspaceCatalog: selector => selector({ status: catalog, loading: false, busy: false, error: null }),
    useAgentDirectory: selector => selector({ id: selected ? id : null, path: selected ? '/projects/research' : null }),
    readPlugins: async () => ({ directory: '/projects/research/bundles', pluginDirectory: '/projects/research/plugins', required: false,
      profile: { name: 'project', directory: '/projects/research/profile', bundles: [], contentHash: 'a'.repeat(64) }, plugins: [] }),
  })
  return { props, showProjects, restartWorkspace, onNotice, readCognition }
}

it('offers RSI project navigation without reading an implicit default project', () => {
  const f = fixture(false, false)
  const view = render(<WorkflowPage {...f.props} />)
  expect(view.getByRole('heading', { name: en.flowEmpty })).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: en.projectTitle }))
  expect(f.showProjects).toHaveBeenCalledOnce()
  expect(f.readCognition).not.toHaveBeenCalled()
})

it('explains the parent handoff and does not announce an applied update while leaving the child page', async () => {
  const f = fixture(true, true)
  const view = render(<WorkflowPage {...f.props} />)
  expect(view.getByText(en.flowRestartManagerHint)).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: en.flowRestartFromManager }))
  await waitFor(() => { expect(f.restartWorkspace).toHaveBeenCalledOnce() })
  expect(f.onNotice).not.toHaveBeenCalledWith(en.flowRestarted)
})

it('reports an update only after the manager confirms it was applied', async () => {
  const f = fixture(true, false)
  const view = render(<WorkflowPage {...f.props} />)
  fireEvent.click(view.getByRole('button', { name: en.flowRestart }))
  await waitFor(() => { expect(f.onNotice).toHaveBeenCalledWith(en.flowRestarted) })
})
