// @vitest-environment jsdom
/** Task-scoped workflow review preserves explicit human scores and retained evidence. */
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { fromPartial } from '@total-typescript/shoehorn'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CognitiveSnapshot, CognitiveUnitId, CognitiveTaskId, CognitiveEvidenceId, CognitiveAssessmentId, CognitivePluginId, AgentRunId } from '../../src/harness/client.ts'
import { CognitionPanel, type CognitionPanelProps } from '../../src/client/CognitionPanel.tsx'
import { en } from '../../src/client/locales.ts'

afterEach(cleanup)
function fixture(empty = false) {
  const reference = { id: brandString<CognitiveUnitId>('00000000-0000-4000-8000-000000000001'), revision: 1 }
  const taskId = brandString<CognitiveTaskId>('00000000-0000-4000-8000-000000000002')
  const state: CognitiveSnapshot = { revision: 5, units: [{ ...reference, kind: 'method', capability: 'verification',
    content: 'Inspect the requested interaction', applicability: 'Interactive pages', expectedOutcome: 'Inspectable behavior',
    implementation: [], createdAt: '2026-10-21T00:00:00.000Z' }], tasks: [{ id: taskId, objective: 'Build a page', outline: 'Implement and inspect',
    situation: 'Web design', criteria: 'The interaction works', rubricHash: 'a'.repeat(64), phase: 'execute', status: 'active', units: [reference],
    createdAt: '2026-10-21T00:00:00.000Z' }], evidence: [{ id: brandString<CognitiveEvidenceId>('00000000-0000-4000-8000-000000000003'),
    taskId, units: [reference], phase: 'execute', source: 'execution', content: 'Actual retained artifact', contentHash: 'b'.repeat(64),
    runId: brandString<AgentRunId>('run'), sessionId: 'session-id', success: true, createdAt: '2026-10-21T00:00:01.000Z' }], assessments: [], transitions: [], plugins: [] }
  if (empty) { state.units = []; state.tasks = []; state.evidence = [] }
  const props = { t: fromPartial<CognitionPanelProps['t']>((key: keyof typeof en, values?: Record<string, string | number>) => {
    let text: string = en[key]
    for (const [name, value] of Object.entries(values ?? {})) text = text.replaceAll(`{${name}}`, String(value))
    return text
  }),
  readPlugins: vi.fn(async () => ({ directory: '/workspace/bundles', pluginDirectory: '/workspace/plugins',
    profile: { name: 'rsi-test', directory: '/workspace/profile', bundles: [], contentHash: 'a'.repeat(64) }, required: false, plugins: [],
  })),
  readCognition: vi.fn(async () => state), updateCognition: vi.fn(async () => state),
  reviewCognition: vi.fn<CognitionPanelProps['reviewCognition']>(async () => state),
  captureConversation: vi.fn(async () => state), refreshToken: {}, onNotice: vi.fn() }
  return { state, reference, props, view: render(<CognitionPanel {...props} />) }
}

async function openEvidence(view: ReturnType<typeof render>) {
  fireEvent.click(await view.findByRole('tab', { name: en.cogEvidenceReview }))
  fireEvent.click(view.getByRole('button', { name: en.cogEvidence }))
  fireEvent.click(view.getByRole('menuitem', { name: /bbbbbbbb/ }))
  expect(await view.findByText('Actual retained artifact')).toBeTruthy()
}

function selectTarget(view: ReturnType<typeof render>, label: string) {
  fireEvent.click(view.getByRole('button', { name: en.cogTarget }))
  fireEvent.click(view.getByRole('menuitem', { name: label }))
}

it('shows the task and criteria immediately and uses separate capability, evidence and history tabs', async () => {
  const { view } = fixture()
  expect(await view.findByRole('heading', { name: 'Build a page' })).toBeTruthy()
  expect(view.getByText('The interaction works')).toBeTruthy()
  expect(view.getByText('Inspect the requested interaction')).toBeTruthy()
  expect(view.getByRole('tab', { name: en.cogCapabilities }).getAttribute('aria-selected')).toBe('true')
  expect(view.queryByRole('button', { name: en.cogSubmit })).toBeNull()
  expect(view.container.querySelector('details')).toBeNull()
})

