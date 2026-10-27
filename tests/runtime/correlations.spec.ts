/** Portfolio-weighted correlation samples exclude unheld tokens and incomplete buckets. */
import { describe, expect, it } from 'vitest'
import { queryCorrelations } from '../../src/runtime/queries/correlations.ts'
import { holding, observation } from './fixtures/observations.ts'

function source() {
  return {
    now: 50_000, observations: [] as ReturnType<typeof observation>[], account: { positions: [] as ReturnType<typeof holding>[] },
    config: { correlationWindowMs: 50_000, correlationBucketMs: 10_000, correlationMinSamples: 3, correlationMaxGroups: 8 },
  }
}

describe('position category correlations', () => {
  it('measures aligned changes of held tokens without cancelling them against unheld outcomes', () => {
    const input = source()
    const levels = [0.5, 0.6, 0.5, 0.7, 0.6]
    levels.forEach((price, index) => {
      const at = index * 10_000 + 1000
      input.observations.push(observation('a', at, price, 'A'), observation('a-other', at, 1 - price, 'A'),
        observation('b', at, 1 - price, 'B'))
    })
    input.account.positions = [holding(observation('a')), holding(observation('b'))]
    const result = queryCorrelations(input)
    expect(result.categories).toEqual(['A', 'B'])
    expect(result.cells.find(cell => cell.row === 'A' && cell.column === 'B')).toMatchObject({ samples: 4 })
    expect(result.cells.find(cell => cell.row === 'A' && cell.column === 'B')?.correlation).toBeCloseTo(-1)
    expect(result.cells.find(cell => cell.row === 'A' && cell.column === 'A')?.correlation).toBeCloseTo(1)
  })

  it('requires every holding in a category and pairs only adjacent complete buckets', () => {
    const input = source()
    for (let i = 0; i < 5; i++) {
      input.observations.push(observation('a', i * 10_000 + 1000, 0.4 + i * 0.01, 'A'))
      if (i !== 2) input.observations.push(observation('a2', i * 10_000 + 1000, 0.3 + i * 0.02, 'A'))
    }
    input.account.positions = [holding(observation('a')), holding(observation('a2'))]
    expect(queryCorrelations(input).cells).toEqual([{ row: 'A', column: 'A', samples: 2, correlation: null }])
  })

  it('uses cost weights, latest bucket observations and the largest category exposures', () => {
    const input = source()
    const prices = [0.5, 0.6, 0.5, 0.7, 0.6]
    prices.forEach((price, i) => {
      input.observations.push(observation('a', i * 10_000 + 2000, price, 'A'),
        observation('a', i * 10_000 + 1000, 0.9, 'A'), observation('a2', i * 10_000 + 2000, 1 - price, 'A'),
        observation('b', i * 10_000 + 2000, price, 'B'))
    })
    input.account.positions = [holding(observation('a'), 3_000_000), holding(observation('a2'), 1_000_000), holding(observation('b'))]
    expect(queryCorrelations(input).cells.find(cell => cell.row === 'A' && cell.column === 'B')?.correlation).toBeCloseTo(1)
    input.config.correlationMaxGroups = 1
    expect(queryCorrelations(input).categories).toEqual(['A'])
  })

  it('keeps constant series unavailable and ignores observations outside the closed sampling window', () => {
    const input = source()
    input.config.correlationWindowMs = 30_000
    input.config.correlationMinSamples = 2
    for (let i = 0; i < 8; i++) input.observations.push(observation('a', i * 10_000 + 1000, i < 5 ? 0.5 : 0.8, 'A'))
    input.account.positions = [holding(observation('a'))]
    expect(queryCorrelations(input).cells).toEqual([{ row: 'A', column: 'A', samples: 2, correlation: null }])
  })

  it('keeps missing category history visible without inventing zero correlations', () => {
    const input = source()
    input.account.positions = [holding(observation('a')), holding(observation('unknown')), holding(observation('free'), 0)]
    input.observations = [observation('a', 40_000, 0.5, 'A'), observation('unknown'), observation('free', 40_000, 0.5, 'Free')]
    expect(queryCorrelations(input).cells).toEqual([{ row: 'A', column: 'A', samples: 0, correlation: null }])
    input.account.positions = []
    expect(queryCorrelations(input).categories).toEqual([])
  })

  it('does not pair price changes from different time buckets', () => {
    const input = source()
    for (const i of [0, 1, 2]) input.observations.push(observation('a', i * 10_000 + 1000, 0.4 + i * 0.01, 'A'))
    for (const i of [2, 3, 4]) input.observations.push(observation('b', i * 10_000 + 1000, 0.5 + i * 0.02, 'B'))
    input.account.positions = [holding(observation('a')), holding(observation('b'))]
    expect(queryCorrelations(input).cells.find(cell => cell.row === 'A' && cell.column === 'B'))
      .toEqual({ row: 'A', column: 'B', samples: 0, correlation: null })
  })
})
