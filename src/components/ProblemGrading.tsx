import {
  CheckCircle2,
  CircleAlert,
  RotateCcw,
  ScrollText,
  XCircle,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  fingerprintTopology,
  gradeProblem,
  MIN_BASELINE_SAMPLES,
  windowMetrics,
  type BaselineMetrics,
  type GradeResult,
  type SuccessCriteria,
} from '../grading'
import { saveNow } from '../persistence'
import type { Problem } from '../problems'
import Badge from './Badge'
import { useFlowStore } from '../store'

const ms = (n: number | null) => (n === null ? '—' : `${Math.round(n)}ms`)

/** What "better" concretely means, once a baseline gives the numbers meaning. */
function targetLines(
  criteria: SuccessCriteria,
  baseline: BaselineMetrics,
): string[] {
  return criteria.criteria.map((criterion) => {
    switch (criterion.type) {
      case 'p50_reduction_vs_baseline':
      case 'p99_reduction_vs_baseline': {
        const isP50 = criterion.type === 'p50_reduction_vs_baseline'
        const from = isP50 ? baseline.p50 : baseline.p99
        const goal =
          from === null
            ? null
            : from * (1 - criterion.minReductionPercent / 100)
        return `${isP50 ? 'p50' : 'p99'} under ${ms(goal)}  (now ${ms(from)})`
      }
      case 'max_failure_rate':
        return `failures at or below ${criterion.maxPercent}%`
      case 'kill_test_resilience':
        return `under ${criterion.maxFailureRatePercent}% failures, with a Server killed partway through the run`
      case 'durability_check':
        return 'every order the shop accepted is actually stored'
    }
  })
}

function RateHint({
  ok,
  required,
  current,
}: {
  ok: boolean
  required: number
  current: number
}) {
  if (ok) return null
  return (
    <p className="rounded bg-amber-50 px-1.5 py-1 text-[10px] leading-relaxed text-amber-800">
      Set the rate to <span className="font-semibold">{required}/s</span> in the
      control bar — it is at {current}/s.
    </p>
  )
}

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number
  title: string
  done?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex gap-2">
      <span
        className={`mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${
          done ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'
        }`}
      >
        {done ? '✓' : n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-[11px] font-semibold text-slate-700">{title}</span>
        {children}
      </div>
    </div>
  )
}

/**
 * A guided two-step flow rather than a row of buttons: measure the system you
 * were given, then beat it. Every dead end the flow can reach explains itself
 * and offers the button that gets out of it.
 */