it('requires retained evidence and explicit scores instead of treating execution success as quality', async () => {
  const { view, state, reference, props } = fixture()
  await openEvidence(view)
  expect(view.getByRole('button', { name: en.cogSubmit })).toHaveProperty('disabled', true)
  selectTarget(view, 'verification · v1')
  expect(view.queryByRole('menu')).toBeNull()
  expect(view.getByLabelText(en.cogKnowledge)).toHaveProperty('value', '')
  fireEvent.change(view.getByLabelText(en.cogKnowledge), { target: { value: '0.8' } })
  fireEvent.change(view.getByLabelText(en.cogEffectiveness), { target: { value: '-0.4' } })
  fireEvent.change(view.getByLabelText(en.cogRationale), { target: { value: 'The required interaction is broken' } })
  fireEvent.click(view.getByRole('button', { name: en.cogSubmit }))
  await waitFor(() => { expect(props.reviewCognition).toHaveBeenCalledWith({ revision: 5, taskId: state.tasks[0]!.id,
    target: reference, evidenceIds: [state.evidence[0]!.id], knowledge: 0.8, effectiveness: -0.4,
    rationale: 'The required interaction is broken' }) })
  expect(props.onNotice).toHaveBeenCalledWith(en.cogSaved, 'success')
})

it('serializes evidence capture with review and retains inspected content while capture is pending', async () => {
  const { view, props, state } = fixture()
  await openEvidence(view)
  selectTarget(view, 'verification · v1')
  const pending = Promise.withResolvers<CognitiveSnapshot>()
  props.captureConversation.mockReturnValueOnce(pending.promise)
  fireEvent.click(view.getByRole('button', { name: en.cogCaptureConversation }))
  expect(view.getByText('Actual retained artifact')).toBeTruthy()
  expect(view.getByLabelText(en.cogKnowledge)).toHaveProperty('disabled', true)
  expect(view.getByRole('button', { name: en.cogTask })).toHaveProperty('disabled', true)
  await act(async () => { pending.resolve(state) })
  await waitFor(() => { expect(view.getByLabelText(en.cogKnowledge)).toHaveProperty('disabled', false) })
})

it('keeps task acceptance separate from unit knowledge and prevents duplicate review submission', async () => {
  const { view, state, props } = fixture()
  props.reviewCognition.mockImplementation(async (request) => {
    state.assessments.push({ ...request, id: brandString<CognitiveAssessmentId>('00000000-0000-4000-8000-000000000004'),
      knownThreshold: 0.5, createdAt: '2026-10-21T00:00:02.000Z' })
    return state
  })
  await openEvidence(view)
  selectTarget(view, en.cogAcceptance)
  expect(view.queryByLabelText(en.cogKnowledge)).toBeNull()
  fireEvent.change(view.getByLabelText(en.cogEffectiveness), { target: { value: '0.6' } })
  fireEvent.change(view.getByLabelText(en.cogRationale), { target: { value: 'Accepted the inspected output' } })
  fireEvent.click(view.getByRole('button', { name: en.cogSubmit }))
  await waitFor(() => {
    expect(props.reviewCognition).toHaveBeenCalledWith(expect.objectContaining({ target: null, knowledge: null, effectiveness: 0.6 }))
  })
  expect(await view.findByText(en.cogSaved)).toBeTruthy()
  expect(view.getByRole('button', { name: en.cogSubmit })).toHaveProperty('disabled', true)
  fireEvent.click(view.getByRole('button', { name: en.cogSubmit }))
  expect(props.reviewCognition).toHaveBeenCalledTimes(1)
  fireEvent.click(view.getByRole('button', { name: en.cogComplete }))
  await waitFor(() => {
    expect(props.updateCognition).toHaveBeenCalledWith({ revision: 5, taskId: state.tasks[0]!.id, action: 'complete' })
  })
})

it('offers only exact cognitive revisions covered by the selected evidence', async () => {
  const { view, state } = fixture()
  state.evidence[0]!.units = []
  await openEvidence(view)
  fireEvent.click(view.getByRole('button', { name: en.cogTarget }))
  expect(view.queryByRole('menuitem', { name: 'verification · v1' })).toBeNull()
  expect(view.getByRole('menuitem', { name: en.cogAcceptance })).toBeTruthy()
})

it('does not offer task acceptance for submitted observations', async () => {
  const { view, state } = fixture()
  state.evidence[0]!.source = 'submitted'
  state.evidence[0]!.runId = null
  state.evidence[0]!.success = null
  await openEvidence(view)
  fireEvent.click(view.getByRole('button', { name: en.cogTarget }))
  expect(view.getByRole('menuitem', { name: 'verification · v1' })).toBeTruthy()
  expect(view.queryByRole('menuitem', { name: en.cogAcceptance })).toBeNull()
})

it('preserves completed task evidence while exposing no mutation controls', async () => {
  const { view, state } = fixture()
  state.tasks[0]!.status = 'completed'
  await openEvidence(view)
  expect(view.getByText(en.cogCompletedReadonly)).toBeTruthy()
  for (const name of [en.cogComplete, en.cogNext, en.cogReassess, en.cogSubmit, en.cogCaptureConversation]) {
    expect(view.queryByRole('button', { name })).toBeNull()
  }
  expect(view.queryByLabelText(en.cogRationale)).toBeNull()
})

