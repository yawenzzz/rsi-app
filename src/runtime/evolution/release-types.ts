/** Immutable evidence from configured checks against a detached Git candidate. @module */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Exact local Git commit object identifier. */
export type ReleaseCommit = Branded<'rsi.release-commit'>
/** SHA-256 identifier of one candidate and its validation configuration. */
export type ReleaseId = Branded<'rsi.release'>

/** Deployment-owned executable and arguments; never supplied by a model tool. */
export interface ReleaseCheck {
  /** Unique check label retained with validation results. */
  name: string
  /** Executable resolved by the configured subprocess provider. */
  command: string
  /** Literal argument list passed to the executable. */
  args: string[]
}

/** Local repository and bounded validation policy, fixed for a validator's lifetime. */
export interface ReleaseConfig {
  /** Absolute local repository path containing the candidate commit. */
  repositoryPath: string
  /** Absolute directory owning private detached validation worktrees. */
  worktreeRoot: string
  /** Nonempty deployment-owned check list; check names must be unique. */
  checks: ReleaseCheck[]
  /** Deadline for each check or Git operation, in milliseconds. */
  commandTimeoutMs: number
  /** Subprocess termination grace period in milliseconds. */
  terminationGraceMs: number
  /** Byte limit for each retained output tail and diagnostic error message. */
  maxOutputBytes: number
}

/** Independent exit and cancellation facts, with bounded diagnostic tails. */
export interface ReleaseCheckResult extends ReleaseCheck {
  startedAt: number
  completedAt: number
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  aborted: boolean
  error: string | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

/** A validated candidate is not a deployed version; records never change after insertion. */
export interface ReleaseRecord {
  id: ReleaseId
  candidateSha: ReleaseCommit
  baseSha: ReleaseCommit
  configHash: string
  repositoryPath: string
  worktreePath: string
  startedAt: number
  completedAt: number
  outcome: 'validated' | 'failed'
  /** Configured checks and Git preparation/integrity operations in execution order. */
  checks: ReleaseCheckResult[]
  /** SHA-256 of the JSON-encoded checks, including their retained diagnostic tails. */
  evidenceHash: string
}

/** Duplicate requests return their prior evidence explicitly, without rerunning checks. */
export interface ReleaseValidation {
  record: ReleaseRecord
  reused: boolean
}

/** Single-writer persistent evidence; callers must close after validator disposal. */
export interface ReleaseRecordStore {
  /** @returns detached timeline fields for committed validation records, without command output. */
  list(): Array<Pick<ReleaseRecord, 'id' | 'candidateSha' | 'completedAt' | 'outcome'>>
  /**
   * Read the original evidence for one validation identity.
   * @param id - Retained validation identifier.
   * @returns a detached record, or undefined for an unknown identity.
   */
  get(id: ReleaseId): ReleaseRecord | undefined
  /**
   * Find prior evidence for one candidate and configuration.
   * @param candidateSha - exact commit identifier.
   * @param configHash - fingerprint of deployment-owned validation settings.
   * @returns a detached record, or undefined when no evidence exists.
   */
  find(candidateSha: ReleaseCommit, configHash: string): ReleaseRecord | undefined
  /**
   * Insert evidence without replacing any prior record.
   * @param record - completed validation evidence.
   * @returns after the immutable insertion becomes durable.
   */
  append(record: ReleaseRecord): Promise<void>
  /** @returns after all pending writes and the domain close complete. */
  close(): Promise<void>
}

/** Owns queued validations and their child processes until disposal completes. */
export interface ReleaseValidator {
  /**
   * Validate an exact local commit using only deployment-configured checks.
   * @param candidateSha - full lowercase SHA-1 or SHA-256 commit identifier.
   * @param signal - cancellation of the request, including while queued.
   * @returns durable evidence; reused records do not represent a fresh run.
   */
  validate(candidateSha: string, signal?: AbortSignal): Promise<ReleaseValidation>
  /** @returns after queued requests settle and owned processes stop. */
  dispose(): Promise<void>
}
