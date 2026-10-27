/** Evidence-driven task progression; only retained human assessments establish cognitive coordinates. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { AgentRunId } from './types.ts'
import type { CognitiveAssessment, CognitiveCommand, CognitiveEvent, CognitiveEvidence, CognitivePosition,
  CognitiveQuadrant, CognitiveReference, CognitiveReview, CognitiveSnapshot, CognitiveTask, CognitiveTaskId,
  CognitiveUnitId, CognitiveEvidenceId, CognitiveAssessmentId, CognitivePluginId } from './cognition-types.ts'

/**
 * Resolve immutable cognitive identities and task evidence.
 * @returns an empty workspace history without inferred scores for old harness versions.
 */
export function initialCognition(): CognitiveSnapshot {
  return { revision: 0, units: [], tasks: [], evidence: [], assessments: [], transitions: [], plugins: [] }
}

/**
 * Resolve immutable cognitive identities and task evidence.
 * @param text - Exact retained content.
 * @returns SHA-256 identity of its UTF-8 bytes.
 */
export function cognitiveHash(text: string): string { return createHash('sha256').update(text).digest('hex') }

/**
 * Resolve immutable cognitive identities and task evidence.
 * @param left - First unit revision.
 * @param right - Second unit revision.
 * @returns whether both name the same immutable content.
 */
export function sameCognitiveUnit(left: CognitiveReference, right: CognitiveReference): boolean {
  return left.id === right.id && left.revision === right.revision
}

/**
 * Resolve immutable cognitive identities and task evidence.
 * @param state - Retained workspace records.
 * @param id - Task identity.
 * @returns the task, or throws for an unknown identity.
 */
export function cognitiveTask(state: CognitiveSnapshot, id: CognitiveTaskId): CognitiveTask {
  const task = state.tasks.find(item => item.id === id)
  if (task === undefined) throw new Error('Cognitive task does not exist')
  return task
}

function requireUnit(state: CognitiveSnapshot, reference: CognitiveReference): void {
  if (!state.units.some(unit => sameCognitiveUnit(unit, reference))) throw new Error('Cognitive unit revision does not exist')
}

function requireUniqueUnits(units: CognitiveReference[]): void {
  if (new Set(units.map(unit => unit.id)).size !== units.length) throw new Error('Select one revision per cognitive unit')
}

function quadrant(assessment: CognitiveAssessment): CognitiveQuadrant {
  if (assessment.knowledge === null) return 'unassessed'
  const known = assessment.knowledge >= assessment.knownThreshold
  return assessment.effectiveness >= 0 ? known ? 'I' : 'II' : known ? 'IV' : 'III'
}

/**
 * Resolve coordinates only from human evidence under the exact situation and rubric.
 * @param state - Retained history.
 * @param task - Fixed task scope.
 * @param target - Exact cognitive revision.
 * @returns the latest supported position; no evidence produces null coordinates.
 */
export function cognitivePosition(state: CognitiveSnapshot, task: CognitiveTask, target: CognitiveReference): CognitivePosition {
  const assessment = state.assessments.findLast(item => item.target !== null && sameCognitiveUnit(item.target, target)
    && cognitiveTask(state, item.taskId).rubricHash === task.rubricHash)
  return { target, rubricHash: task.rubricHash, knowledge: assessment?.knowledge ?? null,
    effectiveness: assessment?.effectiveness ?? null, quadrant: assessment === undefined ? 'unassessed' : quadrant(assessment),
    assessmentId: assessment?.id ?? null }
}

/**
 * Produce one model proposal or checked phase transition without modifying the journal.
 * @param state - Current retained records.
 * @param command - Validated model command.
 * @returns the next immutable event; stale revisions and unsupported transitions throw.
 */
