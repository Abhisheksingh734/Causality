import type { MetricSample } from './store'

/** Below this many samples, percentiles are noise rather than signal. */
export const MIN_SAMPLES = 5

/**
 * Nearest-rank percentile: sort ascending, take the value at
 * ceil(p * n) - 1, clamped into range. No interpolation — every value
 * returned is a real observed measurement.
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  // Copy before sorting: callers keep their array order.
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil(p * sorted.length) - 1
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))]
}

export type LatencySegment = 'all' | 'get' | 'post' | 'hit' | 'miss'

export const SEGMENT_LABELS: Record<LatencySegment, string> = {
  all: 'All requests',
  get: 'GET only',
  post: 'POST only',
  hit: 'Cache hits only',
  miss: 'Cache misses only',
}

/**
 * Durations of genuinely completed requests, across the WHOLE session rather
 * than the log viewer's last 200 entries. Failures are excluded: a request
 * rejected at a full queue measures how fast it was turned away, which is not
 * a latency sample.
 */
export function latencySamples(
  samples: MetricSample[],
  segment: LatencySegment = 'all',
): number[] {
  const out: number[] = []
  for (const sample of samples) {
    if (sample.outcome !== 'success') continue
    if (segment === 'get' && sample.method !== 'GET') continue
    if (segment === 'post' && sample.method !== 'POST') continue
    if (segment === 'hit' && sample.cache !== 'hit') continue
    if (segment === 'miss' && sample.cache !== 'miss') continue
    out.push(sample.d)
  }
  return out
}

/**
 * Fixed round-number buckets rather than min..max. A stable axis is what lets
 * you flip between "cache hits" and "cache misses" and actually compare the
 * two shapes; a rescaling axis would make them look identical.
 */
const BUCKET_BOUNDS = [0, 100, 250, 500, 1000, 2000, 3000, 5000]

/** 950 -> "950", 2000 -> "2s". */
function formatBound(ms: number): string {
  return ms < 1000 ? `${ms}` : `${ms / 1000}s`
}

/**
 * Buckets are labelled with their full range, never with a single number.
 * Labelling the 100-250ms bar "250" and centring that under the bar read as
 * "this bar is 250ms", which made a p50 of 198ms look like it disagreed with
 * its own histogram.
 */
export function bucketLabel(from: number, to: number | null): string {
  if (to === null) return `${formatBound(from)}+`
  if (from === 0) return `<${formatBound(to)}`
  return `${formatBound(from)}-${formatBound(to)}`
}

export type HistogramBucket = {
  label: string
  from: number
  /** Null on the final open-ended bucket. */
  to: number | null
  count: number
}

export function histogram(values: number[]): HistogramBucket[] {
  const buckets: HistogramBucket[] = BUCKET_BOUNDS.map((from, index) => {
    const to = index + 1 < BUCKET_BOUNDS.length ? BUCKET_BOUNDS[index + 1] : null
    return {
      from,
      to,
      label: bucketLabel(from, to),
      count: 0,
    }
  })

  for (const value of values) {
    let index = buckets.length - 1
    for (let i = 0; i < buckets.length; i += 1) {
      const bucket = buckets[i]
      if (bucket.to !== null && value < bucket.to) {
        index = i
        break
      }
    }
    buckets[index].count += 1
  }

  return buckets
}

/** Index of the bucket a value falls into, or -1. */
export function bucketIndexOf(
  buckets: HistogramBucket[],
  value: number | null,
): number {
  if (value === null) return -1
  for (let i = 0; i < buckets.length; i += 1) {
    const bucket = buckets[i]
    if (bucket.to === null || value < bucket.to) return i
  }
  return buckets.length - 1
}
