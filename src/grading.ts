import { bucketSamples, summarize } from './health'
import { latencySamples, percentile } from './latency'
import { EMPTY_DURABILITY } from './store'
import type {
  MetricSample,
  NodeToggleEvent,
  SystemNodeData,
  WriteDurability,
} from './store'
import type { Edge, Node } from '@xyflow/react'

/* ------------------------------------------------------------------ *
 * What a Problem asks for
 * ------------------------------------------------------------------ */

export type Criterion =
  | { type: 'p50_reduction_vs_baseline'; minReductionPercent: number }
  | { type: 'p99_reduction_vs_baseline'; minReductionPercent: number }
  | { type: 'max_failure_rate'; maxPercent: number }
  | {
      type: 'kill_test_resilience'
      maxFailureRatePercent: number
      requiresKillEventDuringWindow: boolean
    }
  /**
   * Every write the client was told succeeded must actually reach the database.
   *
   * Latency criteria cannot express this. A write-back cache answers the client
   * and defers the database write, so no client-visible number — p50, p99, even
   * POST-only percentiles — moves at all when the database runs out of write
   * capacity. The requests that vanish do so silently, after the response has
   * already gone out and with the failure rate sitting at zero.
   */
  | {
      type: 'durability_check'
      /**
       * Deferred writes still legitimately in flight when the grade is taken.
       * Stopping traffic and checking immediately leaves a tail of flushes that
       * have not had time to land, and those are not lost writes.
       */
      maxPendingWrites: number
    }

export type SuccessCriteria = {
  requiredRps: number
  minDurationSec: number
  criteria: Criterion[]
}

/* ------------------------------------------------------------------ *
 * Measurement
 * ------------------------------------------------------------------ */

export type WindowMetrics = {
  windowSec: number
  /** Requests that completed in the window — the latency sample count. */
  sampleCount: number
  /** Completed plus failed: how much actually ran. */
  resolvedCount: number
  p50: number | null
  p95: number | null
  p99: number | null
  failureRatePercent: number
  /** The instant the window closes on — the last request, not the clock. */
  endedAt: number
  /** How stale the measured traffic is, in ms. Zero while a run is live. */
  staleMs: number
}

/**
 * Metrics over the most recent `windowSec`, built from the same functions the
 * Latency and Health panels use — `latencySamples` + `percentile` for the
 * percentiles, `bucketSamples` + `summarize` for the failure rate. Nothing is
 * recomputed here, so a grade can never disagree with the panels' own maths.
 *
 * Windowed rather than session-wide on purpose: after a redesign the session
 * still holds the baseline run's samples, and grading against those would
 * compare the new system to an average of both.
 */
/**
 * The instant a measurement window should close on: the most recent request,
 * never later than now.
 *
 * Anchoring to the wall clock instead is a trap. Stop auto-fire, spend twenty
 * seconds reading the panels, and a "last 20 seconds" window has slid clean
 * past the run — the measurement quietly empties out while you decide to press
 * the button. Anchoring to the traffic makes the reading stable: the numbers
 * describe the end of the run whether you record immediately or a minute later.
 */
export function windowAnchor(
  samples: MetricSample[],
  now: number = Date.now(),
): number {
  let latest = 0
  for (const sample of samples) if (sample.t > latest) latest = sample.t
  return latest === 0 ? now : Math.min(now, latest)
}

export function windowMetrics(
  samples: MetricSample[],
  windowSec: number,
  now: number = Date.now(),
): WindowMetrics {
  const endedAt = windowAnchor(samples, now)
  const from = endedAt - windowSec * 1000
  const windowed = samples.filter((s) => s.t >= from && s.t <= endedAt)

  const durations = latencySamples(windowed, 'all')
  // bucketSamples buckets relative to the instant it is given, so it must see
  // the same anchor or the windowed samples would fall outside its buckets.
  const health = summarize(bucketSamples(windowed, endedAt))

  return {
    windowSec,
    sampleCount: durations.length,
    resolvedCount: health.total,
    p50: percentile(durations, 0.5),
    p95: percentile(durations, 0.95),
    p99: percentile(durations, 0.99),
    failureRatePercent: health.failureRate ?? 0,
    endedAt,
    staleMs: Math.max(0, now - endedAt),
  }
}

