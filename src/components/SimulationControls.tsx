import {
  Activity,
  BookOpen,
  Gauge,
  Pause,
  Play,
  RotateCcw,
  ScrollText,
  Timer,
  Trash2,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { track } from '../analytics'
import { resetEdgeFlow } from '../edgeFlow'
import { clearPersisted } from '../persistence'
import { problemById } from '../problems'
import { dockHeight, SIDE_PANEL_WIDTH } from './panelLayout'
import ProblemsMenu from './ProblemsMenu'
import { MAX_RPS, MIN_RPS, useFlowStore, type SystemNodeData } from '../store'

const Divider = () => <span className="h-5 w-px shrink-0 bg-slate-200" />

/** Durations the briefs actually ask for, plus open-ended. */
const DURATIONS = [
  { value: 0, label: 'until stopped' },
  { value: 10, label: '10s' },
  { value: 20, label: '20s' },
  { value: 30, label: '30s' },
  { value: 60, label: '60s' },
]

/**
 * Instant tooltip. The native `title` attribute waits about a second before
 * appearing, which is useless for a row of icon-only buttons.
 */
function Tip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="group relative flex shrink-0">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-800 px-2 py-1 text-[10px] font-medium text-white opacity-0 shadow-lg transition-opacity duration-100 group-hover:opacity-100"
      >
        {label}
      </span>
    </span>
  )
}

function IconToggle({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
        className={`rounded-md p-1.5 transition-colors ${
          active
            ? 'bg-blue-50 text-blue-700'
            : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'
        }`}
      >
        {children}
      </button>
    </Tip>
  )
}

const formatClock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

