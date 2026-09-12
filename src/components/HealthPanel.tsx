import { Activity, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  bucketSamples,
  summarize,
  WINDOW_SECONDS,
  type HealthStatus,
} from '../health'
import Badge, { type BadgeTone } from './Badge'
import { useFlowStore } from '../store'
import { LOG_PANEL_HEIGHT, METRICS_BAND_HEIGHT } from './panelLayout'

/** Slow enough to be cheap, fast enough to look live. */
const REFRESH_MS = 400

const STATUS_STYLES: Record<
  HealthStatus,
  { label: string; tone: BadgeTone }
> = {
  idle: { label: 'Idle', tone: 'neutral' },
  healthy: { label: 'Healthy', tone: 'success' },
  degraded: { label: 'Degraded', tone: 'warning' },
  critical: { label: 'Critical', tone: 'danger' },
}

function HealthPanel() {
  const isHealthOpen = useFlowStore((state) => state.isHealthOpen)
  const setHealthOpen = useFlowStore((state) => state.setHealthOpen)
  const isLogOpen = useFlowStore((state) => state.isLogOpen)
  const isLatencyOpen = useFlowStore((state) => state.isLatencyOpen)

  // Snapshotted alongside the clock tick below rather than subscribed, so the
  // log's very frequent writes cannot drive a render on their own.
  const [logs, setLogs] = useState(() => useFlowStore.getState().metrics)

  // `now` advancing on an interval is what scrolls the window leftwards; it is
  // a real input to the bucketing, so the memo below has honest dependencies.
  const [now, setNow] = useState(() => Date.now())

  const [wasOpen, setWasOpen] = useState(isHealthOpen)
  if (isHealthOpen !== wasOpen) {
    setWasOpen(isHealthOpen)
    if (isHealthOpen) setLogs(useFlowStore.getState().metrics)
  }

  useEffect(() => {
    if (!isHealthOpen) return
    const timer = setInterval(() => {
      setNow(Date.now())
      setLogs(useFlowStore.getState().metrics)
    }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [isHealthOpen])

  const buckets = useMemo(
    // Skip the work entirely while the drawer is closed.
    () => (isHealthOpen ? bucketSamples(logs, now) : []),
    [logs, now, isHealthOpen],
  )
  const summary = useMemo(() => summarize(buckets), [buckets])
  const status = STATUS_STYLES[summary.status]
  const scale = Math.max(1, summary.peak)

  return (
    <section
      aria-hidden={!isHealthOpen}
      style={{
        height: METRICS_BAND_HEIGHT,
        // Rides above the log drawer, and shares the band with Latency.
        bottom: isLogOpen ? LOG_PANEL_HEIGHT : 0,
        left: 0,
        right: isLatencyOpen ? '50%' : 0,
      }}
      className={`absolute z-10 flex flex-col border-t border-slate-200 bg-white shadow-lg transition-all duration-200 ease-out ${
        isHealthOpen
          ? 'translate-y-0 opacity-100'
          : 'pointer-events-none translate-y-full opacity-0'
      }`}
    >
      <header className="flex items-center gap-3 border-b border-slate-100 px-3 py-1.5">
        <span className="text-xs font-semibold text-slate-800">Health</span>
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="text-[11px] text-slate-500">
          <span className="font-medium text-slate-700">{summary.total}</span>{' '}
          resolved in {WINDOW_SECONDS}s
        </span>
        <span className="text-[11px] text-slate-500">
          success{' '}
          <span className="font-medium text-slate-700">
            {summary.successRate === null
              ? '—'
              : `${summary.successRate.toFixed(1)}%`}
          </span>
        </span>
        <span className="flex items-center gap-2 text-[10px] text-slate-400">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-green-500" /> success
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-red-500" /> failed
          </span>
        </span>

        <button
          type="button"
          aria-label="Close health"
          onClick={() => setHealthOpen(false)}
          className="ml-auto rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="relative flex flex-1 items-stretch gap-2 px-3 py-2">
        {/* y axis */}
        <div className="flex w-6 shrink-0 flex-col justify-between py-0.5 text-right text-[9px] tabular-nums text-slate-400">
          <span>{scale}</span>
          <span>0</span>
        </div>

        <div className="relative flex flex-1 items-end gap-px border-b border-l border-slate-200 pb-px">
          {buckets.map((bucket) => {
            const total = bucket.successCount + bucket.failedCount
            return (
              <div
                key={bucket.second}
                title={`${bucket.successCount} ok, ${bucket.failedCount} failed`}
                className="flex flex-1 flex-col justify-end"
                style={{ height: '100%' }}
              >
                {/* failures stack on top of successes */}
                <div
                  className="w-full bg-red-500"
                  style={{ height: `${(bucket.failedCount / scale) * 100}%` }}
                />
                <div
                  className="w-full bg-green-500"
                  style={{ height: `${(bucket.successCount / scale) * 100}%` }}
                />
                {total === 0 && <div className="h-px w-full bg-slate-100" />}
              </div>
            )
          })}

          {summary.total === 0 && (
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
                <Activity className="h-3.5 w-3.5" />
                No recent activity
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-between px-3 pb-1 text-[9px] text-slate-400">
        <span>-{WINDOW_SECONDS}s</span>
        <span>now</span>
      </div>
    </section>
  )
}

export default HealthPanel
