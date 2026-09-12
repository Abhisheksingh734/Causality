import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Flame, Power, Settings, Trash2, TriangleAlert, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { track } from '../analytics'
import { COMPONENT_META } from '../componentTypes'
import Badge from './Badge'
import {
  backendsOf,
  countReplicaActive,
  countReplicaQueued,
  primaryOf,
  replicaOf,
  countCacheBusy,
  displayName,
  countDbActive,
  countDbQueued,
  countServerActive,
  countServerQueued,
  DEFAULT_SETTINGS,
  stampedeSignature,
  useFlowStore,
  type SystemNode as SystemNodeType,
} from '../store'

// Four handles, one per side. The canvas runs in ConnectionMode.Loose, so each
// one can act as either end of a connection — edges can be drawn in any
// direction without needing separate source/target handles per side.
const HANDLE_POSITIONS = [
  { id: 'top', position: Position.Top },
  { id: 'right', position: Position.Right },
  { id: 'bottom', position: Position.Bottom },
  { id: 'left', position: Position.Left },
]

const handleClass = '!h-2 !w-2 !border !border-white !bg-slate-400'

const FLASH_MS = 700

/** Above this many workers the pips stop being countable; a bar reads better. */
const MAX_PIPS = 10

/**
 * How busy a node is, as one filled pip per worker.
 *
 * This replaces a row reading "Active: 2 / 6", which asked the reader to do
 * arithmetic to answer the only question they had — is this thing keeping up?
 * Pips answer it without being read, and the caption underneath still gives the
 * exact numbers for anyone who wants them.
 */
function WorkerSlots({ busy, total }: { busy: number; total: number }) {
  const shown = Math.min(busy, total)
  const caption = (
    <span className={total > 0 && shown >= total ? 'text-amber-600' : undefined}>
      {shown} of {total} worker{total === 1 ? '' : 's'} busy
    </span>
  )

  // Fifty pips would be a smear, so wide pools fall back to a proportional bar.
  if (total > MAX_PIPS) {
    return (
      <span className="flex flex-col gap-1">
        <span className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
          <span
            className={`block h-full rounded-full transition-all duration-150 ${
              shown >= total ? 'bg-amber-500' : 'bg-blue-500'
            }`}
            style={{ width: `${total === 0 ? 0 : (shown / total) * 100}%` }}
          />
        </span>
        {caption}
      </span>
    )
  }

  return (
    <span className="flex flex-col gap-1">
      <span className="flex gap-0.5">
        {Array.from({ length: total }).map((_, index) => (
          <span
            key={index}
            className={`h-2 flex-1 rounded-sm transition-colors duration-150 ${
              index < shown
                ? shown >= total
                  ? 'bg-amber-500'
                  : 'bg-blue-500'
                : 'bg-slate-200'
            }`}
          />
        ))}
      </span>
      {caption}
    </span>
  )
}

