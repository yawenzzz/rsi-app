/** Cognitive tasks retain exact evidence, scoped scores and restart-safe phase transitions. */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentRunId } from '../../src/harness/types.ts'
import { CognitionStore } from '../../src/harness/cognition-store.ts'
import { applyCognitiveEvent, cognitiveCommand, cognitiveExecution, cognitivePosition, cognitiveReview, initialCognition } from '../../src/harness/cognition.ts'
import { cognitiveCommandSchema, cognitiveEventSchema } from '../../src/harness/cognition-schema.ts'
import type { CognitiveCommand, CognitiveSnapshot, CognitiveTaskId, CognitiveEvidenceId } from '../../src/harness/cognition-types.ts'

const roots: string[] = []
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
function fixture() {
  let state = initialCognition()
  const apply = (command: CognitiveCommand) => { state = applyCognitiveEvent(state, cognitiveCommand(state, command)); return state }
  apply({ action: 'unit', revision: 0, id: null, kind: 'method', capability: 'clarification',
    content: 'Resolve conflicting requirements before planning', applicability: 'Tasks with competing constraints',
    expectedOutcome: 'Explicit priorities and a feasible plan', implementation: ['skills/clarification/SKILL.md'] })
  const reference = { id: state.units[0]!.id, revision: 1 }
  apply({ action: 'task', revision: state.revision, objective: 'Build an accessible page', outline: 'Clarify, implement, inspect',
    situation: 'Web development with human requirements', criteria: 'Required behavior works and the user accepts the result' })
  const taskId = state.tasks[0]!.id
  apply({ action: 'select', revision: state.revision, taskId, units: [reference] })
  const execution = () => {
    state = applyCognitiveEvent(state, cognitiveExecution(state.tasks[0]!, {
      runId: brandString<AgentRunId>(`run-${state.revision}`), sessionId: 'native-session-1', output: '{"files":[{"path":"result.html","content":"verified artifact"}]}', success: true, error: null,
    }))
    return state.evidence.at(-1)!
  }
  const review = (knowledge: number, effectiveness: number) => {
    const evidence = state.evidence.at(-1)!
    state = applyCognitiveEvent(state, cognitiveReview(state, { revision: state.revision, taskId, target: reference,
      evidenceIds: [evidence.id], knowledge, effectiveness, rationale: 'Reviewed the retained artifact against the fixed criteria' }, 0.5))
  }
  return { state: () => state, replace: (next: CognitiveSnapshot) => { state = next }, apply, reference, taskId, execution, review }
}

it('runs Clarify, Self-evaluation, Repair and Execute with human evidence before completion', () => {
  const f = fixture()
  expect(cognitivePosition(f.state(), f.state().tasks[0]!, f.reference).quadrant).toBe('unassessed')
  f.apply({ action: 'advance', revision: f.state().revision, taskId: f.taskId })
  expect(f.state().tasks[0]!.phase).toBe('self-evaluation')
  f.execution(); f.review(0.8, -0.4)
  f.apply({ action: 'advance', revision: f.state().revision, taskId: f.taskId })
  expect(f.state().tasks[0]!.phase).toBe('repair')
  expect(() => f.apply({ action: 'advance', revision: f.state().revision, taskId: f.taskId })).toThrow('Repair needs')
  f.execution(); f.review(0.8, 0.6)
  expect(f.state().transitions.at(-1)).toMatchObject({ from: 'IV', to: 'I' })
  f.apply({ action: 'advance', revision: f.state().revision, taskId: f.taskId })
  expect(f.state().tasks[0]!.phase).toBe('execute')
  expect(() => f.apply({ action: 'complete', revision: f.state().revision, taskId: f.taskId })).toThrow('human acceptance')
  const evidence = f.execution()
  f.replace(applyCognitiveEvent(f.state(), cognitiveReview(f.state(), { revision: f.state().revision,
    taskId: f.taskId, target: null, evidenceIds: [evidence.id], knowledge: null, effectiveness: 0.8,
    rationale: 'The required behavior and deliverable passed human acceptance' }, 0.5)))
  f.apply({ action: 'complete', revision: f.state().revision, taskId: f.taskId })
  expect(f.state().tasks[0]!.status).toBe('completed')
})

it('records discovery, extraction and regression without rewriting earlier coordinates', () => {
  const f = fixture()
  f.execution(); f.review(0.1, -0.6)
  f.execution(); f.review(0.9, -0.6)
  expect(f.state().transitions.at(-1)).toMatchObject({ from: 'III', to: 'IV' })
  f.execution(); f.review(0.2, 0.7)
  f.execution(); f.review(0.9, 0.7)
  expect(f.state().transitions.at(-1)).toMatchObject({ from: 'II', to: 'I' })
  f.execution(); f.review(0.9, -0.2)
  expect(f.state().transitions.at(-1)).toMatchObject({ from: 'I', to: 'IV' })
  expect(f.state().assessments[0]).toMatchObject({ knowledge: 0.1, effectiveness: -0.6 })
})

