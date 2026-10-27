/** Complete tool-result byte limits apply to Unicode JSON and omission receipts. */
import { describe, expect, it } from 'vitest'
import { encodeToolResult } from '../../src/runtime/tools.ts'

describe('bounded research tool output', () => {
  it('retains an exact-limit JSON result including multibyte text', () => {
    const value = { evidence: '气温 🌡️' }
    const encoded = JSON.stringify(value)
    expect(Buffer.byteLength(encoded)).toBeGreaterThan(encoded.length)
    expect(encodeToolResult(value, Buffer.byteLength(encoded))).toBe(encoded)
  })

  it('replaces an oversized result with a complete bounded omission receipt', () => {
    const value = { evidence: '数据'.repeat(1000) }
    const result = encodeToolResult(value, 256)
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(256)
    expect(JSON.parse(result)).toMatchObject({ omitted: true, bytes: Buffer.byteLength(JSON.stringify(value)) })
    expect(result).not.toContain('数据')
  })

  it('rejects an allowance that cannot fit even the omission receipt', () => {
    expect(() => encodeToolResult({ evidence: 'data' }, 1)).toThrow('Tool output allowance is too small for its omission receipt')
  })
})
