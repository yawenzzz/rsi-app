/** Cursor validation for bounded console queries. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ConsoleCursor, ConsolePage } from './types.ts'

/**
 * Continue after a stable row identity, refusing another filter's cursor.
 * @param rows - Already filtered and deterministically ordered rows.
 * @param id - Stable row identity.
 * @param cursor - Prior page's opaque continuation or null.
 * @param limit - Wire page limit, between one and one hundred.
 * @param filter - Complete query meaning, excluding pagination.
 * @returns the bounded page and continuation token.
 */
export function pageOf<T>(
  rows: readonly T[], id: (row: T) => string, cursor: ConsoleCursor | null, limit: number, filter: unknown,
): ConsolePage<T> {
  z.number().int().min(1).max(100).parse(limit)
  const digest = createHash('sha256').update(JSON.stringify(filter)).digest('hex')
  let start = 0
  if (cursor !== null) {
    const decoded = z.tuple([z.string(), z.string()]).parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
    if (decoded[0] !== digest) throw new Error('Console cursor belongs to another query')
    const previous = rows.findIndex(row => id(row) === decoded[1])
    if (previous < 0) throw new Error('Console cursor is stale; refresh the list')
    start = previous + 1
  }
  const items = rows.slice(start, start + limit)
  const last = items.at(-1)
  return {
    items, total: rows.length,
    nextCursor: last === undefined || start + items.length >= rows.length ? null
      : brandString<ConsoleCursor>(Buffer.from(JSON.stringify([digest, id(last)])).toString('base64url')),
  }
}