function SystemNode({ id, data, selected }: NodeProps<SystemNodeType>) {
  const meta = COMPONENT_META[data.componentType]
  const { Icon } = meta
  const isClient = data.componentType === 'client'
  const isServer = data.componentType === 'server'
  const isDatabase = data.componentType === 'database'
  const isCache = data.componentType === 'cache'
  const isLb = data.componentType === 'loadbalancer'
  // Only backing services can be switched off; a client has nothing to serve.
  const canBeKilled = isServer || isCache || isDatabase
  const isKilled = Boolean(data.isKilled)

  // Every selector returns a primitive (or a stored reference), so these stay
  // referentially stable and never re-render in a loop.
  const stats = useFlowStore((state) => state.clientStats[id])
  const notice = useFlowStore((state) => state.notices[id])
  const fireRequest = useFlowStore((state) => state.fireRequest)
  const selectNode = useFlowStore((state) => state.selectNode)
  const toggleNodeKilled = useFlowStore((state) => state.toggleNodeKilled)
  const deleteNode = useFlowStore((state) => state.deleteNode)
  const active = useFlowStore((state) =>
    isDatabase
      ? countDbActive(state.requests, id)
      : countServerActive(state.requests, id),
  )
  const queued = useFlowStore((state) =>
    isDatabase
      ? countDbQueued(state.requests, id)
      : countServerQueued(state.requests, id),
  )
  // Only the node where the request actually died shows the badge.
  // Returns a string (or null) so the selector stays referentially stable.
  const failureKind = useFlowStore((state) => {
    const failure = state.requests.find(
      (r) => r.phase === 'failed' && r.failedNodeId === id,
    )
    if (!failure) return null
    if (failure.failureReason === 'timeout') return 'timeout'
    if (failure.failureReason === 'node_offline') return 'offline'
    return 'rejected'
  })
  const rejecting = failureKind !== null
  const freshReads = useFlowStore((state) => state.replicaStats[id]?.fresh ?? 0)
  const staleReads = useFlowStore((state) => state.replicaStats[id]?.stale ?? 0)
  // A replica read never touches the primary's own queue, so it is counted
  // against the replica instead.
  const replicaActive = useFlowStore((state) => countReplicaActive(state.requests, id))
  const replicaQueued = useFlowStore((state) => countReplicaQueued(state.requests, id))
  const servingStale = useFlowStore((state) =>
    state.requests.some(
      (r) => r.replicaNodeId === id && r.readFreshness === 'stale' &&
        (r.phase === 'replica-processing' || r.phase === 'replica-inbound'),
    ),
  )
  const linkedToPrimary = useFlowStore((state) =>
    Boolean(primaryOf(state.nodes, state.edges, id)),
  )
  const linkedToReplica = useFlowStore((state) =>
    Boolean(replicaOf(state.nodes, state.edges, id)),
  )
  const reads = useFlowStore((state) => state.dbStats[id]?.reads ?? 0)
  const writes = useFlowStore((state) => state.dbStats[id]?.writes ?? 0)
  const hits = useFlowStore((state) => state.cacheStats[id]?.hits ?? 0)
  const misses = useFlowStore((state) => state.cacheStats[id]?.misses ?? 0)
  const pendingSyncs = useFlowStore((state) => state.pendingSyncs[id] ?? 0)
  const lostWrites = useFlowStore(
    (state) => state.cacheStats[id]?.lostWrites ?? 0,
  )
  const cacheBusy = useFlowStore((state) => countCacheBusy(state.requests, id))
  // A string, so this selector stays referentially stable across the dozen-odd
  // store writes every request performs. Sorted worst-first by stampedingKeys,
  // so the head of the list is the one worth naming on the card.
  const stampede = useFlowStore((state) =>
    isCache ? stampedeSignature(state.requests, id) : '',
  )
  const [stampedeKey, stampedeCount] = stampede.split(',')[0]?.split(':') ?? []
  const routed = useFlowStore((state) => state.lbStats[id]?.routed ?? 0)
  const served = useFlowStore((state) => state.serverStats[id]?.served ?? 0)
  // Built as a string so this selector stays referentially stable.
  const breakdown = useFlowStore((state) =>
    isLb
      ? backendsOf(state.nodes, state.edges, id)
          .map(
            (b) =>
              `${displayName(state.nodes, b.node.id)}: ${state.serverStats[b.node.id]?.served ?? 0}`,
          )
          .join(' | ')
      : '',
  )
  const lbBusy = useFlowStore(
    (state) =>
      state.requests.filter(
        (r) => r.loadBalancerNodeId === id && r.phase === 'lb-processing',
      ).length,
  )

  const serverSettings =
    data.componentType === 'server' ? data.settings : DEFAULT_SETTINGS.server
  const dbSettings =
    data.componentType === 'database' ? data.settings : DEFAULT_SETTINGS.database
  const dbRole = isDatabase ? dbSettings.role : 'standalone'
  const isReplica = dbRole === 'replica'
  const isPrimary = dbRole === 'primary'
  const capacity = isDatabase ? dbSettings : serverSettings
  const completed = stats?.completed ?? 0

  // A replica keeps its own worker pool and its own queue, so every capacity
  // readout on a replica card has to come from the replica counters.
  const busyWorkers = isReplica ? replicaActive : active
  const waiting = isReplica ? replicaQueued : queued
  const hasQueue = capacity.maxQueueDepth > 0
  const atCapacity = busyWorkers >= capacity.concurrencyLimit

  // Brief green flash on the client each time a response lands.
  const [flash, setFlash] = useState(false)
  const previousCompleted = useRef(completed)
  useEffect(() => {
    if (completed > previousCompleted.current) {
      previousCompleted.current = completed
      setFlash(true)
      const timer = setTimeout(() => setFlash(false), FLASH_MS)
      return () => clearTimeout(timer)
    }
    previousCompleted.current = completed
  }, [completed])

  const borderClass = isKilled
    ? 'border-red-400 border-dashed'
    : flash
      ? 'border-green-500'
      : selected
        ? 'border-slate-400'
        : 'border-slate-200'

  return (
    <div className="relative">
      {/* Processing indicator: a ring that pulses while the server is busy. */}
      {!isKilled &&
      (((isServer || isDatabase) && busyWorkers > 0) ||
        (isCache && cacheBusy > 0) ||
        (isLb && lbBusy > 0)) ? (
        <span
          className={`pointer-events-none absolute -inset-1.5 animate-pulse rounded-xl border-2 ${
            isCache
              ? 'border-violet-400'
              : isLb
                ? 'border-blue-400'
                : // Amber once every worker is taken. Queueing used to be the
                  // trigger, but a node with no queue can never reach that and
                  // so stayed a reassuring blue while it was turning requests
                  // away. Being full is the state worth seeing, queue or not.
                  atCapacity
                  ? 'border-amber-400'
                  : 'border-blue-400'
          }`}
        />
      ) : null}

      {/* Queue indicator: one small amber dot per waiting request. */}
      {(isServer || isDatabase) && waiting > 0 && (
        <div className="pointer-events-none absolute -top-3.5 left-0 right-0 flex justify-center gap-1">
          {Array.from({ length: waiting }).map((_, index) => (
            <span
              key={index}
              className="h-2 w-2 rounded-full border border-white bg-amber-500"
            />
          ))}
        </div>
      )}

      {/* Rejection indicator, shown at the point of failure. */}
      {isDatabase && dbRole !== 'standalone' && !isKilled && (
        <Badge
          tone="neutral"
          solid
          className="pointer-events-none absolute -left-2 -top-3 z-10 shadow-sm"
        >
          {isPrimary ? 'primary' : 'replica'}
        </Badge>
      )}

      {isReplica && !linkedToPrimary && !isKilled && (
        <Badge
          tone="warning"
          solid
          uppercase={false}
          className="pointer-events-none absolute -bottom-3 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap shadow-sm"
        >
          Not linked to a Primary
        </Badge>
      )}

      {isKilled && (
        <Badge
          tone="danger"
          solid
          className="pointer-events-none absolute -left-2 -top-3 z-10 shadow-sm"
        >
          offline
        </Badge>
      )}

      {isReplica && servingStale && (
        <span className="pointer-events-none absolute -inset-2 animate-ping rounded-xl border-2 border-amber-500 opacity-80" />
      )}

      {/* Cache stampede: several requests for the SAME key all missing at once
          and all going to the database separately. It is not a failure and
          costs nothing visible in the counters — hit ratio barely moves — so
          without this the only trace is a cluster of cache_miss lines sharing a
          timestamp in the Log panel. */}
      {isCache && stampedeKey && !isKilled && (
        <>
          <span className="pointer-events-none absolute -inset-2 animate-ping rounded-xl border-2 border-rose-500 opacity-80" />
          <Badge
            tone="danger"
            solid
            uppercase={false}
            className="pointer-events-none absolute -bottom-3 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap shadow-sm"
          >
            <Flame className="h-2.5 w-2.5 shrink-0" strokeWidth={2.5} />
            stampede: {stampedeCount}× {stampedeKey}
          </Badge>
        </>
      )}

      {rejecting && (
        // Flow mode aggregates successful traffic, so a failure must announce
        // itself at the node instead — a one-off pulse, not a silent stat.
        <span className="pointer-events-none absolute -inset-2 animate-ping rounded-xl border-2 border-red-500 opacity-75" />
      )}

      {rejecting && (
        // Server-level and database-level rejections read differently on
        // purpose, so it is obvious which tier ran out of capacity.
        <Badge
          tone="danger"
          solid
          className="pointer-events-none absolute -right-3 -top-3 z-10 shadow-sm"
        >
          <X className="h-2.5 w-2.5" strokeWidth={3} />
          {failureKind === 'timeout'
            ? 'timed out'
            : failureKind === 'offline'
              ? 'offline'
              : isDatabase
                ? 'db full'
                : 'rejected'}
        </Badge>
      )}

      <div
        className={`relative flex w-40 flex-col items-center gap-2 rounded-md border bg-white px-3 py-3 shadow-sm transition-all ${borderClass} ${
          isKilled ? 'opacity-60 saturate-0' : ''
        }`}
      >
        {HANDLE_POSITIONS.map(({ id: handleId, position }) => (
          <Handle
            key={handleId}
            id={handleId}
            type="source"
            position={position}
            className={handleClass}
          />
        ))}

        {canBeKilled && (
          <button
            type="button"
            aria-label={isKilled ? 'Bring node online' : 'Take node offline'}
            title={isKilled ? 'Bring back online' : 'Take offline'}
            className={`nodrag absolute left-1 top-1 rounded p-1 transition-colors ${
              isKilled
                ? 'text-red-500 hover:bg-red-50'
                : 'text-slate-300 hover:bg-slate-100 hover:text-slate-600'
            }`}
            onClick={(event) => {
              event.stopPropagation()
              toggleNodeKilled(id)
            }}
          >
            <Power className="h-3.5 w-3.5" strokeWidth={2.5} />
          </button>
        )}

        <div className="absolute right-1 top-1 flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Open settings"
            className="nodrag rounded p-1 text-slate-300 transition-colors hover:bg-slate-100 hover:text-slate-600"
            onClick={(event) => {
              event.stopPropagation()
              selectNode(id)
            }}
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Delete this component"
            title="Delete this component"
            // Deleting used to need the Delete key, which a touch device does
            // not have.
            className="nodrag rounded p-1 text-slate-300 transition-colors hover:bg-red-50 hover:text-red-600"
            onClick={(event) => {
              event.stopPropagation()
              deleteNode(id)
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>

        <Icon className="h-6 w-6 text-slate-600" strokeWidth={1.75} />
        <span className="text-xs font-medium capitalize text-slate-700">
          {/* Fall back to the palette's label so 'loadbalancer' does not
              render as "Loadbalancer". */}
          {data.label === data.componentType ? meta.label : data.label}
        </span>

        {canBeKilled && (
          <span
            className={`flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide ${
              isKilled ? 'text-red-600' : 'text-green-600'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                isKilled ? 'bg-red-500' : 'bg-green-500'
              }`}
            />
            {isKilled ? 'Offline' : 'Online'}
          </span>
        )}

        {isClient && (
          <div className="flex w-full flex-col items-center gap-1.5 border-t border-slate-100 pt-2">
            <div className="flex w-full justify-between text-[10px] leading-tight text-slate-500">
              <span>Sent: {stats?.sent ?? 0}</span>
              <span className="text-green-600">Completed: {completed}</span>
            </div>
            <div className="w-full text-[10px] leading-tight text-red-500">
              Failed: {stats?.failed ?? 0}
            </div>
            <button
              type="button"
              // nodrag stops React Flow from treating the click as a node drag.
              className="nodrag w-full rounded-md bg-blue-600 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-blue-700 active:bg-blue-800"
              onClick={(event) => {
                // Keep the click off the node wrapper so firing a request
                // never also opens the settings panel.
                event.stopPropagation()
                fireRequest(id)
                // Tracked here rather than in the store, because auto-fire
                // calls the very same action once per request.
                track('simulation_started', { mode: 'manual' })
              }}
            >
              Fire Request
            </button>
            {notice && (
              <span className="text-[10px] leading-tight text-amber-600">
                {notice}
              </span>
            )}
          </div>
        )}

        {isCache && (
          <div className="flex w-full flex-col gap-0.5 border-t border-slate-100 pt-2 text-[10px] leading-tight text-slate-500">
            <span className="flex justify-between">
              <span>
                Hits: <span className="font-medium text-green-600">{hits}</span>
              </span>
              <span>
                Misses:{' '}
                <span className="font-medium text-amber-600">{misses}</span>
              </span>
            </span>
            <span>
              Hit ratio:{' '}
              <span className="font-medium text-slate-700">
                {hits + misses === 0
                  ? '—'
                  : `${Math.round((hits / (hits + misses)) * 100)}%`}
              </span>
            </span>
            {pendingSyncs > 0 && (
              // Write-back only: data acknowledged to the client but not yet
              // durable in the database. Still in progress, so it reads as
              // in-flight work rather than as a problem.
              <span className="text-violet-600">
                Pending syncs:{' '}
                <span className="font-semibold">{pendingSyncs}</span>
              </span>
            )}
            {lostWrites > 0 && (
              // Deliberately louder than every other counter on this card. A
              // lost write is the one number here that means data is gone, and
              // it is invisible everywhere else on the canvas: pendingSyncs
              // ticks down on a loss exactly as it does on a success, and the
              // client was already told the write worked, so the failure rate
              // stays at zero. Without this the only trace is in the Log panel.
              <span className="-mx-1 mt-0.5 flex items-center gap-1 rounded-md bg-red-50 px-1 py-0.5 font-semibold text-red-600">
                <TriangleAlert className="h-3 w-3 shrink-0" strokeWidth={2.5} />
                {lostWrites} write{lostWrites === 1 ? '' : 's'} lost
              </span>
            )}
          </div>
        )}

        {isLb && (
          <div className="flex w-full flex-col gap-0.5 border-t border-slate-100 pt-2 text-[10px] leading-tight text-slate-500">
            <span>
              Routed: <span className="font-medium text-sky-600">{routed}</span>
            </span>
            {breakdown && (
              <span className="truncate text-[9px] text-slate-400" title={breakdown}>
                {breakdown}
              </span>
            )}
          </div>
        )}

        {(isServer || isDatabase) && (
          <div className="flex w-full flex-col gap-0.5 border-t border-slate-100 pt-2 text-[10px] leading-tight text-slate-500">
            <WorkerSlots busy={busyWorkers} total={capacity.concurrencyLimit} />
            {/* Only nodes that actually have a queue talk about one. */}
            {hasQueue && (
              <span>
                Waiting:{' '}
                <span className="font-medium text-amber-600">{waiting}</span> of{' '}
                {capacity.maxQueueDepth}
              </span>
            )}
            {isReplica && (
              <>
                <span className="text-indigo-600">
                  Lag: {dbSettings.replicationLagMs}ms
                </span>
                <span className="flex justify-between">
                  <span>
                    Fresh:{' '}
                    <span className="font-medium text-green-600">{freshReads}</span>
                  </span>
                  <span>
                    Stale:{' '}
                    <span className="font-medium text-amber-600">{staleReads}</span>
                  </span>
                </span>
              </>
            )}
            {isPrimary && linkedToReplica && (
              <span className="text-indigo-600">Reads go to the replica</span>
            )}
            {isServer && (
              <span>
                Served: <span className="font-medium text-slate-700">{served}</span>
              </span>
            )}
            {isDatabase && (
              <span className="flex justify-between pt-0.5">
                <span>
                  Reads: <span className="font-medium text-blue-600">{reads}</span>
                </span>
                <span>
                  Writes:{' '}
                  <span className="font-medium text-orange-600">{writes}</span>
                </span>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default SystemNode