it('resets review inputs on task changes and excludes other tasks bundles and reviews', async () => {
  const { view, state, reference } = fixture()
  const other = { ...state.tasks[0]!, id: brandString<CognitiveTaskId>('00000000-0000-4000-8000-000000000006'), objective: 'Another task' }
  state.tasks.unshift(other)
  state.plugins.push({ id: brandString<CognitivePluginId>('00000000-0000-4000-8000-000000000007'), taskId: other.id,
    units: [reference], directory: '/other/bundle', name: 'other-only-bundle', version: '1.0.0', contentHash: 'c'.repeat(64), createdAt: other.createdAt })
  state.assessments.push({ id: brandString<CognitiveAssessmentId>('00000000-0000-4000-8000-000000000008'), taskId: other.id, target: reference,
    evidenceIds: [], knowledge: 1, effectiveness: 1, knownThreshold: 0.5, rationale: 'Other task review', createdAt: other.createdAt })
  expect(await view.findByText(en.cogNoBundles)).toBeTruthy()
  expect(view.queryByText('other-only-bundle')).toBeNull()
  fireEvent.click(view.getByRole('tab', { name: en.cogHistory }))
  expect(view.getByText(en.cogNoReviews)).toBeTruthy()
  await openEvidence(view)
  selectTarget(view, 'verification · v1')
  fireEvent.change(view.getByLabelText(en.cogKnowledge), { target: { value: '0.8' } })
  fireEvent.click(view.getByRole('button', { name: en.cogTask }))
  fireEvent.click(view.getByRole('menuitem', { name: 'Another task' }))
  expect(view.getByText('other-only-bundle')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: en.cogTask }))
  fireEvent.click(view.getByRole('menuitem', { name: 'Build a page' }))
  await openEvidence(view)
  selectTarget(view, 'verification · v1')
  expect(view.getByLabelText(en.cogKnowledge)).toHaveProperty('value', '')
})

it('keeps all workflow phases visible with no invented current stage before a task exists', async () => {
  const { view } = fixture(true)
  await view.findByText(en.cogEmpty)
  const workflow = view.getByRole('list', { name: en.cogWorkflow })
  for (const label of [en.cogClarify, en.cogAssess, en.cogRepair, en.cogExecute]) expect(within(workflow).getByText(label)).toBeTruthy()
  expect(workflow.querySelector('[aria-current="step"]')).toBeNull()
})

it('ignores a late refresh response after a newer revision is displayed', async () => {
  const { view, props, state } = fixture()
  await view.findByRole('heading', { name: 'Build a page' })
  const pending = Promise.withResolvers<CognitiveSnapshot>()
  props.readCognition.mockReturnValueOnce(pending.promise)
  view.rerender(<CognitionPanel {...props} refreshToken={{}} />)
  const next = structuredClone(state)
  next.revision = 6
  next.tasks[0]!.phase = 'self-evaluation'
  props.readCognition.mockResolvedValue(next)
  view.rerender(<CognitionPanel {...props} refreshToken={{}} />)
  const workflow = view.getByRole('list', { name: en.cogWorkflow })
  await waitFor(() => { expect(workflow.querySelector('[aria-current="step"]')?.textContent).toContain(en.cogAssess) })
  await act(async () => { pending.resolve(state) })
  expect(workflow.querySelector('[aria-current="step"]')?.textContent).toContain(en.cogAssess)
})

it('routes an unaccepted execution to evidence review before exposing completion', async () => {
  const { view, props } = fixture()
  fireEvent.click(await view.findByRole('button', { name: en.cogReviewResult }))
  expect(view.getByRole('tab', { name: en.cogEvidenceReview }).getAttribute('aria-selected')).toBe('true')
  expect(view.queryByRole('button', { name: en.cogComplete })).toBeNull()
  expect(props.updateCognition).not.toHaveBeenCalled()
})

it('reports capture failures through the application notice and keeps the evidence visible', async () => {
  const { view, props } = fixture()
  await openEvidence(view)
  props.captureConversation.mockRejectedValueOnce(new Error('The conversation is still running'))
  fireEvent.click(view.getByRole('button', { name: en.cogCaptureConversation }))
  await waitFor(() => { expect(props.onNotice).toHaveBeenCalledWith('The conversation is still running', 'error') })
  expect(view.getByText('Actual retained artifact')).toBeTruthy()
})

it('delivers the operation outcome to the application after leaving the workflow page', async () => {
  const { view, props, state } = fixture()
  await openEvidence(view)
  const pending = Promise.withResolvers<CognitiveSnapshot>()
  props.captureConversation.mockReturnValueOnce(pending.promise)
  fireEvent.click(view.getByRole('button', { name: en.cogCaptureConversation }))
  view.unmount()
  await act(async () => { pending.resolve(state) })
  expect(props.onNotice).toHaveBeenCalledWith(en.cogCaptured, 'success')
})
