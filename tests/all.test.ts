/**
 * Run with `npm test`.
 *
 * These cover the two things that made the Latency panel untrustworthy: the
 * headline percentiles appearing to disagree with the histogram underneath
 * them, and the same design reporting a different number on every run.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  bucketIndexOf,
  histogram,
  latencySamples,
  percentile,
  type HistogramBucket,
} from '../src/latency'
import type { MetricSample } from '../src/store'

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Deterministic PRNG so a failure is always reproducible from its seed. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const sample = (d: number): MetricSample => ({
  t: 0,
  d,
  outcome: 'success',
  method: 'GET',
  cache: 'not_applicable',
})

/**
 * Reads a rendered axis label back into the numeric range it claims, so the
 * test checks what a user actually sees rather than the bucket's internals.
 */
function parseLabel(label: string): { from: number; to: number | null } {
  const num = (text: string) =>
    text.endsWith('s') ? Number(text.slice(0, -1)) * 1000 : Number(text)
  if (label.endsWith('+')) return { from: num(label.slice(0, -1)), to: null }
  if (label.startsWith('<')) return { from: 0, to: num(label.slice(1)) }
  const [from, to] = label.split('-')
  return { from: num(from), to: num(to) }
}

/* ------------------------------------------------------------------ *
 * Percentiles
 * ------------------------------------------------------------------ */

describe('percentile', () => {
  it('returns null with no samples', () => {
    assert.equal(percentile([], 0.5), null)
  })

  it('matches nearest-rank on a known set', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    assert.equal(percentile(values, 0.5), 50)
    assert.equal(percentile(values, 0.95), 100)
    assert.equal(percentile(values, 0.99), 100)
  })

  it('ignores input order', () => {
    const ordered = [5, 15, 25, 35, 45]
    const shuffled = [35, 5, 45, 15, 25]
    assert.equal(percentile(ordered, 0.5), percentile(shuffled, 0.5))
  })

  it('does not mutate the caller array', () => {
    const values = [3, 1, 2]
    percentile(values, 0.5)
    assert.deepEqual(values, [3, 1, 2])
  })

  it('always returns a value that was actually observed', () => {
    const random = rng(7)
    for (let trial = 0; trial < 200; trial += 1) {
      const n = 1 + Math.floor(random() * 60)
      const values = Array.from({ length: n }, () =>
        Math.floor(random() * 6000),
      )
      for (const p of [0.5, 0.95, 0.99]) {
        const got = percentile(values, p)
        assert.ok(
          values.includes(got as number),
          `p${p * 100}=${got} is not one of the samples`,
        )
      }
    }
  })

  it('never reports a p50 above p95 above p99', () => {
    const random = rng(11)
    for (let trial = 0; trial < 200; trial += 1) {
      const n = 5 + Math.floor(random() * 80)
      const values = Array.from({ length: n }, () =>
        Math.floor(random() * 4000),
      )
      const p50 = percentile(values, 0.5) as number
      const p95 = percentile(values, 0.95) as number
      const p99 = percentile(values, 0.99) as number
      assert.ok(p50 <= p95 && p95 <= p99, `${p50} / ${p95} / ${p99}`)
    }
  })
})

/* ------------------------------------------------------------------ *
 * Histogram
 * ------------------------------------------------------------------ */

const containsValue = (bucket: HistogramBucket, value: number) =>
  value >= bucket.from && (bucket.to === null || value < bucket.to)