function ProblemGrading({ problem }: { problem: Problem }) {
  const baseline = useFlowStore((state) => state.baselines[problem.id])
  const recordBaseline = useFlowStore((state) => state.recordBaseline)
  const clearBaseline = useFlowStore((state) => state.clearBaseline)
  const loadProblem = useFlowStore((state) => state.loadProblem)
  const requestsPerSecond = useFlowStore((state) => state.requestsPerSecond)
  // A string, so this only re-renders when the design genuinely changes.
  const topology = useFlowStore((state) =>
    fingerprintTopology(state.nodes, state.edges),
  )

  const [grade, setGrade] = useState<GradeResult | null>(null)
  const [tick, setTick] = useState(0)

  const criteria = problem.successCriteria
  // Unscored problems still run every hook above, so the early return below is
  // safe; they simply have no rate or window to measure against.
  const { requiredRps, minDurationSec } = criteria ?? {
    requiredRps: 0,
    minDurationSec: 30,
  }
  const startTopology = fingerprintTopology(problem.nodes, problem.edges)
  const isStartingSetup = topology === startTopology

  // Live readout so it is obvious when enough traffic has been collected.
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  void tick
  const live = windowMetrics(useFlowStore.getState().metrics, minDurationSec)
  const enoughToRecord = live.sampleCount >= MIN_BASELINE_SAMPLES
  const rateOk = requestsPerSecond === requiredRps

  const onRestore = () => {
    if (
      !window.confirm(
        'Restore the starting configuration? This removes your changes to the canvas and clears the recorded baseline.',
      )
    )
      return
    loadProblem(problem)
    saveNow()
    setGrade(null)
  }

  const onRecord = () => {
    const { metrics, nodes, edges } = useFlowStore.getState()
    recordBaseline(problem.id, {
      ...windowMetrics(metrics, minDurationSec),
      recordedAt: Date.now(),
      requestsPerSecond,
      topology: fingerprintTopology(nodes, edges),
      wasStartingConfig: isStartingSetup,
    })
    setGrade(null)
  }

  const onCheck = () => {
    const { metrics, nodeEvents, baselines, nodes, edges, writeDurability, pendingSyncs } =
      useFlowStore.getState()
    if (!criteria) return
    setGrade(
      gradeProblem({
        criteria,
        baseline: baselines[problem.id],
        samples: metrics,
        nodeEvents,
        currentRps: requestsPerSecond,
        nodes,
        edges,
        durability: writeDurability,
        pendingWrites: Object.values(pendingSyncs).reduce((a, b) => a + b, 0),
      }),
    )
  }

  if (!criteria) {
    return (
      <div className="flex select-none flex-col gap-2.5 px-3 py-3">
        <div className="rounded-md border border-slate-200 bg-white px-2.5 py-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-700">
            <ScrollText className="h-3.5 w-3.5 text-slate-400" />
            You score this one yourself
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
            There is no automated check for this problem yet. Judge it from the
            evidence instead: open the{' '}
            <span className="font-medium text-slate-700">Log panel</span> and
            set the reads filter to{' '}
            <span className="font-medium text-slate-700">Stale</span>. You are
            looking for stale reads that land just after a write to the same
            key — and then for those to disappear once you have fixed it.
          </p>
        </div>
        <button
          type="button"
          onClick={onRestore}
          title="Reset the canvas to how this problem started"
          className="flex items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[10px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
        >
          <RotateCcw className="h-3 w-3" />
          Restore starting setup
        </button>
      </div>
    )
  }

  return (
    <div className="flex select-none flex-col gap-2.5 px-3 py-3">
      <div className="text-[10px] text-slate-400">
        Scored at {requiredRps} rps over a {minDurationSec}s window
      </div>

      {/* ---------- step 1: measure what you were given ---------- */}
      <Step n={1} title="Measure the starting system" done={Boolean(baseline)}>
        {baseline ? (
          <div className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[10px] text-slate-600">
            <div className="font-semibold text-slate-700">
              Baseline · p50 {ms(baseline.p50)}
            </div>
            <div className="mt-0.5 tabular-nums text-slate-500">
              p95 {ms(baseline.p95)} · p99 {ms(baseline.p99)} ·{' '}
              {baseline.failureRatePercent.toFixed(1)}% failed ·{' '}
              {baseline.sampleCount} requests
            </div>
            {baseline.wasStartingConfig === false && (
              <div className="mt-1.5 rounded border border-amber-300 bg-amber-50 px-1.5 py-1 text-[10px] leading-relaxed text-amber-900">
                <span className="font-semibold">
                  ⚠ This was recorded on a design you had already changed
                </span>
                <div className="mt-0.5">
                  So it measures your fix, not the problem — any improvement
                  will read as 0%. Restore the starting setup and record again.
                </div>
              </div>
            )}
            {baseline.sampleCount < MIN_BASELINE_SAMPLES && (
              <div className="mt-1 flex items-start gap-1 text-[10px] text-amber-700">
                <CircleAlert className="mt-px h-3 w-3 shrink-0" />
                Only {baseline.sampleCount} requests — too few to trust. Run
                longer and record again.
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                clearBaseline(problem.id)
                setGrade(null)
              }}
              className="mt-1.5 text-[10px] font-medium text-blue-600 underline-offset-2 hover:underline"
            >
              Record again
            </button>
          </div>
        ) : (
          <>
            {!isStartingSetup && (
              <div className="rounded border border-amber-300 bg-amber-50 px-1.5 py-1 text-[10px] leading-relaxed text-amber-900">
                <span className="font-semibold">
                  ⚠ Your canvas is not the starting setup
                </span>
                <div className="mt-0.5">
                  A baseline has to measure the problem, not your fix. Restore
                  it first, or the comparison will read 0%.
                </div>
              </div>
            )}
            <p className="text-[10px] leading-relaxed text-slate-500">
              Run auto-fire at {requiredRps}/s for {minDurationSec}s without
              changing anything, then press this.
            </p>
            <RateHint ok={rateOk} required={requiredRps} current={requestsPerSecond} />
            <button
              type="button"
              onClick={onRecord}
              className="rounded-md bg-blue-600 px-2 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-blue-700"
            >
              Record Baseline
            </button>
            <p
              className={`text-[10px] tabular-nums ${
                enoughToRecord ? 'text-green-700' : 'text-slate-400'
              }`}
            >
              {enoughToRecord ? '✓ ' : ''}
              {live.sampleCount} requests in the last {minDurationSec}s
              {enoughToRecord ? ' — ready' : ' — keep it running'}
            </p>
          </>
        )}
      </Step>

      {/* ---------- step 2: beat it ---------- */}
      {baseline && (
        <Step n={2} title="Now improve on it">
          <div className="rounded-md border border-blue-200 bg-blue-50/60 px-2 py-1.5">
            <div className="text-[10px] font-semibold text-blue-900">
              Your targets
            </div>
            <ul className="mt-0.5 flex list-disc flex-col gap-0.5 pl-3.5 text-[10px] leading-relaxed text-blue-900">
              {targetLines(criteria!, baseline).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <p className="text-[10px] leading-relaxed text-slate-500">
            Change the design, run another {minDurationSec}s at {requiredRps}/s,
            then check.
          </p>
          <RateHint ok={rateOk} required={requiredRps} current={requestsPerSecond} />
          <button
            type="button"
            onClick={onCheck}
            className="rounded-md bg-blue-600 px-2 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-blue-700"
          >
            Check My Score
          </button>
        </Step>
      )}

      <button
        type="button"
        onClick={onRestore}
        title="Reset the canvas to how this problem started, and clear the baseline"
        className="flex items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[10px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
      >
        <RotateCcw className="h-3 w-3" />
        Restore starting setup
      </button>

      {/* ---------- results ---------- */}
      {grade && grade.status === 'rps_mismatch' && (
        <p className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-[10px] leading-relaxed text-amber-800">
          <CircleAlert className="mt-px h-3 w-3 shrink-0" />
          Set the rate to {grade.requiredRps}/s to score this — it is at{' '}
          {grade.currentRps}/s, and comparing across rates means nothing.
        </p>
      )}

      {grade && grade.status === 'insufficient_samples' && (
        <p className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-[10px] leading-relaxed text-amber-800">
          <CircleAlert className="mt-px h-3 w-3 shrink-0" />
          Only {grade.have} requests finished in the last {grade.windowSec}s,
          expected around {grade.need}. Keep it running, then check again.
        </p>
      )}

      {grade && grade.status === 'graded' && (
        <div className="flex flex-col gap-1.5">
          {grade.unchangedDesign && (
            <p className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-[10px] leading-relaxed text-amber-800">
              <CircleAlert className="mt-px h-3 w-3 shrink-0" />
              The design has not changed since the baseline, so this is
              comparing it to itself. Change something, run again, then check.
            </p>
          )}

          <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1.5 shadow-sm">
            <Badge tone={grade.passed ? 'success' : 'danger'} solid>
              {grade.passed ? 'Solved' : 'Not yet'}
            </Badge>
            <span className="text-[10px] text-slate-500">
              {grade.results.filter((r) => r.passed).length} of{' '}
              {grade.results.length} targets met
            </span>
          </div>

          {grade.results.map((result) => (
            <div
              key={result.label}
              className="rounded-md border border-slate-200 bg-white px-2 py-1.5"
            >
              <div className="flex items-start gap-1.5">
                {result.passed ? (
                  <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-green-600" />
                ) : (
                  <XCircle className="mt-px h-3.5 w-3.5 shrink-0 text-red-500" />
                )}
                <span className="text-[10px] font-medium leading-relaxed text-slate-700">
                  {result.label}
                </span>
              </div>
              <div className="mt-1 pl-5 text-[10px] tabular-nums text-slate-500">
                <div>
                  target <span className="text-slate-700">{result.target}</span>
                </div>
                <div>
                  actual{' '}
                  <span
                    className={
                      result.passed
                        ? 'font-medium text-green-700'
                        : 'font-medium text-red-600'
                    }
                  >
                    {result.actual}
                  </span>
                </div>
                {result.hint && (
                  <div className="mt-0.5 text-amber-700">{result.hint}</div>
                )}
              </div>
            </div>
          ))}

          <p className="text-[10px] text-slate-400">
            Over the last {grade.current.windowSec}s of traffic ·{' '}
            {grade.current.resolvedCount} requests
          </p>
        </div>
      )}
    </div>
  )
}

export default ProblemGrading