export function cognitiveCommand(state: CognitiveSnapshot, command: CognitiveCommand): CognitiveEvent {
  if (command.revision !== state.revision) throw new Error('Cognitive state changed; read status before retrying')
  const createdAt = new Date().toISOString()
  switch (command.action) {
    case 'unit': {
      const previous = command.id === null ? undefined : state.units.findLast(item => item.id === command.id)
      if (command.id !== null && previous === undefined) throw new Error('Cognitive unit does not exist')
      return { kind: 'unit', value: { id: command.id ?? brandString<CognitiveUnitId>(randomUUID()), revision: (previous?.revision ?? 0) + 1,
        kind: command.kind, capability: command.capability, content: command.content, applicability: command.applicability,
        expectedOutcome: command.expectedOutcome, implementation: command.implementation, createdAt } }
    }
    case 'task':
      return { kind: 'task', value: { id: brandString<CognitiveTaskId>(randomUUID()), objective: command.objective, outline: command.outline,
        situation: command.situation, criteria: command.criteria,
        rubricHash: cognitiveHash(JSON.stringify([command.situation, command.criteria])),
        phase: 'clarify', status: 'active', units: [], createdAt } }
    case 'select': {
      const task = activeTask(state, command.taskId)
      if (task.phase === 'execute') throw new Error('Return to self-evaluation before changing selected cognitive units')
      requireUniqueUnits(command.units)
      for (const unit of command.units) requireUnit(state, unit)
      return { kind: 'task', value: { ...task, units: command.units } }
    }
    case 'advance': {
      const task = activeTask(state, command.taskId)
      if (task.units.length === 0) throw new Error('Select relevant cognitive units before advancing')
      const ready = task.units.every(unit => cognitivePosition(state, task, unit).quadrant === 'I')
      if (task.phase === 'execute') throw new Error('Task is already executing')
      if (task.phase === 'repair' && !ready) throw new Error('Repair needs reviewed evidence for every selected cognitive revision')
      const phase = task.phase === 'clarify' ? 'self-evaluation' : ready ? 'execute' : 'repair'
      return { kind: 'task', value: { ...task, phase } }
    }
    case 'reassess': {
      const task = activeTask(state, command.taskId)
      if (task.phase === 'clarify') throw new Error('Finish Clarify before reassessing')
      return { kind: 'task', value: { ...task, phase: 'self-evaluation' } }
    }
    case 'evidence': {
      const task = activeTask(state, command.taskId)
      return { kind: 'evidence', value: { id: brandString<CognitiveEvidenceId>(randomUUID()), taskId: task.id, units: command.units,
        phase: task.phase, source: 'submitted', content: command.content, contentHash: cognitiveHash(command.content),
        runId: null, versionId: null, success: null, createdAt } }
    }
    case 'complete': {
      const task = activeTask(state, command.taskId)
      requireAcceptance(state, task)
      return { kind: 'task', value: { ...task, status: 'completed' } }
    }
  }
  return assertNever(command)
}

function requireAcceptance(state: CognitiveSnapshot, task: CognitiveTask): void {
  if (task.phase !== 'execute') throw new Error('Only an executing task can complete')
  const review = state.assessments.findLast(item => item.taskId === task.id && item.target === null)
  if (review === undefined || review.effectiveness < 0) throw new Error('Task completion requires a passing human acceptance review')
  const latest = state.evidence.findLast(item => item.taskId === task.id && item.source === 'execution' && item.phase === 'execute')
  if (latest === undefined || latest.success !== true || !review.evidenceIds.includes(latest.id)) {
    throw new Error('Acceptance must review the latest successful task execution')
  }
}

function requireTaskTransition(state: CognitiveSnapshot, previous: CognitiveTask, task: CognitiveTask): void {
  if (previous.status !== 'active') throw new Error('Completed task records cannot change')
  if (JSON.stringify(previous.units) !== JSON.stringify(task.units) && (previous.phase === 'execute' || previous.phase !== task.phase)) {
    throw new Error('Selected revisions cannot change during execution or a phase transition')
  }
  if (task.status === 'completed') requireAcceptance(state, previous)
  if (task.phase === previous.phase) return
  if (task.units.length === 0) throw new Error('Phase transition requires selected cognitive units')
  const ready = task.units.every(unit => cognitivePosition(state, task, unit).quadrant === 'I')
  const allowed = task.phase === 'self-evaluation'
    || previous.phase === 'self-evaluation' && task.phase === (ready ? 'execute' : 'repair')
    || previous.phase === 'repair' && task.phase === 'execute' && ready
  if (!allowed || task.status === 'completed') throw new Error('Unsupported cognitive phase transition')
}

function activeTask(state: CognitiveSnapshot, id: CognitiveTaskId): CognitiveTask {
  const task = cognitiveTask(state, id)
  if (task.status !== 'active') throw new Error('Cognitive task is already completed')
  return task
}

/**
 * Create a human assessment; a successful process alone never supplies these scores.
 * @param state - Current workspace history.
 * @param review - Explicit human scores and evidence references.
 * @param knownThreshold - Deployment threshold captured with this assessment.
 * @returns an immutable review event.
 */
export function cognitiveReview(state: CognitiveSnapshot, review: CognitiveReview, knownThreshold: number): CognitiveEvent {
  if (review.revision !== state.revision) throw new Error('Cognitive state changed; read status before reviewing')
  const { revision: _revision, ...fields } = review
  return { kind: 'assessment', value: { ...fields, knownThreshold, id: brandString<CognitiveAssessmentId>(randomUUID()), createdAt: new Date().toISOString() } }
}

/**
 * Validate relationships on append and replay before deriving task and quadrant state.
 * @param current - Last committed history.
 * @param event - Structurally validated journal event.
 * @returns a detached next state; invalid evidence or specification changes throw.
 */
