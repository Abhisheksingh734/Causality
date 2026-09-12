import type { MetricSample } from './store'

/** Rolling window, in one-second buckets. */
export const WINDOW_SECONDS = 30

export type HealthBucket = {
  /** Unix second this bucket covers. */
  second: number
  successCount: number
  failedCount: number
}

/**
 * Buckets resolved requests by the second they finished in.
 *
 * Reads the session-wide sample store rather than the log's 200-entry viewer
 * buffer, so a long run charts every second of itself instead of only the tail
 * the log happens to be holding. Only resolved requests produce a sample.
 */
export function bucketSamples(
  samples: MetricSample[],
  now: number = Date.now(),
): HealthBucket[] {
  const newestSecond = Math.floor(now / 1000)
  const oldestSecond = newestSecond - (WINDOW_SECONDS - 1)

  const buckets: HealthBucket[] = []
  const bySecond = new Map<number, HealthBucket>()
  for (let second = oldestSecond; second <= newestSecond; second += 1) {
    const bucket: HealthBucket = { second, successCount: 0, failedCount: 0 }
    buckets.push(bucket)
    bySecond.set(second, bucket)
  }

  // One pass; anything outside the window simply finds no bucket, which is
  // what drops buckets older than the window.
  for (const sample of samples) {
    const bucket = bySecond.get(Math.floor(sample.t / 1000))
    if (!bucket) continue
    if (sample.outcome === 'success') bucket.successCount += 1
    else bucket.failedCount += 1
  }

  return buckets
}

export type HealthStatus = 'idle' | 'healthy' | 'degraded' | 'critical'

export type HealthSummary = {
  total: number
  success: number
  failed: number
  /** Null when nothing has resolved in the window. */
  successRate: number | null
  failureRate: number | null
  status: HealthStatus
  /** Tallest bar in the window, for scaling the chart. */
  peak: number
}

export function summarize(buckets: HealthBucket[]): HealthSummary {
  let success = 0
  let failed = 0
  let peak = 0

  for (const bucket of buckets) {
    success += bucket.successCount
    failed += bucket.failedCount
    peak = Math.max(peak, bucket.successCount + bucket.failedCount)
  }

  const total = success + failed
  if (total === 0) {
    return {
      total: 0,
      success: 0,
      failed: 0,
      successRate: null,
      failureRate: null,
      status: 'idle',
      peak: 0,
    }
  }

  const failureRate = (failed / total) * 100
  return {
    total,
    success,
    failed,
    successRate: 100 - failureRate,
    failureRate,
    // Under 5% failures is noise; a quarter of all requests failing is a
    // system that is not serving its users.
    status: failureRate < 5 ? 'healthy' : failureRate <= 25 ? 'degraded' : 'critical',
    peak,
  }
}
