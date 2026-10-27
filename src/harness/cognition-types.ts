/** Domain-independent cognitive revisions, task phases and evidence-backed human assessments. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AgentRunId } from './types.ts'

/** Stable identity of one reusable judgment or method. */
export type CognitiveUnitId = Branded<'CognitiveUnitId'>
/** Identity of one task with fixed situation and acceptance criteria. */
export type CognitiveTaskId = Branded<'CognitiveTaskId'>
/** Identity of retained evidence, never a model-supplied success certificate. */
export type CognitiveEvidenceId = Branded<'CognitiveEvidenceId'>
/** Identity of a human evaluation of exact evidence. */
export type CognitiveAssessmentId = Branded<'CognitiveAssessmentId'>
/** Identity of one registered plugin artifact. */
export type CognitivePluginId = Branded<'CognitivePluginId'>
/** Immutable unit revision selected for a task or assessment. */
export interface CognitiveReference { id: CognitiveUnitId; revision: number }
/** Task phases are separate from harness build and comparison stages. */
export type CognitivePhase = 'clarify' | 'self-evaluation' | 'repair' | 'execute'
/** A quadrant is an evidence projection; unassessed is never a failing score. */
export type CognitiveQuadrant = 'I' | 'II' | 'III' | 'IV' | 'unassessed'
/** Reusable content; changes append revisions without modifying earlier evidence. */
export interface CognitiveUnit extends CognitiveReference {
  kind: 'judgment' | 'method'
  capability: string
  content: string
  applicability: string
  expectedOutcome: string
  implementation: string[]
  createdAt: string
}
/** Frozen task specification and current execution phase. */
export interface CognitiveTask {
  id: CognitiveTaskId
  objective: string
  outline: string
  situation: string
  criteria: string
  rubricHash: string
  phase: CognitivePhase
  status: 'active' | 'completed'
  units: CognitiveReference[]
  createdAt: string
}
/** Source facts and claimed outcomes remain distinguishable after restart. */
export interface CognitiveEvidence {
  id: CognitiveEvidenceId
  taskId: CognitiveTaskId
  units: CognitiveReference[]
  phase: CognitivePhase
  source: 'submitted' | 'execution'
  content: string
  contentHash: string
  runId: AgentRunId | null
  /** Retained only when importing historical evidence; never used for execution. */
  versionId?: string | null | undefined
  /** Native Session containing the observed execution. */
  sessionId?: string | undefined
  success: boolean | null
  /** Host-captured plugin artifacts used by this execution; absent in earlier records. */
  pluginIds?: CognitivePluginId[] | undefined
  createdAt: string
}
/** Explicit human scores against one task's immutable rubric and retained evidence. */
export interface CognitiveAssessment {
  id: CognitiveAssessmentId
  taskId: CognitiveTaskId
  target: CognitiveReference | null
  evidenceIds: CognitiveEvidenceId[]
  knowledge: number | null
  effectiveness: number
  knownThreshold: number
  rationale: string
  createdAt: string
}
/** A retained transition explains the evidence and scope behind a current coordinate. */
export interface CognitiveTransition {
  assessmentId: CognitiveAssessmentId
  target: CognitiveReference
  rubricHash: string
  from: CognitiveQuadrant
  to: CognitiveQuadrant
}
/** Current task-scoped cognitive coordinates with the exact supporting assessment. */
export interface CognitivePosition {
  target: CognitiveReference
  rubricHash: string
  knowledge: number | null
  effectiveness: number | null
  quadrant: CognitiveQuadrant
  assessmentId: CognitiveAssessmentId | null
}
/** A local bundle bound to exact cognitive revisions and immutable file content. */
export interface CognitivePlugin {
  id: CognitivePluginId
  taskId: CognitiveTaskId
  units: CognitiveReference[]
  directory: string
  name: string
  version: string
  contentHash: string
  createdAt: string
}
/** Registration requests identify existing workspace files, not an asserted installation result. */
export interface CognitivePluginRequest {
  revision: number
  taskId: CognitiveTaskId
  units: CognitiveReference[]
  directory: string
}
/** Selection belongs to the project profile; source checks include local plugin dependencies. */
export interface CognitivePluginStatus {
  artifact: CognitivePlugin
  state: 'selected' | 'changed' | 'disabled'
}
/** Owned source directories, profile identity and bundle selection. */
export interface CognitivePluginSnapshot {
  directory: string
  pluginDirectory: string
  profile: { name: string; directory: string; bundles: string[]; contentHash: string }
  required: boolean
  plugins: CognitivePluginStatus[]
}
/** Persisted records and their derived map; each workspace owns an independent history. */
export interface CognitiveSnapshot {
  revision: number
  units: CognitiveUnit[]
  tasks: CognitiveTask[]
  evidence: CognitiveEvidence[]
  assessments: CognitiveAssessment[]
  transitions: CognitiveTransition[]
  plugins: CognitivePlugin[]
}
/** Model-accessible proposals and task progression; no command accepts a human score. */
export type CognitiveCommand = { revision: number } & (
  | { action: 'unit'
    id: CognitiveUnitId | null
    kind: CognitiveUnit['kind']
    capability: string
    content: string
    applicability: string
    expectedOutcome: string
    implementation: string[] }
  | { action: 'task'; objective: string; outline: string; situation: string; criteria: string }
  | { action: 'select'; taskId: CognitiveTaskId; units: CognitiveReference[] }
  | { action: 'advance'; taskId: CognitiveTaskId }
  | { action: 'reassess'; taskId: CognitiveTaskId }
  | { action: 'evidence'; taskId: CognitiveTaskId; units: CognitiveReference[]; content: string }
  | { action: 'complete'; taskId: CognitiveTaskId }
)
/** Human-only input; the model tool and child bridge do not expose this operation. */
export interface CognitiveReview {
  revision: number
  taskId: CognitiveTaskId
  target: CognitiveReference | null
  evidenceIds: CognitiveEvidenceId[]
  knowledge: number | null
  effectiveness: number
  rationale: string
}
/** A task execution captures the phase and selected units before running. */
export interface CognitiveExecutionRequest { taskId: CognitiveTaskId; revision: number }
/** Immutable journal event; task updates preserve their original specification. */
export type CognitiveEvent =
  | { kind: 'unit'; value: CognitiveUnit }
  | { kind: 'task'; value: CognitiveTask }
  | { kind: 'evidence'; value: CognitiveEvidence }
  | { kind: 'assessment'; value: CognitiveAssessment }
  | { kind: 'plugin'; value: CognitivePlugin }