export type BaselineMetrics = WindowMetrics & {
  recordedAt: number
  /** The rate the baseline was taken at; a later check must match it. */
  requestsPerSecond: number
  /**
   * The design the baseline describes. Optional so baselines recorded before
   * this existed still load.
   */
  topology?: string
  /**
   * Whether that design was the problem's untouched starting configuration.
   * A baseline taken on an already-modified system is the single most common
   * way to end up chasing a 0% improvement.
   */
  wasStartingConfig?: boolean
}

/**
 * A stable description of the current design: which components exist, how each
 * is configured, and how they are wired. Used only to notice that a baseline
 * and the thing being graded are the same system, which makes the comparison
 * meaningless — a baseline recorded after the fix reports a 0% improvement and
 * looks like a broken grader.
 */
export function fingerprintTopology(nodes: Node[], edges: Edge[]): string {
  const parts = nodes
    .map((node) => {
      const data = node.data as SystemNodeData
      return `${data.componentType}:${JSON.stringify(data.settings)}`
    })
    .sort()
  const wiring = edges.map((e) => `${e.source}>${e.target}`).sort()
  return JSON.stringify({ parts, wiring })
}

/** Below this, percentiles are describing noise rather than the system. */
export const MIN_BASELINE_SAMPLES = 50

/**
 * A window is only worth grading once most of the expected traffic has
 * actually resolved. The allowance covers requests still in flight at the
 * moment of the check and the ragged edge of the window.
 */
export const EXPECTED_SAMPLE_TOLERANCE = 0.75

export const expectedResolved = (criteria: SuccessCriteria) =>
  Math.round(
    criteria.requiredRps * criteria.minDurationSec * EXPECTED_SAMPLE_TOLERANCE,
  )

/* ------------------------------------------------------------------ *
 * Grading
 * ------------------------------------------------------------------ */

export type CriterionResult = {
  label: string
  target: string
  actual: string
  passed: boolean
  /** Shown under a failing row to explain what to do about it. */
  hint?: string
}

export type GradeResult =
  | { status: 'no_baseline' }
  | { status: 'rps_mismatch'; requiredRps: number; currentRps: number }
  | {
      status: 'insufficient_samples'
      have: number
      need: number
      windowSec: number
    }
  | {
      status: 'graded'
      passed: boolean
      results: CriterionResult[]
      current: WindowMetrics
      baseline: BaselineMetrics
      /** True when nothing about the design has changed since the baseline. */
      unchangedDesign: boolean
    }

const pct = (n: number | null) => (n === null ? '—' : `${n.toFixed(1)}%`)
const ms = (n: number | null) => (n === null ? '—' : `${Math.round(n)}ms`)

/** Percentage drop from baseline to current; negative means it got worse. */
export function reductionPercent(
  baseline: number | null,
  current: number | null,
): number | null {
  if (baseline === null || current === null || baseline === 0) return null
  return ((baseline - current) / baseline) * 100
}

