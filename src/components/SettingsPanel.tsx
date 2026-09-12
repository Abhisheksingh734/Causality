import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { COMPONENT_META } from '../componentTypes'
import { SIDE_PANEL_WIDTH } from './panelLayout'
import {
  DEFAULT_SETTINGS,
  useFlowStore,
  type SettingsPatch,
  type SystemNodeData,
  type DatabaseRole,
  type RoutingAlgorithm,
  type WritePolicy,
} from '../store'

const WRITE_POLICIES: { value: WritePolicy; label: string; hint: string }[] = [
  {
    value: 'cache-aside',
    label: 'Cache-aside',
    hint: 'write goes to DB only, cache updates lazily on next read',
  },
  {
    value: 'write-through',
    label: 'Write-through',
    hint: 'write updates DB and cache together',
  },
  {
    value: 'write-back',
    label: 'Write-back',
    hint: 'write updates cache immediately, DB catches up shortly after',
  },
  {
    value: 'write-around',
    label: 'Write-around',
    hint: 'write goes to DB, cache entry is invalidated',
  },
]

const DATABASE_ROLES: { value: DatabaseRole; label: string; hint: string }[] = [
  { value: 'standalone', label: 'Standalone', hint: 'one database, serves every read and write' },
  { value: 'primary', label: 'Primary', hint: 'takes all writes; sends reads to its replica if it has one' },
  { value: 'replica', label: 'Replica', hint: 'serves reads from a copy that trails the primary' },
]

const ROUTING_ALGORITHMS: {
  value: RoutingAlgorithm
  label: string
  hint: string
}[] = [
  {
    value: 'round_robin',
    label: 'Round robin',
    hint: 'each request goes to the next backend in turn, evenly',
  },
  {
    value: 'least_connections',
    label: 'Least connections',
    hint: 'picks whichever backend has the least work in flight right now',
  },
  {
    value: 'random',
    label: 'Random',
    hint: 'picks at random; even over time, lumpy moment to moment',
  },
]

type NumberFieldProps = {
  label: string
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  onCommit: (value: number) => void
}

/**
 * Two-way bound number input. The draft string lets the field go empty or hold
 * a half-typed value without pushing NaN into the store; committed values are
 * always clamped into range so the simulation can never read a bad number.
 */
function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  onCommit,
}: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value))
  const [lastValue, setLastValue] = useState(value)

  // Re-sync when the store changes underneath (e.g. a different node gets
  // selected). Adjusted during render rather than in an effect, so there is no
  // extra commit with a stale draft on screen.
  if (value !== lastValue) {
    setLastValue(value)
    setDraft(String(value))
  }

  const commit = (raw: string) => {
    setDraft(raw)
    if (raw.trim() === '') return
    const parsed = Number(raw)
    if (Number.isNaN(parsed)) return
    onCommit(Math.min(max, Math.max(min, parsed)))
  }

  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-slate-600">
        {label}
        {suffix && <span className="font-normal text-slate-400"> ({suffix})</span>}
      </span>
      <input
        type="number"
        className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs text-slate-800 outline-none transition-colors focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
        value={draft}
        min={min}
        max={max}
        step={step}
        onChange={(event) => commit(event.target.value)}
        onBlur={() => setDraft(String(value))}
      />
    </label>
  )
}

/** Depth used when a queue is switched on and no earlier choice is remembered. */
const STARTING_QUEUE_DEPTH = 5

/**
 * The queue switch and the two controls that only mean anything while it is on.
 * Shared by Server and Database, which previously carried identical copies of
 * the depth field, the timeout field and the explanatory note.
 *
 * Whether a node has a queue is derived from `maxQueueDepth > 0` rather than
 * stored as its own flag. The store already reads depth 0 as "turn arrivals
 * away", and a new settings key would change every node's topology fingerprint
 * in grading.ts, quietly invalidating saved baselines.
 */
