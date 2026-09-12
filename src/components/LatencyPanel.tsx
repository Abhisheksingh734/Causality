import { X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  bucketIndexOf,
  histogram,
  latencySamples,
  MIN_SAMPLES,
  percentile,
  SEGMENT_LABELS,
  type LatencySegment,
} from '../latency'
import { useFlowStore } from '../store'
import { LOG_PANEL_HEIGHT, METRICS_BAND_HEIGHT } from './panelLayout'

const MARKERS: { key: 'p50' | 'p95' | 'p99'; p: number; className: string }[] = [
  { key: 'p50', p: 0.5, className: 'bg-blue-600' },
  { key: 'p95', p: 0.95, className: 'bg-amber-500' },
  { key: 'p99', p: 0.99, className: 'bg-red-500' },
]

function LatencyPanel() {
  const isLatencyOpen = useFlowStore((state) => state.isLatencyOpen)
  const setLatencyOpen = useFlowStore((state) => state.setLatencyOpen)
  const isLogOpen = useFlowStore((state) => state.isLogOpen)
  const isHealthOpen = useFlowStore((state) => state.isHealthOpen)
  // Snapshotted on a timer; percentiles do not need to recompute on every one
  // of the log's many writes per request.
  const [logs, setLogs] = useState(() => useFlowStore.getState().metrics)
  // Refresh the moment the panel opens, adjusted during render so there is no
  // extra commit showing a stale snapshot first.
  const [wasOpen, setWasOpen] = useState(isLatencyOpen)
  if (isLatencyOpen !== wasOpen) {
    setWasOpen(isLatencyOpen)
    if (isLatencyOpen) setLogs(useFlowStore.getState().metrics)
  }
  useEffect(() => {
    if (!isLatencyOpen) return
    const timer = setInterval(() => setLogs(useFlowStore.getState().metrics), 500)
    return () => clearInterval(timer)
  }, [isLatencyOpen])

  const [segment, setSegment] = useState<LatencySegment>('all')

  const { samples, stats, buckets, peak } = useMemo(() => {
    const values = isLatencyOpen ? latencySamples(logs, segment) : []
    const computed = MARKERS.map((marker) => ({
      ...marker,
      value: percentile(values, marker.p),
    }))
    const bucketed = histogram(values)
    return {
      samples: values,
      stats: computed,
      buckets: bucketed,
      peak: Math.max(1, ...bucketed.map((b) => b.count)),
    }
  }, [logs, segment, isLatencyOpen])

  const enough = samples.length >= MIN_SAMPLES

  return (
    <section
      aria-hidden={!isLatencyOpen}
      style={{
        height: METRICS_BAND_HEIGHT,
        bottom: isLogOpen ? LOG_PANEL_HEIGHT : 0,
        left: isHealthOpen ? '50%' : 0,
        right: 0,
      }}
      className={`absolute z-10 flex flex-col border-l border-t border-slate-200 bg-white shadow-lg transition-all duration-200 ease-out ${
        isLatencyOpen
          ? 'translate-y-0 opacity-100'
          : 'pointer-events-none translate-y-full opacity-0'
      }`}
    >
      <header className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5">
        <span className="text-xs font-semibold text-slate-800">Latency</span>
        <select
          value={segment}
          onChange={(event) =>
            setSegment(event.target.value as LatencySegment)
          }
          className="rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-700 outline-none focus:border-blue-400"
        >
          {(Object.keys(SEGMENT_LABELS) as LatencySegment[]).map((key) => (
            <option key={key} value={key}>
              {SEGMENT_LABELS[key]}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label="Close latency"
          onClick={() => setLatencyOpen(false)}
          className="ml-auto rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {!enough ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-3 text-center">
          <p className="text-[11px] font-medium text-slate-500">
            Not enough data yet — fire more requests
          </p>
          <p className="text-[10px] text-slate-400">
            {samples.length} of {MIN_SAMPLES} completed requests
            {segment !== 'all' && ` matching "${SEGMENT_LABELS[segment]}"`}
          </p>
        </div>
      ) : (
        <div className="flex flex-1 gap-4 px-3 py-2">
          {/* headline percentiles */}
          <div className="flex shrink-0 flex-col justify-center gap-1">
            <div className="flex gap-4">
              {stats.map((stat) => (
                <div key={stat.key} className="flex flex-col">
                  <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                    <span className={`h-1.5 w-1.5 rounded-full ${stat.className}`} />
                    {stat.key}
                  </span>
                  <span className="text-xl font-semibold tabular-nums text-slate-800">
                    {stat.value}
                    <span className="text-xs font-normal text-slate-400">ms</span>
                  </span>
                </div>
              ))}
            </div>
            <span className="text-[10px] text-slate-400">
              Measured across all {samples.length.toLocaleString()} completed
              request{samples.length === 1 ? '' : 's'} this session
            </span>
          </div>

          {/* distribution */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex flex-1 items-end gap-1 border-b border-l border-slate-200 pb-px">
              {buckets.map((bucket, index) => {
                const marks = stats.filter(
                  (stat) => bucketIndexOf(buckets, stat.value) === index,
                )
                return (
                  <div
                    key={bucket.from}
                    title={`${bucket.count} request${bucket.count === 1 ? '' : 's'} ${
                      bucket.to === null
                        ? `over ${bucket.from}ms`
                        : `from ${bucket.from}ms up to (not including) ${bucket.to}ms`
                    }`}
                    className="flex h-full flex-1 flex-col justify-end gap-0.5"
                  >
                    <div className="flex h-3 items-end justify-center gap-0.5">
                      {marks.map((mark) => (
                        <span
                          key={mark.key}
                          title={`${mark.key.toUpperCase()} = ${mark.value}ms, which falls in this bucket`}
                          className={`rounded px-1 text-[8px] font-bold leading-tight text-white ${mark.className}`}
                        >
                          {mark.key}
                        </span>
                      ))}
                    </div>
                    <div
                      className={`w-full rounded-t-sm ${
                        marks.length > 0 ? 'bg-blue-500' : 'bg-slate-300'
                      }`}
                      style={{ height: `${(bucket.count / peak) * 100}%` }}
                    />
                  </div>
                )
              })}
            </div>
            <div className="flex gap-1 pt-0.5">
              {buckets.map((bucket) => (
                <span
                  key={bucket.from}
                  className="flex-1 text-center text-[8px] tabular-nums text-slate-400"
                >
                  {bucket.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

export default LatencyPanel
