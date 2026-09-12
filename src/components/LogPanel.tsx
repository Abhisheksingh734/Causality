import { Check, ChevronRight, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useFlowStore, type LogEntry } from '../store'
import Badge from './Badge'
import { LOG_PANEL_HEIGHT } from './panelLayout'

type OutcomeFilter = 'all' | 'success' | 'failed' | 'in_progress'
type MethodFilter = 'all' | 'GET' | 'POST'
type CacheFilter = 'all' | 'hit' | 'miss' | 'not_applicable'
type FreshnessFilter = 'all' | 'fresh' | 'stale'

// Kept short and queue-agnostic: a queue is opt-in now, so most rejections
// happen at a node that never had one. The per-request detail says which case
// it was.
const FAILURE_TEXT: Record<string, string> = {
  server_queue_full: 'Server was at capacity and turned the request away',
  database_queue_full: 'Database was at capacity and turned the request away',
  no_database_for_cache_miss: 'Cache missed and no Database is connected to read from',
  no_backend_available: 'The Load Balancer has no Server connected to route to',
  timeout: 'Waited in the queue longer than this node allows; no slot freed in time',
  node_offline: 'The node was switched off, so the request never reached it',
}

const HOP_TEXT: Record<string, string> = {
  request_created: 'Request created',
  outbound_start: 'Travelling to server',
  server_received: 'Arrived at server',
  lb_received: 'Arrived at load balancer',
  server_queued: 'Queued at server',
  server_processing_start: 'Server processing',
  server_processing_end: 'Server done thinking',
  server_to_cache_start: 'Asking the cache',
  cache_hit: 'Cache HIT',
  cache_miss: 'Cache MISS',
  cache_response_start: 'Cache replying',
  cache_response_received: 'Back at server from cache',
  server_to_database_start: 'Travelling to database',
  database_queued: 'Queued at database',
  database_processing_start: 'Database working',
  database_processing_end: 'Database done',
  database_response_received: 'Back at server from database',
  cache_populated: 'Cache populated',
  cache_written: 'Cache written',
  cache_invalidated: 'Cache invalidated',
  inbound_start: 'Response heading home',
  request_completed: 'Completed',
  request_failed: 'Failed',
  primary_forwarded_to_replica: 'Primary sent the read to its replica',
  read_routed_to_primary: 'Served by the primary (read-your-writes)',
  replica_read_start: 'Replica reading',
  replica_read_end: 'Replica done',
  replica_sync_start: 'Replicating to the replica',
  replica_sync_end: 'Replica caught up',
  async_db_write_start: 'Deferred database write started',
  async_db_write_queued: 'Deferred write waiting for a database connection',
  async_db_write_end: 'Deferred database write durable',
  async_db_write_lost: 'Deferred write LOST — acknowledged but never stored',
}

const selectClass =
  'rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[11px] text-slate-700 outline-none focus:border-blue-400'

function MethodBadge({ method }: { method: 'GET' | 'POST' }) {
  // Same blue GET / orange POST language as the packets on the canvas.
  return <Badge tone={method === 'GET' ? 'info' : 'write'}>{method}</Badge>
}

function FreshnessBadge({ value }: { value: LogEntry['readFreshness'] }) {
  if (value !== 'fresh' && value !== 'stale') return null
  // Stale data is a correctness failure, so it reads red; fresh reads green.
  return (
    <Badge tone={value === 'stale' ? 'danger' : 'success'}>
      {value === 'stale' ? 'stale' : 'fresh'}
    </Badge>
  )
}

function CacheBadge({ result }: { result: LogEntry['cacheResult'] }) {
  if (result === null || result === 'not_applicable')
    return <span className="text-[10px] text-slate-300">—</span>
  // Hit is a success; a miss is degraded rather than broken, so amber.
  return (
    <Badge tone={result === 'hit' ? 'success' : 'warning'}>
      {result === 'hit' ? 'hit' : 'miss'}
    </Badge>
  )
}

function OutcomeIcon({ outcome }: { outcome: LogEntry['outcome'] }) {
  if (outcome === 'success')
    return <Check className="h-3.5 w-3.5 shrink-0 text-green-600" strokeWidth={3} />
  if (outcome === 'failed')
    return <X className="h-3.5 w-3.5 shrink-0 text-red-500" strokeWidth={3} />
  return (
    <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-500" />
  )
}