function QueueFields({
  maxQueueDepth,
  timeoutMs,
  update,
}: {
  maxQueueDepth: number
  timeoutMs: number
  update: (patch: SettingsPatch) => void
}) {
  const enabled = maxQueueDepth > 0
  // Remembered so switching the queue off and on again does not silently
  // discard a depth the user picked.
  const [lastDepth, setLastDepth] = useState(
    enabled ? maxQueueDepth : STARTING_QUEUE_DEPTH,
  )
  if (enabled && maxQueueDepth !== lastDepth) setLastDepth(maxQueueDepth)

  return (
    <>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5 accent-blue-600"
          checked={enabled}
          onChange={(event) =>
            update({ maxQueueDepth: event.target.checked ? lastDepth : 0 })
          }
        />
        <span className="flex flex-col">
          <span className="text-[11px] font-medium text-slate-600">
            Request queue
          </span>
          <span className="text-[10px] leading-relaxed text-slate-500">
            Hold requests that arrive while every worker is busy, instead of
            turning them away. A queue trades failures for waiting — it does not
            add capacity.
          </span>
        </span>
      </label>

      {enabled && (
        <>
          <NumberField
            label="Max queue depth"
            suffix="requests"
            value={maxQueueDepth}
            min={1}
            max={50}
            onCommit={(depth) => update({ maxQueueDepth: depth })}
          />
          <NumberField
            label="Timeout"
            suffix="ms"
            value={timeoutMs}
            min={0}
            max={60000}
            step={100}
            onCommit={(next) => update({ timeoutMs: next })}
          />
          <p className="rounded-md bg-slate-50 p-2 text-[10px] leading-relaxed text-slate-500">
            Requests waiting in the queue longer than the timeout fail, even if a
            slot later becomes free. Time spent actually processing is never cut
            short.
          </p>
        </>
      )}
    </>
  )
}