function gradeCriterion(
  criterion: Criterion,
  baseline: BaselineMetrics,
  current: WindowMetrics,
  killedDuringWindow: boolean,
  durability: WriteDurability,
  pendingWrites: number,
): CriterionResult {
  switch (criterion.type) {
    case 'p50_reduction_vs_baseline':
    case 'p99_reduction_vs_baseline': {
      const isP50 = criterion.type === 'p50_reduction_vs_baseline'
      const key = isP50 ? 'p50' : 'p99'
      const drop = reductionPercent(baseline[key], current[key])
      return {
        label: `${key.toUpperCase()} at least ${criterion.minReductionPercent}% below baseline`,
        target: `≤ ${ms(
          baseline[key] === null
            ? null
            : baseline[key]! * (1 - criterion.minReductionPercent / 100),
        )}  (baseline ${ms(baseline[key])})`,
        actual:
          drop === null
            ? `${ms(current[key])} — no baseline value to compare`
            : `${ms(current[key])}  (${drop >= 0 ? '−' : '+'}${Math.abs(drop).toFixed(1)}%)`,
        passed: drop !== null && drop >= criterion.minReductionPercent,
        hint:
          drop !== null && drop < criterion.minReductionPercent
            ? 'Latency has not moved enough — look for what the requests are actually queueing behind.'
            : undefined,
      }
    }
    case 'max_failure_rate':
      return {
        label: `Failure rate at or below ${criterion.maxPercent}%`,
        target: `≤ ${criterion.maxPercent}%`,
        actual: pct(current.failureRatePercent),
        passed: current.failureRatePercent <= criterion.maxPercent,
        hint:
          current.failureRatePercent > criterion.maxPercent
            ? 'Requests are being turned away — check queue depths and timeouts.'
            : undefined,
      }
    case 'durability_check': {
      const { acknowledged, durable, lost } = durability
      const draining = pendingWrites <= criterion.maxPendingWrites
      const passed = lost === 0 && draining
      // Worth saying explicitly: a design with no deferred writes at all is
      // durable by construction, and should read that way rather than looking
      // like an empty measurement.
      const nothingDeferred = acknowledged === 0
      return {
        label: 'Every acknowledged order actually stored',
        target: 'no lost writes, and the backlog drains',
        actual: nothingDeferred
          ? 'no writes were deferred — every order was stored before the response'
          : `${lost} of ${acknowledged} lost, ${durable} stored` +
            (pendingWrites > 0 ? `, ${pendingWrites} still in flight` : ''),
        passed,
        hint: lost > 0
          ? 'Orders were acknowledged and then never stored. Look at what happens to a deferred write when the database has no room for it.'
          : !draining
            ? 'The backlog of deferred writes is not draining — the database is taking writes more slowly than they arrive.'
            : undefined,
      }
    }
    case 'kill_test_resilience': {
      const rateOk = current.failureRatePercent <= criterion.maxFailureRatePercent
      const killOk = !criterion.requiresKillEventDuringWindow || killedDuringWindow
      return {
        label: `Survives a node being killed, under ${criterion.maxFailureRatePercent}% failures`,
        target: `≤ ${criterion.maxFailureRatePercent}% with a kill during the run`,
        actual: `${pct(current.failureRatePercent)}${
          killedDuringWindow ? ', node killed during the window' : ', no kill detected'
        }`,
        passed: rateOk && killOk,
        hint: !killOk
          ? 'Nothing was taken offline in this window — kill a Server partway through the run.'
          : !rateOk
            ? 'The outage cost you requests — can traffic route around a dead backend?'
            : undefined,
      }
    }
  }
}

export function gradeProblem(input: {
  criteria: SuccessCriteria
  baseline: BaselineMetrics | undefined
  samples: MetricSample[]
  nodeEvents: NodeToggleEvent[]
  currentRps: number
  /** Current design, for the unchanged-since-baseline check. */
  nodes?: Node[]
  edges?: Edge[]
  /** Running census of deferred writes; required by 'durability_check'. */
  durability?: WriteDurability
  /** Deferred writes still queued or writing right now. */
  pendingWrites?: number
  now?: number
}): GradeResult {
  const { criteria, baseline, samples, nodeEvents, currentRps } = input
  const now = input.now ?? Date.now()

  if (!baseline) return { status: 'no_baseline' }

  // A grade compared across different rates is meaningless, so refuse rather
  // than quietly produce a number.
  if (currentRps !== criteria.requiredRps) {
    return {
      status: 'rps_mismatch',
      requiredRps: criteria.requiredRps,
      currentRps,
    }
  }

  const current = windowMetrics(samples, criteria.minDurationSec, now)
  const need = expectedResolved(criteria)
  if (current.resolvedCount < need) {
    return {
      status: 'insufficient_samples',
      have: current.resolvedCount,
      need,
      windowSec: criteria.minDurationSec,
    }
  }

  // Same anchor as the metrics: a kill that happened during the run must not
  // stop counting just because the user paused before pressing the button.
  const from = current.endedAt - criteria.minDurationSec * 1000
  const killedDuringWindow = nodeEvents.some(
    (event) =>
      event.action === 'killed' &&
      event.ts >= from &&
      event.ts <= current.endedAt,
  )

  const results = criteria.criteria.map((criterion) =>
    gradeCriterion(
      criterion,
      baseline,
      current,
      killedDuringWindow,
      input.durability ?? EMPTY_DURABILITY,
      input.pendingWrites ?? 0,
    ),
  )

  const currentTopology =
    input.nodes && input.edges
      ? fingerprintTopology(input.nodes, input.edges)
      : undefined

  return {
    status: 'graded',
    passed: results.every((r) => r.passed),
    results,
    current,
    baseline,
    unchangedDesign:
      baseline.topology !== undefined &&
      currentTopology !== undefined &&
      baseline.topology === currentTopology,
  }
}
