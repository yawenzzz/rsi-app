/** Model, wire and journal validation for generic cognitive tasks. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CognitiveAssessment, CognitiveAssessmentId, CognitiveCommand, CognitiveEvent, CognitiveEvidence,
  CognitiveEvidenceId, CognitiveReference, CognitiveReview, CognitiveTask, CognitiveTaskId, CognitiveUnit, CognitiveUnitId,
  CognitivePlugin, CognitivePluginId, CognitivePluginRequest } from './cognition-types.ts'

import type { AgentRunId } from './types.ts'

const text = z.string().trim().min(1)
const timestamp = z.iso.datetime()
const unitId = z.uuid().transform(brandString<CognitiveUnitId>)
const taskId = z.uuid().transform(brandString<CognitiveTaskId>)
const evidenceId = z.uuid().transform(brandString<CognitiveEvidenceId>)
const revision = z.int().nonnegative()
const reference: z.ZodType<CognitiveReference> = z.strictObject({ id: unitId, revision: z.int().positive() })
const unitFields = {
  kind: z.enum(['judgment', 'method']), capability: text, content: text,
  applicability: text, expectedOutcome: text, implementation: z.array(text),
}
const unit: z.ZodType<CognitiveUnit> = z.strictObject({
  ...unitFields, id: unitId, revision: z.int().positive(), createdAt: timestamp,
})
const taskFields = { objective: text, outline: text, situation: text, criteria: text }
const task: z.ZodType<CognitiveTask> = z.strictObject({
  ...taskFields, id: taskId, rubricHash: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(['clarify', 'self-evaluation', 'repair', 'execute']), status: z.enum(['active', 'completed']),
  units: z.array(reference), createdAt: timestamp,
})
const evidence: z.ZodType<CognitiveEvidence> = z.strictObject({
  id: evidenceId, taskId, units: z.array(reference), phase: z.enum(['clarify', 'self-evaluation', 'repair', 'execute']),
  source: z.enum(['submitted', 'execution']), content: text, contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  runId: text.transform(brandString<AgentRunId>).nullable(), versionId: text.nullable().optional(), sessionId: text.optional(),
  success: z.boolean().nullable(), createdAt: timestamp,
  pluginIds: z.array(z.uuid().transform(brandString<CognitivePluginId>)).optional(),
})
const reviewFields = {
  taskId, target: reference.nullable(), evidenceIds: z.array(evidenceId).min(1),
  knowledge: z.number().min(0).max(1).nullable(), effectiveness: z.number().min(-1).max(1), rationale: text,
}
const assessment: z.ZodType<CognitiveAssessment> = z.strictObject({
  ...reviewFields, id: z.uuid().transform(brandString<CognitiveAssessmentId>),
  knownThreshold: z.number().gt(0).lte(1), createdAt: timestamp,
})
const plugin: z.ZodType<CognitivePlugin> = z.strictObject({
  id: z.uuid().transform(brandString<CognitivePluginId>), taskId, units: z.array(reference).min(1),
  directory: text, name: text, version: text, contentHash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: timestamp,
})
/** Artifact registration accepts only existing paths and exact cognitive revisions. */
export const cognitivePluginRequestSchema: z.ZodType<CognitivePluginRequest> = z.strictObject({
  revision, taskId, units: z.array(reference).min(1), directory: text,
})
/** Validated append-only cognitive records, including facts required for replay. */
export const cognitiveEventSchema: z.ZodType<CognitiveEvent> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unit'), value: unit }),
  z.strictObject({ kind: z.literal('task'), value: task }),
  z.strictObject({ kind: z.literal('evidence'), value: evidence }),
  z.strictObject({ kind: z.literal('assessment'), value: assessment }),
  z.strictObject({ kind: z.literal('plugin'), value: plugin }),
])
/** Model commands cannot submit assessments or manufacture execution receipts. */
export const cognitiveCommandSchema: z.ZodType<CognitiveCommand> = z.discriminatedUnion('action', [
  z.strictObject({ revision, action: z.literal('unit'), id: unitId.nullable(), ...unitFields }),
  z.strictObject({ revision, action: z.literal('task'), ...taskFields }),
  z.strictObject({ revision, action: z.literal('select'), taskId, units: z.array(reference).min(1) }),
  z.strictObject({ revision, action: z.literal('advance'), taskId }),
  z.strictObject({ revision, action: z.literal('reassess'), taskId }),
  z.strictObject({ revision, action: z.literal('evidence'), taskId, units: z.array(reference), content: text }),
  z.strictObject({ revision, action: z.literal('complete'), taskId }),
])
/** Human ratings require explicit evidence and keep unavailable knowledge null. */
export const cognitiveReviewSchema: z.ZodType<CognitiveReview> = z.strictObject({ revision, ...reviewFields })

/** Complete cognitive projection validated on process-control responses. */
export const cognitiveSnapshotSchema: z.ZodType<import('./cognition-types.ts').CognitiveSnapshot> = z.strictObject({
  revision, units: z.array(unit), tasks: z.array(task), evidence: z.array(evidence), assessments: z.array(assessment),
  transitions: z.array(z.strictObject({ assessmentId: z.uuid().transform(brandString<CognitiveAssessmentId>),
    target: reference, rubricHash: text, from: z.enum(['I', 'II', 'III', 'IV', 'unassessed']), to: z.enum(['I', 'II', 'III', 'IV', 'unassessed']) })),
  plugins: z.array(plugin),
})
/** Project bundle status validated on process-control responses. */
export const cognitivePluginSnapshotSchema: z.ZodType<import('./cognition-types.ts').CognitivePluginSnapshot> = z.strictObject({
  directory: text, pluginDirectory: text, required: z.boolean(),
  profile: z.strictObject({ name: text, directory: text, bundles: z.array(text), contentHash: text }),
  plugins: z.array(z.strictObject({ artifact: plugin, state: z.enum(['selected', 'changed', 'disabled']) })),
})