function PanelBody({
  data,
  update,
}: {
  data: SystemNodeData
  update: (patch: SettingsPatch) => void
}) {
  switch (data.componentType) {
    case 'client': {
      const percent = data.settings.requestMix.getPercent
      return (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] font-medium text-slate-600">
                GET share of requests
              </span>
              <span className="text-sm font-semibold text-slate-800">
                {percent}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={percent}
              className="w-full accent-blue-600"
              onChange={(event) =>
                update({
                  requestMix: { getPercent: Number(event.target.value) },
                })
              }
            />
            <div className="flex justify-between text-[10px] text-slate-400">
              <span>0% (all POST)</span>
              <span>100% (all GET)</span>
            </div>
          </div>
          <NumberField
            label="Resource key pool"
            suffix="distinct keys"
            value={data.settings.resourceKeyCount}
            min={1}
            max={10}
            onCommit={(resourceKeyCount) => update({ resourceKeyCount })}
          />
          <p className="rounded bg-slate-50 p-2 text-[10px] leading-relaxed text-slate-500">
            Each request picks one key at random from resource-1 to resource-
            {data.settings.resourceKeyCount}. A smaller pool means more cache
            hits.
          </p>
        </div>
      )
    }

    case 'loadbalancer': {
      const s = data.settings
      const algorithm = ROUTING_ALGORITHMS.find(
        (a) => a.value === s.routingAlgorithm,
      )
      return (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-slate-600">
              Routing algorithm
            </span>
            <select
              className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs text-slate-800 outline-none transition-colors focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
              value={s.routingAlgorithm}
              onChange={(event) =>
                update({
                  routingAlgorithm: event.target.value as RoutingAlgorithm,
                })
              }
            >
              {ROUTING_ALGORITHMS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}: {option.hint}
                </option>
              ))}
            </select>
          </label>
          {algorithm && (
            <p className="rounded-md bg-slate-50 p-2 text-[10px] leading-relaxed text-slate-500">
              <span className="font-semibold text-slate-600">
                {algorithm.label}:
              </span>{' '}
              {algorithm.hint}
            </p>
          )}

          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5 accent-blue-600"
              checked={s.healthCheckEnabled}
              onChange={(event) =>
                update({ healthCheckEnabled: event.target.checked })
              }
            />
            <span className="flex flex-col">
              <span className="text-[11px] font-medium text-slate-600">
                Health checks
              </span>
              <span className="text-[10px] leading-relaxed text-slate-500">
                When on, skips backends that are currently full/rejecting
                requests, if a healthier one is available.
              </span>
            </span>
          </label>

          <NumberField
            label="Network latency"
            suffix="ms per client leg"
            value={s.networkLatencyMs}
            min={0}
            max={10000}
            step={50}
            onCommit={(networkLatencyMs) => update({ networkLatencyMs })}
          />

          <NumberField
            label="Transit latency"
            suffix="ms deciding a backend"
            value={s.transitLatencyMs}
            min={0}
            max={2000}
            step={10}
            onCommit={(transitLatencyMs) => update({ transitLatencyMs })}
          />
        </div>
      )
    }

    case 'server': {
      const s = data.settings
      return (
        <div className="flex flex-col gap-3">
          <NumberField
            label="Concurrency limit"
            suffix="parallel"
            value={s.concurrencyLimit}
            min={1}
            max={50}
            onCommit={(concurrencyLimit) => update({ concurrencyLimit })}
          />
          <NumberField
            label="Base processing time"
            suffix="ms"
            value={s.baseProcessingMs}
            min={0}
            max={10000}
            step={50}
            onCommit={(baseProcessingMs) => update({ baseProcessingMs })}
          />
          <NumberField
            label="Network latency"
            suffix="ms per client leg"
            value={s.networkLatencyMs}
            min={0}
            max={10000}
            step={10}
            onCommit={(networkLatencyMs) => update({ networkLatencyMs })}
          />
          <QueueFields
            maxQueueDepth={s.maxQueueDepth}
            timeoutMs={s.timeoutMs}
            update={update}
          />
        </div>
      )
    }

    case 'cache': {
      const s = data.settings
      const selected = WRITE_POLICIES.find((p) => p.value === s.writePolicy)
      return (
        <div className="flex flex-col gap-3">
          <NumberField
            label="Hit latency"
            suffix="ms"
            value={s.hitLatencyMs}
            min={0}
            max={5000}
            step={10}
            onCommit={(hitLatencyMs) => update({ hitLatencyMs })}
          />
          <NumberField
            label="TTL"
            suffix="seconds"
            value={s.ttlSeconds}
            min={0}
            max={3600}
            onCommit={(ttlSeconds) => update({ ttlSeconds })}
          />
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-slate-600">
              Write policy
            </span>
            <select
              className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs text-slate-800 outline-none transition-colors focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
              value={s.writePolicy}
              onChange={(event) =>
                update({ writePolicy: event.target.value as WritePolicy })
              }
            >
              {WRITE_POLICIES.map((policy) => (
                <option key={policy.value} value={policy.value}>
                  {policy.label}: {policy.hint}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <p className="rounded-md bg-slate-50 p-2 text-[10px] leading-relaxed text-slate-500">
              <span className="font-semibold text-slate-600">
                {selected.label}:
              </span>{' '}
              {selected.hint}
            </p>
          )}
        </div>
      )
    }

    case 'database': {
      const s = data.settings
      return (
        <div className="flex flex-col gap-3">
          <NumberField
            label="Network latency"
            suffix="ms per server leg"
            value={s.networkLatencyMs}
            min={0}
            max={10000}
            step={10}
            onCommit={(networkLatencyMs) => update({ networkLatencyMs })}
          />
          <NumberField
            label="Read latency"
            suffix="ms"
            value={s.readLatencyMs}
            min={0}
            max={10000}
            step={50}
            onCommit={(readLatencyMs) => update({ readLatencyMs })}
          />
          <NumberField
            label="Write latency"
            suffix="ms"
            value={s.writeLatencyMs}
            min={0}
            max={10000}
            step={50}
            onCommit={(writeLatencyMs) => update({ writeLatencyMs })}
          />
          <NumberField
            label="Concurrency limit"
            suffix="parallel"
            value={s.concurrencyLimit}
            min={1}
            max={50}
            onCommit={(concurrencyLimit) => update({ concurrencyLimit })}
          />
          <QueueFields
            maxQueueDepth={s.maxQueueDepth}
            timeoutMs={s.timeoutMs}
            update={update}
          />

          <label className="flex flex-col gap-1 border-t border-slate-100 pt-3">
            <span className="text-[11px] font-medium text-slate-600">Role</span>
            <select
              className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs text-slate-800 outline-none transition-colors focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
              value={s.role}
              onChange={(event) =>
                update({ role: event.target.value as DatabaseRole })
              }
            >
              {DATABASE_ROLES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}: {option.hint}
                </option>
              ))}
            </select>
          </label>

          {s.role === 'primary' && (
            <>
              <NumberField
                label="Read-your-writes window"
                suffix="ms"
                value={s.readYourWritesWindowMs}
                min={0}
                max={60000}
                step={100}
                onCommit={(readYourWritesWindowMs) =>
                  update({ readYourWritesWindowMs })
                }
              />
              <p className="rounded-md bg-slate-50 p-2 text-[10px] leading-relaxed text-slate-500">
                GETs for a key written within this window are served directly
                from the Primary instead of the Replica, guaranteeing freshness.
                0 = disabled (always forward to Replica if one is connected).
              </p>
            </>
          )}

          {s.role === 'replica' && (
            <>
              <NumberField
                label="Replication lag"
                suffix="ms behind the primary"
                value={s.replicationLagMs}
                min={0}
                max={60000}
                step={50}
                onCommit={(replicationLagMs) => update({ replicationLagMs })}
              />
              <p className="rounded-md bg-slate-50 p-2 text-[10px] leading-relaxed text-slate-500">
                A write lands on the primary straight away, then takes this long
                to reach the replica. Reads served in between come back stale.
              </p>
            </>
          )}
        </div>
      )
    }
  }
}