function EntryRow({ entry }: { entry: LogEntry }) {
  const [open, setOpen] = useState(false)

  return (
    <li className="border-b border-slate-100 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-slate-50"
      >
        <ChevronRight
          className={`h-3 w-3 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <OutcomeIcon outcome={entry.outcome} />
        <span className="w-24 shrink-0 font-mono text-[11px] text-slate-600">
          {entry.requestId}
        </span>
        <MethodBadge method={entry.method} />
        <span className="w-24 shrink-0 truncate text-[11px] text-slate-500">
          {entry.resourceKey}
        </span>
        <CacheBadge result={entry.cacheResult} />
        <FreshnessBadge value={entry.readFreshness} />
        <span className="ml-auto shrink-0 tabular-nums text-[11px] text-slate-600">
          {entry.totalDurationMs === null ? '—' : `${entry.totalDurationMs}ms`}
        </span>
        {entry.events.some((e) => e.hop === 'async_db_write_lost') ? (
          <Badge tone="danger">write lost</Badge>
        ) : entry.pendingSync ? (
          <Badge tone="cache">sync pending</Badge>
        ) : null}
      </button>

      {open && (
        <div className="bg-slate-50/60 px-3 pb-3 pt-1">
          <ol className="flex flex-col gap-1 border-l border-slate-200 pl-3">
            {entry.events.map((event, index) => (
              <li key={index} className="flex items-baseline gap-2 text-[11px]">
                <span className="w-14 shrink-0 tabular-nums text-slate-400">
                  +{Math.max(0, event.ts - entry.startedAt)}ms
                </span>
                <span className="font-medium text-slate-700">
                  {HOP_TEXT[event.hop] ?? event.hop}
                </span>
                {event.detail && (
                  <span className="text-slate-400">{event.detail}</span>
                )}
              </li>
            ))}
          </ol>

          {entry.readFreshness === 'stale' && (
            <p className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-[10px] leading-relaxed text-amber-800">
              Served from a replica that had not yet received the latest write
              for this key. The request succeeded — the data was just behind.
            </p>
          )}
          {entry.writePolicyApplied && (
            <p className="mt-2 text-[10px] text-slate-500">
              Write policy applied:{' '}
              <span className="font-medium text-slate-700">
                {entry.writePolicyApplied}
              </span>
            </p>
          )}
          {entry.pendingSync && (
            <p className="mt-2 flex items-center gap-1.5 text-[10px] text-violet-700">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-500" />
              Sync pending — the client was already answered, the database write
              is still catching up.
            </p>
          )}
          {entry.events.some((e) => e.hop === 'async_db_write_lost') && (
            <p className="mt-2 rounded-md bg-red-50 px-2 py-1.5 text-[10px] leading-relaxed text-red-700">
              <span className="font-semibold">Order lost.</span> This request was
              answered successfully, so it never counted against the failure
              rate — but the deferred write never reached the database. Nothing
              on the response told the customer that.
            </p>
          )}
          {entry.outcome === 'failed' && entry.failureReason && (
            <p className="mt-2 rounded-md bg-red-50 px-2 py-1.5 text-[10px] text-red-700">
              <span className="font-semibold">{entry.failureReason}</span> —{' '}
              {/* Timeouts carry their own measured wait in the event detail;
                  everything else falls back to the generic explanation. */}
              {entry.events.find((e) => e.hop === 'request_failed')?.detail !==
              entry.failureReason
                ? entry.events.find((e) => e.hop === 'request_failed')?.detail
                : (FAILURE_TEXT[entry.failureReason] ?? '')}
            </p>
          )}
        </div>
      )}
    </li>
  )
}

function LogPanel() {
  const isLogOpen = useFlowStore((state) => state.isLogOpen)
  // Snapshotted on a timer rather than subscribed: the log is written to a
  // dozen-plus times per request, and re-rendering 200 rows that often is what
  // made high RPS feel like low FPS.
  const [logs, setLogs] = useState<LogEntry[]>(() => useFlowStore.getState().logs)
  // Refresh the moment the panel opens, adjusted during render so there is no
  // extra commit showing a stale snapshot first.
  const [wasOpen, setWasOpen] = useState(isLogOpen)
  if (isLogOpen !== wasOpen) {
    setWasOpen(isLogOpen)
    if (isLogOpen) setLogs(useFlowStore.getState().logs)
  }
  useEffect(() => {
    if (!isLogOpen) return
    const timer = setInterval(() => setLogs(useFlowStore.getState().logs), 400)
    return () => clearInterval(timer)
  }, [isLogOpen])
  const setLogOpen = useFlowStore((state) => state.setLogOpen)
  const clearLogs = useFlowStore((state) => state.clearLogs)

  const [outcome, setOutcome] = useState<OutcomeFilter>('all')
  const [method, setMethod] = useState<MethodFilter>('all')
  const [cache, setCache] = useState<CacheFilter>('all')
  const [freshness, setFreshness] = useState<FreshnessFilter>('all')

  // Filters narrow the view only; the store keeps every entry.
  const visible = useMemo(
    () =>
      logs.filter(
        (entry) =>
          (outcome === 'all' || entry.outcome === outcome) &&
          (method === 'all' || entry.method === method) &&
          (cache === 'all' ||
            (cache === 'not_applicable'
              ? entry.cacheResult === 'not_applicable' ||
                entry.cacheResult === null
              : entry.cacheResult === cache)) &&
          (freshness === 'all' || entry.readFreshness === freshness),
      ),
    [logs, outcome, method, cache, freshness],
  )

  return (
    <section
      aria-hidden={!isLogOpen}
      style={{ height: LOG_PANEL_HEIGHT }}
      className={`absolute inset-x-0 bottom-0 z-20 flex flex-col border-t border-slate-200 bg-white shadow-lg transition-transform duration-200 ease-out ${
        isLogOpen ? 'translate-y-0' : 'pointer-events-none translate-y-full'
      }`}
    >
      <header className="flex items-center gap-2 border-b border-slate-200 px-3 py-2">
        <span className="text-xs font-semibold text-slate-800">
          Request log
        </span>
        <span className="text-[10px] text-slate-400">
          {visible.length} of {logs.length} shown · newest first · last{' '}
          {logs.length === 200 ? '200 (capped)' : logs.length}
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          <select
            className={selectClass}
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as OutcomeFilter)}
          >
            <option value="all">All outcomes</option>
            <option value="success">Success</option>
            <option value="failed">Failed</option>
            <option value="in_progress">In progress</option>
          </select>
          <select
            className={selectClass}
            value={method}
            onChange={(e) => setMethod(e.target.value as MethodFilter)}
          >
            <option value="all">All methods</option>
            <option value="GET">GET</option>
            <option value="POST">POST</option>
          </select>
          <select
            className={selectClass}
            value={cache}
            onChange={(e) => setCache(e.target.value as CacheFilter)}
          >
            <option value="all">All cache</option>
            <option value="hit">Hit</option>
            <option value="miss">Miss</option>
            <option value="not_applicable">N/A</option>
          </select>

          <select
            className={selectClass}
            value={freshness}
            onChange={(e) => setFreshness(e.target.value as FreshnessFilter)}
          >
            <option value="all">All reads</option>
            <option value="fresh">Fresh</option>
            <option value="stale">Stale</option>
          </select>

          <button
            type="button"
            onClick={() => {
              if (
                logs.length === 0 ||
                window.confirm(`Clear all ${logs.length} log entries? This cannot be undone.`)
              ) {
                clearLogs()
                setLogs([])
              }
            }}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-500 transition-colors hover:bg-red-50 hover:text-red-600"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear log
          </button>
          <button
            type="button"
            aria-label="Close log"
            onClick={() => setLogOpen(false)}
            className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] text-slate-400">
            {logs.length === 0
              ? 'No requests yet — fire one to see its trace here.'
              : 'No entries match these filters.'}
          </p>
        ) : (
          <ul>
            {visible.map((entry) => (
              <EntryRow key={entry.requestId} entry={entry} />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

export default LogPanel