it('does not infer learning from submitted text, process exit or a changed method', () => {
  const f = fixture()
  f.apply({ action: 'evidence', revision: f.state().revision, taskId: f.taskId, units: [f.reference], content: 'I learned the method' })
  f.execution()
  expect(f.state().transitions).toEqual([])
  f.review(0.9, 0.6)
  const original = f.state().units[0]!
  f.apply({ action: 'unit', revision: f.state().revision, id: original.id, kind: original.kind, capability: original.capability,
    content: 'A changed clarification method', applicability: original.applicability, expectedOutcome: original.expectedOutcome, implementation: [] })
  expect(cognitivePosition(f.state(), f.state().tasks[0]!, { id: original.id, revision: 2 }).quadrant).toBe('unassessed')
  expect(f.state().units[0]).toEqual(original)
  expect(() => cognitiveCommandSchema.parse({ action: 'review', revision: f.state().revision, knowledge: 1, effectiveness: 1 })).toThrow()
})

it('keeps different situations and rubrics unassessed and rejects cross-task, altered or duplicate evidence', () => {
  const f = fixture()
  const evidence = f.execution(); f.review(0.9, 0.7)
  f.apply({ action: 'task', revision: f.state().revision, objective: 'Write a report', outline: 'Research and write',
    situation: 'Research', criteria: 'Citations support the claims' })
  const task = f.state().tasks.at(-1)!
  expect(cognitivePosition(f.state(), task, f.reference).quadrant).toBe('unassessed')
  const request = { revision: f.state().revision, taskId: task.id, target: f.reference, evidenceIds: [evidence.id],
    knowledge: 0.9, effectiveness: 0.5, rationale: 'Review' }
  expect(() => applyCognitiveEvent(f.state(), cognitiveReview(f.state(), request, 0.5))).toThrow('from its task')
  expect(() => applyCognitiveEvent(f.state(), { kind: 'evidence', value: { ...evidence, id: brandString<CognitiveEvidenceId>('00000000-0000-4000-8000-000000000001'), content: 'altered' } })).toThrow('hash mismatch')
  expect(() => applyCognitiveEvent(f.state(), cognitiveReview(f.state(), { ...request, taskId: f.taskId, evidenceIds: [evidence.id, evidence.id] }, 0.5))).toThrow('duplicate evidence')
  expect(() => f.apply({ action: 'advance', revision: 0, taskId: f.taskId })).toThrow('state changed')
  expect(() => f.apply({ action: 'advance', revision: f.state().revision, taskId: brandString<CognitiveTaskId>('00000000-0000-4000-8000-000000000002') })).toThrow('does not exist')
})

it('replays cognitive revisions and human assessments through the durable workspace journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-cognition-')); roots.push(root)
  const store = new CognitionStore(root, () => {}, 1_048_576, 100)
  const commands: CognitiveCommand[] = [
    { action: 'unit', revision: 0, id: null, kind: 'judgment', capability: 'evidence', content: 'Check the original source',
      applicability: 'Cited factual claims', expectedOutcome: 'Traceable evidence', implementation: [] },
    { action: 'task', revision: 1, objective: 'Review a claim', outline: 'Inspect source', situation: 'Research', criteria: 'Accurate citation' },
  ]
  for (const command of commands) store.append(cognitiveEventSchema.parse(cognitiveCommand(store.snapshot(), command)))
  const before = store.snapshot()
  store.close()
  const reopened = new CognitionStore(root, () => {}, 1_048_576, 100)
  expect(reopened.snapshot()).toEqual(before)
  reopened.close()
})

it('rejects replayed phase shortcuts, criterion changes and acceptance of an older execution', () => {
  const f = fixture()
  expect(() => applyCognitiveEvent(f.state(), { kind: 'task', value: { ...f.state().tasks[0]!, phase: 'execute' } })).toThrow('transition')
  expect(() => applyCognitiveEvent(f.state(), { kind: 'task', value: { ...f.state().tasks[0]!, criteria: 'A weaker rubric' } })).toThrow('hash')
  f.apply({ action: 'advance', revision: f.state().revision, taskId: f.taskId })
  f.execution(); f.review(0.9, 0.6)
  f.apply({ action: 'advance', revision: f.state().revision, taskId: f.taskId })
  const old = f.execution()
  f.replace(applyCognitiveEvent(f.state(), cognitiveReview(f.state(), { revision: f.state().revision, taskId: f.taskId, target: null,
    evidenceIds: [old.id], knowledge: null, effectiveness: 1, rationale: 'Accepted this exact execution' }, 0.5)))
  f.execution()
  expect(() => f.apply({ action: 'complete', revision: f.state().revision, taskId: f.taskId })).toThrow('latest successful')
})
