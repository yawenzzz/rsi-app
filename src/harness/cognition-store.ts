/** Cognitive history owned independently of runtime installation or process generations. */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cognitiveEventSchema } from './cognition-schema.ts'
import { applyCognitiveEvent, initialCognition } from './cognition.ts'
import type { CognitiveEvent, CognitiveSnapshot } from './cognition-types.ts'

/** Append-only cognitive records with writer-lease validation and bounded records. */
export class CognitionStore {
  private state = initialCognition()
  private readonly fd: number
  private closed = false
  private failed = false

  /**
   * Open project cognitive history without creating execution or source repositories.
   * @param directory - Project-owned state directory.
   * @param assertWriter - Exclusive ownership check before every write.
   * @param maxRecordBytes - Maximum complete encoded event size.
   * @param maxRecords - Lifetime record allowance, never a truncation policy.
   */
  constructor(directory: string, private readonly assertWriter: () => void,
    private readonly maxRecordBytes: number, private readonly maxRecords: number) {
    assertWriter()
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, 'cognition.jsonl')
    this.fd = openSync(path, 'a+', 0o600)
    try {
      const bytes = readFileSync(path)
      const end = bytes.lastIndexOf(10) + 1
      if (end !== bytes.length) { assertWriter(); truncateSync(path, end); fsyncSync(this.fd) }
      for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
        if (!line) continue
        if (Buffer.byteLength(line) + 1 > maxRecordBytes) throw new Error('Cognitive record exceeds maxRecordBytes')
        this.state = applyCognitiveEvent(this.state, cognitiveEventSchema.parse(JSON.parse(line)))
      }
    } catch (error) { closeSync(this.fd); throw error }
  }

  /**
   * Read the latest durable cognitive projection.
   * @returns detached cognitive state, including retained human assessments.
   */
  snapshot(): CognitiveSnapshot { return structuredClone(this.state) }

  /**
   * Commit a validated event before publishing its state.
   * @param event - Proposed cognitive mutation.
   * @returns committed state.
   */
  append(event: CognitiveEvent): CognitiveSnapshot {
    if (this.closed || this.failed) throw new Error('Cognitive history is closed or has an uncertain write')
    this.assertWriter()
    if (this.state.revision >= this.maxRecords) throw new Error('Cognitive history capacity reached')
    const validated = cognitiveEventSchema.parse(event)
    const next = applyCognitiveEvent(this.state, validated)
    const line = JSON.stringify(validated) + '\n'
    if (Buffer.byteLength(line) > this.maxRecordBytes) throw new Error('Cognitive record exceeds maxRecordBytes')
    try { writeFileSync(this.fd, line); fsyncSync(this.fd) } catch (error) { this.failed = true; throw error }
    this.state = next
    return this.snapshot()
  }

  /** Release the journal handle after callers have stopped writing. */
  close(): void { if (!this.closed) { this.closed = true; closeSync(this.fd) } }
}