export function applyCognitiveEvent(current: CognitiveSnapshot, event: CognitiveEvent): CognitiveSnapshot {
  const state = structuredClone(current)
  switch (event.kind) {
    case 'plugin': {
      const value = event.value
      const task = cognitiveTask(state, value.taskId)
      if (task.status !== 'active' || task.phase !== 'repair') throw new Error('Register improvement plugins during Repair')
      requireUniqueUnits(value.units)
      if (state.plugins.some(item => item.id === value.id)) throw new Error('Plugin artifacts are immutable')
      for (const unit of value.units) {
        requireUnit(state, unit)
        if (!task.units.some(selected => sameCognitiveUnit(selected, unit))) throw new Error('Plugin names an unselected cognitive revision')
      }
      state.plugins.push(value)
      break
    }
    case 'unit': {
      const previous = state.units.findLast(unit => unit.id === event.value.id)
      if (event.value.revision !== (previous?.revision ?? 0) + 1) throw new Error('Cognitive revisions must be contiguous and immutable')
      state.units.push(event.value)
      break
    }
    case 'task': {
      const task = event.value
      if (task.rubricHash !== cognitiveHash(JSON.stringify([task.situation, task.criteria]))) throw new Error('Task rubric hash mismatch')
      requireUniqueUnits(task.units)
      for (const unit of task.units) requireUnit(state, unit)
      const index = state.tasks.findIndex(item => item.id === task.id)
      if (index < 0) {
        if (task.phase !== 'clarify' || task.status !== 'active' || task.units.length !== 0) throw new Error('New tasks must begin in Clarify')
        state.tasks.push(task)
      } else {
        const previous = state.tasks[index]
        assert(previous)
        if (previous.objective !== task.objective || previous.outline !== task.outline || previous.rubricHash !== task.rubricHash
          || previous.createdAt !== task.createdAt) throw new Error('Task specification is immutable; create a revised task')
        requireTaskTransition(state, previous, task)
        state.tasks[index] = task
      }
      break
    }
    case 'evidence': {
      const value = event.value
      const task = cognitiveTask(state, value.taskId)
      if (task.status !== 'active' || task.phase !== value.phase) throw new Error('Evidence phase must match the active task')
      requireUniqueUnits(value.units)
      if (state.evidence.some(item => item.id === value.id)) throw new Error('Cognitive evidence is immutable')
      if (value.contentHash !== cognitiveHash(value.content)) throw new Error('Cognitive evidence hash mismatch')
      for (const unit of value.units) {
        requireUnit(state, unit)
        if (!task.units.some(selected => sameCognitiveUnit(selected, unit))) throw new Error('Evidence names an unselected cognitive revision')
      }
      if (value.source === 'execution' ? value.runId === null || value.versionId === null || value.success === null
        : value.runId !== null || value.versionId !== null || value.success !== null) throw new Error('Evidence acquisition fields do not match its source')
      if (value.source === 'execution' && state.evidence.some(item => item.runId === value.runId)) throw new Error('Execution evidence is already retained')
      if (value.pluginIds !== undefined && (value.source !== 'execution' || new Set(value.pluginIds).size !== value.pluginIds.length
        || value.pluginIds.some(id => !state.plugins.some(plugin => plugin.id === id)))) throw new Error('Plugin evidence requires registered execution artifacts')
      state.evidence.push(value)
      break
    }
    case 'assessment': {
      const value = event.value
      const target = value.target
      const task = cognitiveTask(state, value.taskId)
      if (state.assessments.some(item => item.id === value.id)) throw new Error('Cognitive assessments are immutable')
      if (new Set(value.evidenceIds).size !== value.evidenceIds.length) throw new Error('Assessment contains duplicate evidence')
      if (value.target !== null) {
        requireUnit(state, value.target)
        if (value.knowledge === null) throw new Error('Unit review requires an explicit knowledge score')
      } else if (value.knowledge !== null) throw new Error('Task acceptance has no knowledge coordinate')
      for (const id of value.evidenceIds) {
        const evidence = state.evidence.find(item => item.id === id)
        if (evidence === undefined || evidence.taskId !== task.id) throw new Error('Assessment requires evidence from its task')
        if (target !== null && !evidence.units.some(unit => sameCognitiveUnit(unit, target))) {
          throw new Error('Assessment evidence does not cover the cognitive revision')
        }
      }
      if (value.target !== null) {
        const previous = cognitivePosition(state, task, value.target)
        state.transitions.push({ assessmentId: value.id, target: value.target, rubricHash: task.rubricHash,
          from: previous.quadrant, to: quadrant(value) })
      }
      state.assessments.push(value)
      break
    }
    default: return assertNever(event)
  }
  state.revision++
  return state
}

/**
 * Retain actual execution as evidence without interpreting process success as task quality.
 * @param task - Specification and selected revisions captured before execution.
 * @param receipt - Observed native Session result.
 * @param pluginIds - Registered plugins captured by the execution owner.
 * @returns an execution evidence event.
 */
export function cognitiveExecution(task: CognitiveTask, receipt: {
  runId: AgentRunId
  sessionId: string
  output: string
  success: boolean
  error: string | null
}, pluginIds: CognitivePluginId[] = []): CognitiveEvent {
  const content = JSON.stringify({ output: receipt.output, error: receipt.error })
  const value: CognitiveEvidence = { id: brandString<CognitiveEvidenceId>(randomUUID()), taskId: task.id,
    units: task.units, phase: task.phase,
    source: 'execution', content, contentHash: cognitiveHash(content), runId: receipt.runId,
    sessionId: receipt.sessionId, success: receipt.success, createdAt: new Date().toISOString(),
    ...(pluginIds.length === 0 ? {} : { pluginIds }) }
  return { kind: 'evidence', value }
}