function SimulationControls() {
  const isAutoFiring = useFlowStore((state) => state.isAutoFiring)
  const requestsPerSecond = useFlowStore((state) => state.requestsPerSecond)
  const runDurationSeconds = useFlowStore((state) => state.runDurationSeconds)
  const autoFireStartedAt = useFlowStore((state) => state.autoFireStartedAt)
  const totalFired = useFlowStore((state) => state.totalFired)
  const setAutoFiring = useFlowStore((state) => state.setAutoFiring)
  const setRequestsPerSecond = useFlowStore((state) => state.setRequestsPerSecond)
  const setRunDuration = useFlowStore((state) => state.setRunDuration)
  const resetCounters = useFlowStore((state) => state.resetCounters)
  const isLogOpen = useFlowStore((state) => state.isLogOpen)
  const setLogOpen = useFlowStore((state) => state.setLogOpen)
  const isHealthOpen = useFlowStore((state) => state.isHealthOpen)
  const setHealthOpen = useFlowStore((state) => state.setHealthOpen)
  const isLatencyOpen = useFlowStore((state) => state.isLatencyOpen)
  const setLatencyOpen = useFlowStore((state) => state.setLatencyOpen)
  const clearAll = useFlowStore((state) => state.clearAll)
  const isBriefOpen = useFlowStore((state) => state.isBriefOpen)
  const setBriefOpen = useFlowStore((state) => state.setBriefOpen)
  const activeProblemId = useFlowStore((state) => state.activeProblemId)
  // The settings panel is open exactly when a node is selected.
  const isSettingsOpen = useFlowStore((state) => state.selectedNodeId !== null)
  const activeProblem = problemById(activeProblemId)

  // A draft string, so a half-typed value like "13." is not clamped out from
  // under the cursor on every keystroke.
  const [rpsDraft, setRpsDraft] = useState(String(requestsPerSecond))
  const [rpsSynced, setRpsSynced] = useState(requestsPerSecond)
  if (requestsPerSecond !== rpsSynced) {
    setRpsSynced(requestsPerSecond)
    // Only overwrite the draft when the change came from somewhere else
    // (the slider, a reset) rather than from this box.
    if (Number(rpsDraft) !== requestsPerSecond) setRpsDraft(String(requestsPerSecond))
  }

  const [elapsed, setElapsed] = useState(0)
  // Reset the clock when a new run starts, adjusted during render rather than
  // in the effect below so there is no extra commit showing a stale time.
  const [clockKey, setClockKey] = useState(autoFireStartedAt)
  if (autoFireStartedAt !== clockKey) {
    setClockKey(autoFireStartedAt)
    setElapsed(0)
  }

  useEffect(() => {
    if (!isAutoFiring) return

    const tick = () => {
      // Read fresh state each tick rather than closing over it, and go through
      // the very same action the manual button calls — no parallel firing path.
      const { nodes, fireRequest } = useFlowStore.getState()
      for (const node of nodes) {
        if ((node.data as SystemNodeData).componentType === 'client') {
          fireRequest(node.id)
        }
      }
    }

    const timer = setInterval(tick, 1000 / requestsPerSecond)
    // Covers all three cases: stopping, changing the rate, and unmounting.
    return () => clearInterval(timer)
  }, [isAutoFiring, requestsPerSecond])

  // Run clock, and the auto-stop that makes "15 RPS for 30 seconds" something
  // you set rather than something you count in your head.
  useEffect(() => {
    if (!isAutoFiring || autoFireStartedAt === null) return
    const clock = setInterval(() => {
      const seconds = (Date.now() - autoFireStartedAt) / 1000
      setElapsed(seconds)
      const limit = useFlowStore.getState().runDurationSeconds
      if (limit > 0 && seconds >= limit) useFlowStore.getState().setAutoFiring(false)
    }, 100)
    return () => clearInterval(clock)
  }, [isAutoFiring, autoFireStartedAt])

  const dock = dockHeight({ isLogOpen, isHealthOpen, isLatencyOpen })
  const remaining =
    runDurationSeconds > 0 ? Math.max(0, runDurationSeconds - elapsed) : null

  return (
    // A track that stops short of the settings panel, with the bar centred
    // inside it. Centring on the whole canvas is what used to slide the bar
    // underneath the panel on a 1366px screen. The brief floats freely, so it
    // is not part of this calculation.
    <div
      className="pointer-events-none absolute z-40 flex justify-center px-4 transition-all duration-200"
      style={{
        left: 0,
        right: isSettingsOpen ? SIDE_PANEL_WIDTH : 0,
        bottom: 16 + dock,
      }}
    >
      <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-2 rounded-xl border border-slate-200 bg-white/95 px-2 py-1.5 shadow-lg backdrop-blur">
        <button
          type="button"
          onClick={() => setAutoFiring(!isAutoFiring)}
          // Blue is the one accent for primary actions, matching Fire Request.
          // Stopping is a neutral toggle-off, not a second accent.
          className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-white transition-colors ${
            isAutoFiring
              ? 'bg-slate-600 hover:bg-slate-700'
              : 'bg-blue-600 hover:bg-blue-700'
          }`}
        >
          {isAutoFiring ? (
            <Pause className="h-3.5 w-3.5" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          {isAutoFiring ? 'Stop' : 'Auto-fire'}
        </button>

        {/* rate: slider for coarse, number box for an exact value */}
        <Tip label="Requests per second, per client">
          <span className="flex items-center gap-1.5">
            <input
              type="range"
              min={MIN_RPS}
              max={MAX_RPS}
              step={0.5}
              value={requestsPerSecond}
              onChange={(event) => setRequestsPerSecond(Number(event.target.value))}
              className="w-36 accent-blue-600"
              aria-label="Requests per second"
            />
            <input
              type="number"
              min={MIN_RPS}
              max={MAX_RPS}
              step={0.5}
              value={rpsDraft}
              onChange={(event) => {
                const raw = event.target.value
                setRpsDraft(raw)
                const parsed = Number(raw)
                // Commit only genuinely in-range values while typing; the
                // blur below is what clamps anything out of bounds.
                if (
                  raw.trim() !== '' &&
                  !Number.isNaN(parsed) &&
                  parsed >= MIN_RPS &&
                  parsed <= MAX_RPS
                ) {
                  setRequestsPerSecond(parsed)
                }
              }}
              onBlur={() => {
                const parsed = Number(rpsDraft)
                const next = Number.isNaN(parsed)
                  ? requestsPerSecond
                  : Math.min(MAX_RPS, Math.max(MIN_RPS, parsed))
                setRequestsPerSecond(next)
                setRpsDraft(String(next))
              }}
              aria-label="Requests per second, exact"
              className="w-14 rounded-md border border-slate-200 px-1.5 py-1 text-[11px] tabular-nums text-slate-700 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
            />
            <span className="text-[11px] text-slate-400">/s</span>
          </span>
        </Tip>

        <Divider />

        {/* run length + live clock */}
        <Tip label="Stop automatically after this long">
          <span className="flex items-center gap-1.5">
            <Timer className="h-3.5 w-3.5 text-slate-400" />
            <select
              value={runDurationSeconds}
              onChange={(event) => setRunDuration(Number(event.target.value))}
              aria-label="Run duration"
              className="rounded-md border border-slate-200 bg-white px-1 py-1 text-[11px] text-slate-700 outline-none focus:border-blue-400"
            >
              {DURATIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </span>
        </Tip>

        <span
          className={`w-16 shrink-0 text-center text-[11px] tabular-nums ${
            isAutoFiring ? 'font-semibold text-blue-700' : 'text-slate-400'
          }`}
        >
          {isAutoFiring
            ? remaining !== null
              ? `${formatClock(remaining)} left`
              : formatClock(elapsed)
            : remaining !== null
              ? formatClock(runDurationSeconds)
              : '—'}
        </span>

        <Divider />

        <Tip label="Requests fired this session">
          <span className="text-[11px] text-slate-500">
            Fired{' '}
            <span className="font-semibold tabular-nums text-slate-800">
              {totalFired}
            </span>
          </span>
        </Tip>
        <IconToggle
          active={false}
          label="Reset counters (keeps the canvas and cache)"
          onClick={resetCounters}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </IconToggle>

        <Divider />

        <ProblemsMenu />
        <Tip
          label={
            activeProblem
              ? `Problem Brief — ${activeProblem.title}`
              : 'Problem Brief — free play, no active problem'
          }
        >
          <button
            type="button"
            onClick={() => setBriefOpen(!isBriefOpen)}
            className={`flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors ${
              isBriefOpen
                ? 'bg-blue-50 text-blue-700'
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
            }`}
          >
            <BookOpen className="h-3.5 w-3.5 shrink-0" />
            <span className="max-w-[110px] truncate">
              {activeProblem ? activeProblem.title : 'Free play'}
            </span>
          </button>
        </Tip>

        <Divider />

        {/* the three metric panels stack, so these are independent toggles */}
        <IconToggle
          active={isLogOpen}
          label="Request log"
          onClick={() => setLogOpen(!isLogOpen)}
        >
          <ScrollText className="h-3.5 w-3.5" />
        </IconToggle>
        <IconToggle
          active={isHealthOpen}
          label="Health — successes vs failures per second"
          onClick={() => setHealthOpen(!isHealthOpen)}
        >
          <Activity className="h-3.5 w-3.5" />
        </IconToggle>
        <IconToggle
          active={isLatencyOpen}
          label="Latency percentiles (p50 / p95 / p99)"
          onClick={() => setLatencyOpen(!isLatencyOpen)}
        >
          <Gauge className="h-3.5 w-3.5" />
        </IconToggle>

        <Divider />

        <Divider />

        <Tip label="Clear all — every node, connection and all history">
          <button
            type="button"
            aria-label="Erase everything"
            onClick={() => {
              if (
                window.confirm(
                  'Erase everything?\n\nThe canvas will be left empty — no diagram, no history, and nothing loaded in its place. This cannot be undone.',
                )
              ) {
                // Store first (this also stops auto-fire), then storage, so a
                // refresh cannot resurrect what was just wiped.
                clearAll()
                clearPersisted()
                resetEdgeFlow()
                track('canvas_cleared')
              }
            }}
            className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </Tip>
      </div>
    </div>
  )
}

export default SimulationControls