describe('histogram', () => {
  it('is a partition: every sample lands in exactly one bucket', () => {
    const random = rng(13)
    for (let trial = 0; trial < 100; trial += 1) {
      const values = Array.from({ length: 120 }, () =>
        Math.floor(random() * 8000),
      )
      const buckets = histogram(values)
      const total = buckets.reduce((sum, b) => sum + b.count, 0)
      assert.equal(total, values.length)
      for (const value of values) {
        const matches = buckets.filter((b) => containsValue(b, value))
        assert.equal(matches.length, 1, `${value} matched ${matches.length}`)
      }
    }
  })

  it('puts a boundary value in the upper bucket, not the lower one', () => {
    const buckets = histogram([250])
    const index = buckets.findIndex((b) => b.count === 1)
    assert.equal(buckets[index].from, 250)
  })

  it('sends anything past the last bound to the open-ended bucket', () => {
    const buckets = histogram([9999])
    assert.equal(buckets[buckets.length - 1].count, 1)
  })

  it('labels every bucket with the range it actually covers', () => {
    // The original bug: the 100-250ms bar was labelled "250", so a p50 of
    // 198ms looked like it disagreed with its own histogram.
    for (const bucket of histogram([])) {
      const claimed = parseLabel(bucket.label)
      assert.equal(claimed.from, bucket.from, `label "${bucket.label}" from`)
      assert.equal(claimed.to, bucket.to, `label "${bucket.label}" to`)
    }
  })
})

/* ------------------------------------------------------------------ *
 * The panel's own invariant: numbers agree with the picture
 * ------------------------------------------------------------------ */

describe('headline percentiles agree with the histogram', () => {
  it('draws each marker over a bucket whose range contains its value', () => {
    const random = rng(17)
    for (let trial = 0; trial < 300; trial += 1) {
      const n = 5 + Math.floor(random() * 200)
      const values = Array.from({ length: n }, () =>
        Math.floor(random() * 7000),
      )
      const buckets = histogram(values)
      for (const p of [0.5, 0.95, 0.99]) {
        const value = percentile(values, p) as number
        const index = bucketIndexOf(buckets, value)
        const bucket = buckets[index]
        assert.ok(
          containsValue(bucket, value),
          `p${p * 100}=${value}ms drawn over bucket ${bucket.label}`,
        )
        // And the label the user reads must cover it too.
        const claimed = parseLabel(bucket.label)
        assert.ok(
          value >= claimed.from && (claimed.to === null || value < claimed.to),
          `p${p * 100}=${value}ms drawn over a bar labelled "${bucket.label}"`,
        )
      }
    }
  })

  it('draws the marker over a bucket that has at least one request in it', () => {
    const random = rng(19)
    for (let trial = 0; trial < 200; trial += 1) {
      const n = 5 + Math.floor(random() * 100)
      const values = Array.from({ length: n }, () =>
        Math.floor(random() * 3000),
      )
      const buckets = histogram(values)
      for (const p of [0.5, 0.95, 0.99]) {
        const value = percentile(values, p) as number
        const bucket = buckets[bucketIndexOf(buckets, value)]
        assert.ok(bucket.count > 0, `empty bar marked for p${p * 100}`)
      }
    }
  })

  it('reproduces the reported case: p50 198ms belongs to the 100-250 bar', () => {
    const buckets = histogram([198])
    const index = bucketIndexOf(buckets, 198)
    assert.equal(buckets[index].label, '100-250')
    assert.equal(buckets[index].count, 1)
  })
})

/* ------------------------------------------------------------------ *
 * Segment filtering
 * ------------------------------------------------------------------ */

describe('latencySamples', () => {
  const mixed: MetricSample[] = [
    { ...sample(100), method: 'GET', cache: 'hit' },
    { ...sample(400), method: 'GET', cache: 'miss' },
    { ...sample(700), method: 'POST', cache: 'not_applicable' },
    { ...sample(9999), outcome: 'failed', method: 'GET', cache: 'miss' },
  ]

  it('excludes failures, which measure rejection speed not latency', () => {
    assert.deepEqual(latencySamples(mixed, 'all'), [100, 400, 700])
  })

  it('filters by method and cache outcome', () => {
    assert.deepEqual(latencySamples(mixed, 'get'), [100, 400])
    assert.deepEqual(latencySamples(mixed, 'post'), [700])
    assert.deepEqual(latencySamples(mixed, 'hit'), [100])
    assert.deepEqual(latencySamples(mixed, 'miss'), [400])
  })
})
