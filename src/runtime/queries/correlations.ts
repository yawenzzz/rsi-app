/** Current-exposure correlations from complete, aligned probability-change samples. */
import type { ConsoleSource } from './source.ts'
import type { CorrelationView } from './types.ts'

type CorrelationSource = Pick<ConsoleSource, 'now' | 'observations'> & {
  account: Pick<ConsoleSource['account'], 'positions'>
  config: Pick<ConsoleSource['config'], 'correlationWindowMs' | 'correlationBucketMs' | 'correlationMinSamples' | 'correlationMaxGroups'>
}

interface HoldingSeries {
  cost: number
  points: Map<number, { at: number; value: number }>
}

/**
 * Compare category probability changes weighted by the current holdings' purchase costs.
 * @param source - Open positions, retained observations and explicit sampling settings.
 * @returns paired complete-bucket coefficients; insufficient or constant series remain null.
 */
export function queryCorrelations(source: CorrelationSource): CorrelationView {
  const { correlationWindowMs: windowMs, correlationBucketMs: bucketMs,
    correlationMinSamples: minSamples, correlationMaxGroups: maxGroups } = source.config
  const groups = new Map<string, HoldingSeries[]>()
  for (const position of source.account.positions) {
    const observations = source.observations.filter(item => item.book.tokenId === position.tokenId && item.book.observedAt <= source.now)
    const latest = observations.reduce<(typeof observations)[number] | undefined>((a, b) =>
      a === undefined || a.book.observedAt < b.book.observedAt ? b : a, undefined)
    const category = latest?.market.category
    if (category === undefined || position.costMicros === 0) continue
    const series: HoldingSeries = { cost: position.costMicros, points: new Map() }
    for (const observation of observations) {
      const at = observation.book.observedAt
      const bucket = Math.floor(at / bucketMs)
      if (at < source.now - windowMs || bucket >= Math.floor(source.now / bucketMs)) continue
      const previous = series.points.get(bucket)
      if (previous === undefined || previous.at < at) series.points.set(bucket, { at, value: observation.baselineProbability })
    }
    const group = groups.get(category) ?? []
    group.push(series)
    groups.set(category, group)
  }
  const total = (series: HoldingSeries[]) => series.reduce((sum, item) => sum + item.cost, 0)
  const selected = [...groups].sort((a, b) => total(b[1]) - total(a[1]) || a[0].localeCompare(b[0])).slice(0, maxGroups)
  const means = new Map(selected.map(([category, series]) => {
    const changes = new Map<number, number>()
    const buckets = new Set(series.flatMap(item => [...item.points.keys()]))
    for (const bucket of buckets) {
      let weighted = 0
      let complete = true
      for (const item of series) {
        const previous = item.points.get(bucket - 1)
        const current = item.points.get(bucket)
        if (previous === undefined || current === undefined) { complete = false; break }
        weighted += item.cost * (current.value - previous.value)
      }
      if (complete) changes.set(bucket, weighted / total(series))
    }
    return [category, changes] as const
  }))
  const cells: CorrelationView['cells'] = []
  for (const [row, a] of means) for (const [column, b] of means) {
    const pairs = [...a].flatMap(([bucket, value]) => {
      const other = b.get(bucket)
      return other === undefined ? [] : [[value, other] as const]
    })
    let correlation: number | null = null
    if (pairs.length >= minSamples) {
      const meanA = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length
      const meanB = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length
      let covariance = 0
      let varianceA = 0
      let varianceB = 0
      for (const [x, y] of pairs) {
        covariance += (x - meanA) * (y - meanB)
        varianceA += (x - meanA) ** 2
        varianceB += (y - meanB) ** 2
      }
      if (varianceA > 0 && varianceB > 0) correlation = Math.max(-1, Math.min(1, covariance / Math.sqrt(varianceA * varianceB)))
    }
    cells.push({ row, column, samples: pairs.length, correlation })
  }
  return { categories: selected.map(([category]) => category), windowMs, bucketMs, minSamples, cells }
}