function SettingsPanel() {
  const selectedNodeId = useFlowStore((state) => state.selectedNodeId)
  const selectedNode = useFlowStore((state) =>
    state.nodes.find((n) => n.id === state.selectedNodeId),
  )
  const selectNode = useFlowStore((state) => state.selectNode)
  const updateNodeSettings = useFlowStore((state) => state.updateNodeSettings)

  // Hold on to the last node shown so the panel still has content to render
  // while it slides back out.
  const [lastNode, setLastNode] = useState(selectedNode)
  if (selectedNode && selectedNode !== lastNode) {
    setLastNode(selectedNode)
  }

  useEffect(() => {
    if (!selectedNodeId) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') selectNode(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedNodeId, selectNode])

  const node = selectedNode ?? lastNode
  const data = node?.data as SystemNodeData | undefined
  const open = Boolean(selectedNode)
  const meta = data ? COMPONENT_META[data.componentType] : undefined

  return (
    <aside
      aria-hidden={!open}
      style={{ width: SIDE_PANEL_WIDTH }}
      className={`absolute right-0 top-0 z-30 flex h-full flex-col border-l border-slate-200 bg-white shadow-lg transition-transform duration-200 ease-out ${
        open ? 'translate-x-0' : 'pointer-events-none translate-x-full'
      }`}
    >
      {data && meta && node && (
        <>
          <header className="flex items-start justify-between gap-2 border-b border-slate-200 px-4 py-3">
            <div className="flex items-center gap-2">
              <meta.Icon className="h-5 w-5 text-slate-600" strokeWidth={1.75} />
              <div className="flex flex-col">
                <span className="text-sm font-semibold capitalize text-slate-800">
                  {meta.label}
                </span>
                <span className="text-[10px] text-slate-400">{node.id}</span>
              </div>
            </div>
            <button
              type="button"
              aria-label="Close settings"
              className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
              onClick={() => selectNode(null)}
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            <PanelBody
              data={data}
              update={(patch) => updateNodeSettings(node.id, patch)}
            />
          </div>

          {/* Saved diagrams keep whatever settings they were saved with, since
              loading merges stored values over the defaults. This is how an
              existing node opts in to retuned defaults. */}
          <footer className="border-t border-slate-200 px-4 py-2.5">
            <button
              type="button"
              onClick={() =>
                updateNodeSettings(
                  node.id,
                  structuredClone(DEFAULT_SETTINGS[data.componentType]),
                )
              }
              className="text-[11px] text-slate-400 underline-offset-2 transition-colors hover:text-slate-700 hover:underline"
            >
              Reset to defaults
            </button>
          </footer>
        </>
      )}
    </aside>
  )
}

export default SettingsPanel
