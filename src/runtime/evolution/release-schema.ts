/** Durable release evidence validation and deployment configuration parsing. @module */

import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { ReleaseCommit, ReleaseConfig, ReleaseId, ReleaseRecord } from './release-types.ts'

const hash = z.string().regex(/^[0-9a-f]{64}$/)
const timestamp = z.number().int().nonnegative()
const duration = z.number().int().positive().max(MAX_TIMER_DELAY_MS)
const check = z.object({ name: z.string().min(1), command: z.string().min(1), args: z.array(z.string()) }).strict()

/** Rejects rev expressions, abbreviated hashes, and noncanonical commit identifiers. */
export const releaseCommitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
  .transform(value => value as ReleaseCommit)

/** Deployment settings must contain at least one named check and finite resource limits. */
export const releaseConfigSchema: z.ZodType<ReleaseConfig> = z.object({
  repositoryPath: z.string().refine(isAbsolute, 'repositoryPath must be absolute'),
  worktreeRoot: z.string().refine(isAbsolute, 'worktreeRoot must be absolute'),
  checks: z.array(check).min(1).refine(checks => new Set(checks.map(check => check.name)).size === checks.length, 'check names must be unique'),
  commandTimeoutMs: duration,
  terminationGraceMs: duration,
  maxOutputBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict()

/** Rejects incomplete or internally inconsistent validation evidence on durable read. */
export const releaseRecordSchema: z.ZodType<ReleaseRecord> = z.object({
  id: hash.transform(value => value as ReleaseId),
  candidateSha: releaseCommitSchema,
  baseSha: releaseCommitSchema,
  configHash: hash,
  repositoryPath: z.string().min(1),
  worktreePath: z.string().min(1),
  startedAt: timestamp,
  completedAt: timestamp,
  outcome: z.enum(['validated', 'failed']),
  checks: z.array(check.extend({
    startedAt: timestamp,
    completedAt: timestamp,
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    timedOut: z.boolean(),
    aborted: z.boolean(),
    error: z.string().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
  }).strict()).min(1),
  evidenceHash: hash,
}).strict().refine(record => record.outcome !== 'validated' || record.checks.every(result =>
  result.exitCode === 0 && result.signal === null && !result.timedOut && !result.aborted && result.error === null,
), 'validated records require successful exit facts for every operation')
