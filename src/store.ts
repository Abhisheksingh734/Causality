import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  MarkerType,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type XYPosition,
} from '@xyflow/react'
import { create } from 'zustand'
import { track } from './analytics'
import type { BaselineMetrics } from './grading'
import type { ComponentType } from './componentTypes'

/* ------------------------------------------------------------------ *
 * Node data
 * ------------------------------------------------------------------ */

export type ClientSettings = {
  requestMix: { getPercent: number }
  /** Size of the key pool this client reads and writes, e.g. resource-1..3. */
  resourceKeyCount: number
  /**
   * Share of requests aimed at one designated hot key (HOT_KEY), modelling a
   * viral link or trending item. The rest spread evenly over the other keys.
   *
   * Deliberately absent rather than defaulted to 0, and so deliberately NOT in
   * DEFAULT_SETTINGS. `fingerprintTopology` in grading.ts stringifies a node's
   * whole settings object, so a new key present on every client would change
   * every saved baseline's fingerprint — the same reason the queue switch was
   * derived from maxQueueDepth instead of getting a flag of its own. Undefined
   * and 0 mean the same thing to `pickResourceKey`; undefined also serialises
   * away, so a client nobody has touched fingerprints exactly as it did before
   * this setting existed.
   */
  hotKeyPercent?: number
}

export type ServerSettings = {
  concurrencyLimit: number
  baseProcessingMs: number
  maxQueueDepth: number
  networkLatencyMs: number
  /** How long a request may wait in the queue before giving up. */
  timeoutMs: number
}

export type RoutingAlgorithm = 'round_robin' | 'least_connections' | 'random'

export type LoadBalancerSettings = {
  routingAlgorithm: RoutingAlgorithm
  healthCheckEnabled: boolean
  /**
   * The client-facing network hop, used for BOTH the client -> balancer and
   * balancer -> client legs. A balancer is the front door, so it owns that
   * leg exactly the way a directly-connected Server owns its own. These legs
   * previously borrowed a backend Server's networkLatencyMs, which made the
   * balancer's own configuration have no effect on them at all.
   */
  networkLatencyMs: number
  /** Time spent inside the balancer choosing a backend. Not a network cost. */
  transitLatencyMs: number
}

export type WritePolicy =
  | 'cache-aside'
  | 'write-through'
  | 'write-back'
  | 'write-around'

/** Cache settings. */
export type CacheSettings = {
  hitLatencyMs: number
  ttlSeconds: number
  writePolicy: WritePolicy
}

/** Database settings. */
export type DatabaseRole = 'standalone' | 'primary' | 'replica'

export type DatabaseSettings = {
  /**
   * Cost of one server <-> database leg. This used to be a fixed 150ms
   * constant, which charged a transatlantic price for a link that normally
   * lives in the same datacentre as the server calling it — and sat oddly
   * beside the 10ms cache transit. As a setting it can also model the honest
   * case for a large number: a replica in another region.
   */
  networkLatencyMs: number
  readLatencyMs: number
  writeLatencyMs: number
  concurrencyLimit: number
  /** 0 means no queue: an arrival that finds every worker busy is turned away. */
  maxQueueDepth: number
  /** How long a request may wait in the queue before timing out. */
  timeoutMs: number
  /**
   * 'standalone' is the default and behaves exactly as a database always has.
   * The replication paths below are only reachable from 'primary'/'replica'.
   */
  role: DatabaseRole
  /** Replica only: how far behind the primary it runs. */
  replicationLagMs: number
  /**
   * Primary only. A GET for a key written this recently is served by the
   * primary itself rather than the replica, so the writer always sees their
   * own write. 0 disables it, which is the pre-existing behaviour exactly.
   */
  readYourWritesWindowMs: number
}

export type SettingsByType = {
  client: ClientSettings
  loadbalancer: LoadBalancerSettings
  server: ServerSettings
  cache: CacheSettings
  database: DatabaseSettings
}

export type NodeSettings = SettingsByType[ComponentType]

/**
 * A patch may name any field from any node type. Field names that appear in
 * more than one settings type (concurrencyLimit, maxQueueDepth) agree on their
 * value type, so the intersection stays well formed.
 */
export type SettingsPatch = Partial<
  ClientSettings &
    LoadBalancerSettings &
    ServerSettings &
    CacheSettings &
    DatabaseSettings
>

/**
 * Tuned so the first diagram a beginner builds behaves sensibly.
 *
 * The previous numbers did not. A default client -> server -> database GET cost
 * 2500ms, 800ms of which was client <-> server network alone, so adding a cache
 * only bought 1.45x — the network floor was untouchable and the whole point of
 * a cache landed weakly. Worse, the server held a worker for 1700ms, giving it
 * 1.76 req/s of capacity against a default auto-fire rate of 2/s: the stock
 * setup was over capacity out of the box and began rejecting after about
 * thirteen seconds.
 *
 * These keep the ratios that teach something and drop the ones that only got
 * in the way. Network and in-datacentre hops are cheap; the database is the
 * obvious bottleneck; writeLatencyMs stays ~2x readLatencyMs.
 *
 *   GET, no cache   60 + 40 + 10 + 400 + 10 + 60  =  580ms
 *   GET, cache hit  60 + 40 + 10 +  20 + 10 + 60  =  200ms   (2.9x faster)
 *   Server capacity 6 workers / 460ms hold        =   13 req/s
 *
 * That leaves real headroom at the default rate while staying breakable:
 * MAX_RPS is 20, so a learner can push past capacity, watch requests get turned
 * away, and discover the queue as the answer.
 */
export const DEFAULT_SETTINGS: { [K in ComponentType]: SettingsByType[K] } = {
  client: { requestMix: { getPercent: 100 }, resourceKeyCount: 3 },
  loadbalancer: {
    routingAlgorithm: 'round_robin',
    healthCheckEnabled: true,
    networkLatencyMs: 60,
    transitLatencyMs: 10,
  },
  server: {
    concurrencyLimit: 6,
    baseProcessingMs: 40,
    // No queue by default. Capacity being finite is the first lesson; a queue
    // is a deliberate second one, with its own trade-off.
    maxQueueDepth: 0,
    networkLatencyMs: 60,
    timeoutMs: 3000,
  },
  cache: { hitLatencyMs: 20, ttlSeconds: 30, writePolicy: 'cache-aside' },
  database: {
    networkLatencyMs: 10,
    readLatencyMs: 400,
    writeLatencyMs: 800,
    concurrencyLimit: 6,
    maxQueueDepth: 0,
    timeoutMs: 5000,
    role: 'standalone',
    replicationLagMs: 500,
    readYourWritesWindowMs: 0,
  },
}

/** Discriminated on componentType, so a narrowed node exposes its own settings. */
export type SystemNodeDataFor<T extends ComponentType> = {
  componentType: T
  label: string
  settings: SettingsByType[T]
  /**
   * Manual outage switch. Deliberately NOT part of `settings`: it is transient
   * session state, so a node killed during an experiment comes back online on
   * the next page load rather than staying mysteriously dead.
   */
  isKilled?: boolean
}

export type SystemNodeData = {
  [K in ComponentType]: SystemNodeDataFor<K>
}[ComponentType]

export type SystemNode = Node<SystemNodeData, 'systemNode'>

/* ------------------------------------------------------------------ *
 * In-flight requests
 * ------------------------------------------------------------------ */

export type RequestPhase =
  | 'outbound' // client -> server (direct topology)
  | 'lb-outbound' // client -> load balancer
  | 'lb-processing' // load balancer choosing a backend
  | 'lb-to-server' // load balancer -> chosen server
  | 'server-to-lb' // server -> load balancer, on the way home
  | 'lb-inbound' // load balancer -> client
  | 'queued' // waiting for a server worker
  | 'processing' // server thinking
  | 'cache-outbound' // server -> cache (lookup)
  | 'cache-lookup' // at the cache, deciding hit or miss
  | 'cache-inbound' // cache -> server
  | 'db-outbound' // server -> database
  | 'db-queued' // waiting for a database worker
  | 'db-processing' // database read/write
  | 'db-inbound' // database -> server
  | 'replica-outbound' // primary -> replica
  | 'replica-queued' // waiting for a replica worker
  | 'replica-processing' // replica serving the read
  | 'replica-inbound' // replica -> primary
  | 'cache-update' // server -> cache (populate / write / invalidate)
  | 'cache-writing' // at the cache, applying that update
  | 'inbound' // server -> client
  | 'complete'
  | 'failed'
  | 'sync-outbound' // background write-back flush: server -> database
  | 'sync-queued' // flush waiting for a database connection
  | 'sync-writing' // background flush landing in the database

export type RequestMethod = 'GET' | 'POST'

/** Phases that animate along an edge, as opposed to sitting at a node. */
export const TRAVEL_PHASES: RequestPhase[] = [
  'outbound',
  'lb-outbound',
  'lb-to-server',
  'server-to-lb',
  'lb-inbound',
  'cache-outbound',
  'cache-inbound',
  'db-outbound',
  'db-inbound',
  'replica-outbound',
  'replica-inbound',
  'cache-update',
  'inbound',
  'sync-outbound',
]

/**
 * Phases during which the request still occupies one of the server's workers.
 * The server holds its slot for the whole database round trip: a blocked
 * worker is what makes slow database reads back up into the server queue,
 * which is the behaviour this tool exists to show.
 */
const SERVER_BUSY_PHASES: RequestPhase[] = [
  'processing',
  'cache-outbound',
  'cache-lookup',
  'cache-inbound',
  'db-outbound',
  'db-queued',
  'db-processing',
  'db-inbound',
  'replica-outbound',
  'replica-queued',
  'replica-processing',
  'replica-inbound',
  'cache-update',
  'cache-writing',
]

// The server <-> database hop used to be a fixed INTERNAL_HOP_MS = 150 here.
// It is now DatabaseSettings.networkLatencyMs, read from whichever database or
// replica the leg actually touches.

/** Load balancer <-> server hop; an internal datacenter link. */
export const LB_HOP_MS = 10
/**
 * Server <-> cache transit, applied to every cache leg: the lookup out, the
 * response back, and the populate/write/invalidate side trip.
 *
 * This was 100ms — network-scale, two thirds of a database hop — which made an
 * in-memory lookup cost about as much as talking to another machine and
 * flattened the whole point of having a cache. A cache sits in the same
 * process or the same rack; the transit is nearly free and the configured
 * hitLatencyMs is what should dominate.
 */
export const CACHE_TRANSIT_MS = 10
/** Cost of discovering a miss, as opposed to serving a hit. */
export const CACHE_MISS_LOOKUP_MS = 40
/** How long the cache takes to apply a populate/write/invalidate. */
export const CACHE_WRITE_MS = 60
/** Delay before a write-back cache flushes a dirty key to the database. */
export const WRITE_BACK_DELAY_MS = 1500
// A background flush used to cost a flat SYNC_WRITE_MS here. It now costs the
// database's own writeLatencyMs, because a deferred write is the same work as
// a synchronous one — only later.

/** Auto-fire rate bounds. Kept deliberately low: this is a teaching tool, not
 *  a load generator. */
export const MIN_RPS = 0.5
export const MAX_RPS = 20

export type InFlightRequest = {
  id: string
  /** The client that issued it. */
  sourceNodeId: string
  /** The server handling it. Empty until a load balancer picks one. */
  targetNodeId: string
  /** The balancer in front, when the client is not wired straight to a server. */
  loadBalancerNodeId?: string
  /** Edge between the balancer and the server it chose. */
  lbServerEdgeId?: string
  /** The database behind that server, when one is connected. */
  databaseNodeId?: string
  /** The cache beside that server, when one is connected. */
  cacheNodeId?: string
  /** The replica behind the primary, when the read was forwarded to one. */
  replicaNodeId?: string
  replicaEdgeId?: string
  /** Edge between client and server; the outbound and inbound legs use it. */
  clientEdgeId: string
  /** Edge between server and database, when one is connected. */
  dbEdgeId?: string
  /** Edge between server and cache, when one is connected. */
  cacheEdgeId?: string
  /** Edge the current leg animates along. */
  currentEdgeId: string
  /** Endpoints of the current leg, so the renderer knows which way to travel. */
  legFromNodeId: string
  legToNodeId: string
  phase: RequestPhase
  method: RequestMethod
  /** Duration of the leg currently being animated, in ms. */
  legDurationMs: number
  /** Where it died, so the right node shows the rejection badge. */
  failedNodeId?: string
  /** Why it died, so the badge can say which kind of failure it was. */
  failureReason?: FailureReason
  /** When it entered its current queue; the timeout is measured from here. */
  queuedAt?: number
  /** Which key this request reads or writes. */
  resourceKey: string
  /**
   * This request was aimed at the designated hot key by a client configured for
   * skew. Recorded rather than re-derived, because `resourceKey === HOT_KEY` is
   * not the same question: with no hot-key share configured, resource-1 is an
   * ordinary key that a third of default traffic lands on, and flagging it would
   * be noise.
   */
  isHotKey?: boolean
  /** Recorded at lookup time, so the return legs can be labelled honestly. */
  cacheOutcome?: 'hit' | 'miss'
  /** Whether a replica-served read was up to date. */
  readFreshness?: ReadFreshness
  /** What the pending cache-update leg is meant to do when it lands. */
  cacheAction?: 'populate' | 'write' | 'invalidate'
  /** Background write-back flushes ride the same machinery but are not
   *  client requests: they never touch client counters. */
  kind: 'request' | 'sync'
  /** For a flush: the request whose log entry the async events belong to. */
  originRequestId?: string
  /** How this request reached its server. */
  routedVia: 'direct' | 'load_balancer'
}

/* ------------------------------------------------------------------ *
 * Request log (distributed-trace style)
 * ------------------------------------------------------------------ */

export type LogEventName =
  | 'request_created'
  | 'outbound_start'
  | 'server_received'
  | 'server_queued'
  | 'server_processing_start'
  | 'server_processing_end'
  | 'server_to_cache_start'
  | 'cache_hit'
  | 'cache_miss'
  | 'cache_response_start'
  | 'cache_response_received'
  | 'server_to_database_start'
  | 'database_queued'
  | 'database_processing_start'
  | 'database_processing_end'
  | 'database_response_received'
  | 'cache_populated'
  | 'cache_written'
  | 'cache_invalidated'
  | 'lb_received'
  | 'lb_routing_decision'
  | 'inbound_start'
  | 'request_completed'
  | 'request_failed'
  | 'async_db_write_start'
  | 'async_db_write_queued'
  | 'async_db_write_end'
  /** The deferred write never made it: acknowledged to the client, then lost. */
  | 'async_db_write_lost'
  | 'primary_forwarded_to_replica'
  | 'read_routed_to_primary'
  | 'replica_read_start'
  | 'replica_read_end'
  | 'replica_sync_start'
  | 'replica_sync_end'

export type LogEvent = { ts: number; hop: LogEventName; detail?: string }

export type FailureReason =
  | 'server_queue_full'
  | 'database_queue_full'
  | 'no_database_for_cache_miss'
  | 'no_backend_available'
  /** Waited too long in a queue. Distinct from being turned away at the door. */
  | 'timeout'
  /** The node was switched off. Not a capacity problem at all. */
  | 'node_offline'

export type CacheResult = 'hit' | 'miss' | 'not_applicable'

/** Whether a read came back current, or from a replica still catching up. */
export type ReadFreshness = 'fresh' | 'stale' | 'not_applicable'

export type LogEntry = {
  requestId: string
  method: RequestMethod
  resourceKey: string
  startedAt: number
  finishedAt: number | null
  totalDurationMs: number | null
  outcome: 'in_progress' | 'success' | 'failed'
  failureReason: FailureReason | null
  cacheResult: CacheResult | null
  /** Null until a read resolves; 'not_applicable' when no replica served it. */
  readFreshness: ReadFreshness | null
  writePolicyApplied: string | null
  pendingSync: boolean
  /** How the request reached a server. */
  routedVia: 'direct' | 'load_balancer'
  /** The balancer that routed it, when one was involved. */
  loadBalancerNodeId: string | null
  loadBalancerLabel: string | null
  /** Which server ultimately handled it. */
  servedByNodeId: string | null
  events: LogEvent[]
}

/**
 * The log is a viewer buffer: 200 rich entries with full event timelines is
 * all anyone reads, and rendering more would crawl.
 */
export const LOG_CAP = 200

/**
 * Statistics are a different problem. The Health chart and the Latency
 * percentiles need every resolved request for the whole session, not the tail
 * the log viewer happens to be holding, so each one also drops five small
 * fields here. 50k samples is roughly 40 minutes at 20 req/s.
 */
export const METRIC_CAP = 50_000

/** A lightweight trail of manual outages, used by the kill-test criterion. */
export type NodeToggleEvent = {
  nodeId: string
  action: 'killed' | 'revived'
  ts: number
}

const NODE_EVENT_CAP = 500

export type MetricSample = {
  /** When it resolved. */
  t: number
  /** Total duration in ms. */
  d: number
  outcome: 'success' | 'failed'
  method: RequestMethod
  cache: CacheResult
}

/** The cache verdict for a finished request, matching the log entry's rule. */
const cacheResultOf = (request: InFlightRequest): CacheResult =>
  request.cacheNodeId === undefined || request.method === 'POST'
    ? 'not_applicable'
    : (request.cacheOutcome ?? 'not_applicable')

const withSample = (
  metrics: MetricSample[],
  request: InFlightRequest,
  outcome: 'success' | 'failed',
): MetricSample[] => {
  const now = Date.now()
  const next = [
    ...metrics,
    {
      t: now,
      d: simElapsed(request.id),
      outcome,
      method: request.method,
      cache: cacheResultOf(request),
    },
  ]
  return next.length > METRIC_CAP ? next.slice(next.length - METRIC_CAP) : next
}

const withLogEntry = (
  logs: LogEntry[],
  requestId: string,
  update: (entry: LogEntry) => LogEntry,
) => logs.map((entry) => (entry.requestId === requestId ? update(entry) : entry))

/** Appends to exactly one entry, matched by id — never "the latest" one. */
const withLogEvent = (
  logs: LogEntry[],
  requestId: string,
  hop: LogEventName,
  detail?: string,
) =>
  withLogEntry(logs, requestId, (entry) => ({
    ...entry,
    events: [...entry.events, { ts: Date.now(), hop, detail }],
  }))

/**
 * Every write the client was told succeeded, and what became of it.
 *
 * `acknowledged` counts successful POSTs whose write was deferred by a
 * write-back cache; a synchronous policy is already durable when the response
 * goes out, so it never appears here. `durable` are the ones that later landed
 * in the database. `lost` are the ones that did not: the flush found the
 * database full and was dropped, or its database went away. Those are real
 * lost orders — acknowledged to the customer and never recorded.
 */
export type WriteDurability = {
  acknowledged: number
  durable: number
  lost: number
}

export const EMPTY_DURABILITY: WriteDurability = {
  acknowledged: 0,
  durable: 0,
  lost: 0,
}

export type ClientStats = { sent: number; completed: number; failed: number }

const EMPTY_STATS: ClientStats = { sent: 0, completed: 0, failed: 0 }

export type DbStats = { reads: number; writes: number }

const EMPTY_DB_STATS: DbStats = { reads: 0, writes: 0 }

export type CacheEntry = { value: true; cachedAt: number }
/** Per cache node: the keys it currently holds. */
export type CacheContents = Record<string, CacheEntry>

export type LbStats = { routed: number }
export type ServerStats = { served: number }

/** Per key, when the primary last committed a write. */
export type KeyTimestamps = Record<string, number>

export type ReplicaStats = { fresh: number; stale: number }

export type CacheStats = {
  hits: number
  misses: number
  /**
   * Write-back flushes this cache acknowledged to a client and then failed to
   * store. Counted per cache so the node card can show it, because a loss is
   * otherwise invisible on the canvas: pendingSyncs simply ticks down, exactly
   * as it does when a flush succeeds.
   */
  lostWrites: number
}

const EMPTY_CACHE_STATS: CacheStats = { hits: 0, misses: 0, lostWrites: 0 }

/** How long a rejected request lingers at the server before disappearing. */
const REJECTION_LINGER_MS = 900
/** How long a completed request lingers so the client flash has something to key on. */
const COMPLETION_LINGER_MS = 200
const NOTICE_MS = 2500

/* ------------------------------------------------------------------ *
 * Timers
 * ------------------------------------------------------------------ */

// A request is only ever waiting on one thing at a time, so one timer per id
// is enough. Keeping them here lets us cancel cleanly when a node is deleted
// mid-flight instead of firing callbacks against state that no longer exists.
const requestTimers = new Map<string, ReturnType<typeof setTimeout>>()
const noticeTimers = new Map<string, ReturnType<typeof setTimeout>>()
// Write-back flushes are scheduled after their request is already gone, so
// they get their own timers rather than borrowing the request's slot.
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Simulated elapsed time per request, in modelled milliseconds.
 *
 * Reported latency deliberately does NOT come from the wall clock. Every hop is
 * a setTimeout, and each one fires a few milliseconds late; across the dozen or
 * so hops of a single round trip that overhead compounds, and it grows with
 * load as the browser coalesces timers. Measuring `Date.now()` end to end
 * therefore reported the browser's scheduler as if it were the system's
 * latency, and gave a different number for the same design on every run.
 *
 * Instead each modelled delay is added here as it is scheduled, so a round trip
 * costs exactly what the node settings say it costs. Queue waiting is added
 * from the wall clock at admission, because how long a request waits for a busy
 * worker is genuine emergent behaviour rather than scheduler noise.
 */
const simClocks = new Map<string, number>()

function advanceSim(requestId: string, ms: number) {
  simClocks.set(requestId, (simClocks.get(requestId) ?? 0) + ms)
}

/** Modelled milliseconds a request has spent so far. */
function simElapsed(requestId: string): number {
  return Math.round(simClocks.get(requestId) ?? 0)
}

/** Charges `ms` of modelled time, then waits that long for real. */
function scheduleFor(requestId: string, ms: number, run: () => void) {
  advanceSim(requestId, ms)
  armTimerFor(requestId, ms, run)
}

/**
 * Waits without charging modelled time. For deadlines that are cancelled when
 * the thing they are watching for happens (a queue timeout) and for the linger
 * that keeps a finished packet on screen — neither is time the request spends.
 */
function armTimerFor(requestId: string, ms: number, run: () => void) {
  clearTimerFor(requestId)
  requestTimers.set(
    requestId,
    setTimeout(() => {
      requestTimers.delete(requestId)
      run()
    }, ms),
  )
}

/** Adds the wall-clock time a request sat in a queue to its modelled total. */
function chargeQueueWait(request: { id: string; queuedAt?: number }) {
  if (request.queuedAt === undefined) return
  advanceSim(request.id, Math.max(0, Date.now() - request.queuedAt))
}

/** Cancels every outstanding timer. Used when wiping the whole simulation. */
export function clearAllTimers() {
  for (const timer of requestTimers.values()) clearTimeout(timer)
  requestTimers.clear()
  for (const timer of noticeTimers.values()) clearTimeout(timer)
  noticeTimers.clear()
  for (const timer of flushTimers.values()) clearTimeout(timer)
  flushTimers.clear()
  simClocks.clear()
}

function clearTimerFor(requestId: string) {
  const timer = requestTimers.get(requestId)
  if (timer !== undefined) {
    clearTimeout(timer)
    requestTimers.delete(requestId)
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

let nodeCounter = 0
const nextNodeId = () => `node-${++nodeCounter}`

// Trace-style ids: short, readable, and safe to say out loud — "req-a3f9c1".
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const randomRequestId = () => {
  let out = ''
  for (let i = 0; i < 6; i += 1) {
    out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]
  }
  return `req-${out}`
}
/** Regenerates on the (very unlikely) collision with a live or logged id. */
const nextRequestId = (taken: Set<string>) => {
  let id = randomRequestId()
  while (taken.has(id)) id = randomRequestId()
  return id
}
let syncCounter = 0
const nextSyncId = () => `sync-${++syncCounter}`

export const EDGE_DEFAULTS = {
  type: 'requestEdge',
  style: { stroke: '#94a3b8', strokeWidth: 2 },
  markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8' },
} satisfies Partial<Edge>

const dataOf = (node: Node | undefined) =>
  node?.data as SystemNodeData | undefined

/** Server settings for a node, falling back to defaults for anything else. */
const serverSettingsOf = (node: Node | undefined): ServerSettings => {
  const data = dataOf(node)
  return data?.componentType === 'server' ? data.settings : DEFAULT_SETTINGS.server
}

/* Counters shared by the admission logic and the node cards, so the number a
 * user reads is the same one the simulation gates on. */

export const countServerActive = (
  requests: InFlightRequest[],
  serverId: string,
) =>
  requests.filter(
    (r) => r.targetNodeId === serverId && SERVER_BUSY_PHASES.includes(r.phase),
  ).length

export const countServerQueued = (
  requests: InFlightRequest[],
  serverId: string,
) => requests.filter((r) => r.targetNodeId === serverId && r.phase === 'queued').length

// A deferred write-back flush occupies a database connection exactly like a
// synchronous write does. It used to bypass admission entirely — unlimited
// parallelism, no queue, and therefore no way for a write to ever be lost —
// which quietly made write-back free and hid the risk the policy actually
// carries.
export const countDbActive = (requests: InFlightRequest[], dbId: string) =>
  requests.filter(
    (r) =>
      r.databaseNodeId === dbId &&
      (r.phase === 'db-processing' || r.phase === 'sync-writing'),
  ).length

export const countDbQueued = (requests: InFlightRequest[], dbId: string) =>
  requests.filter(
    (r) =>
      r.databaseNodeId === dbId &&
      (r.phase === 'db-queued' || r.phase === 'sync-queued'),
  )
    .length

/** Keys the cache currently holds for a node, honouring TTL. */
export const isCacheHit = (
  contents: CacheContents | undefined,
  key: string,
  ttlSeconds: number,
  now: number = Date.now(),
) => {
  const entry = contents?.[key]
  if (!entry) return false
  // An expired entry is a miss exactly like a key that was never cached.
  return now - entry.cachedAt < ttlSeconds * 1000
}

export const cacheSettingsOf = (node: Node | undefined): CacheSettings => {
  const data = dataOf(node)
  return data?.componentType === 'cache' ? data.settings : DEFAULT_SETTINGS.cache
}

/** Requests currently sitting at a given cache. */
export const countCacheBusy = (requests: InFlightRequest[], cacheId: string) =>
  requests.filter(
    (r) =>
      r.cacheNodeId === cacheId &&
      (r.phase === 'cache-lookup' || r.phase === 'cache-writing'),
  ).length

/**
 * The window in which a missed read is "falling through to the database": from
 * the moment the lookup comes back empty to the moment the data is on its way
 * home. Nothing here has an answer yet, so every request in this state for the
 * same key is duplicated work.
 *
 * db-inbound is deliberately excluded — by then the read is done and the pile-up
 * is over.
 */
const FALLING_THROUGH_PHASES: RequestPhase[] = [
  'cache-lookup',
  'cache-inbound',
  'db-outbound',
  'db-queued',
  'db-processing',
]

/**
 * How many concurrent misses on one key count as a stampede.
 *
 * Two requests overlapping on a cold key is ordinary; it happens on the first
 * read of any key. Three at once on the same key means the cache is not
 * absorbing the concurrency it exists to absorb.
 */
export const STAMPEDE_THRESHOLD = 3

/**
 * Keys this cache is currently being stampeded on, with the number of requests
 * piling onto each. Derived from live request state rather than recorded as an
 * event: a stampede is a moment, not a thing that happened.
 */
export function stampedingKeys(
  requests: InFlightRequest[],
  cacheId: string,
  threshold: number = STAMPEDE_THRESHOLD,
): { key: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const r of requests) {
    if (r.cacheNodeId !== cacheId) continue
    if (r.cacheOutcome !== 'miss') continue
    // cacheAction marks the populate/write side trip, which shares two of the
    // phases above but is the request going home, not piling on.
    if (r.cacheAction !== undefined) continue
    if (!FALLING_THROUGH_PHASES.includes(r.phase)) continue
    counts.set(r.resourceKey, (counts.get(r.resourceKey) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= threshold)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
}

/** The same census as a stable string, for a component selector. */
export const stampedeSignature = (
  requests: InFlightRequest[],
  cacheId: string,
) =>
  stampedingKeys(requests, cacheId)
    .map((s) => `${s.key}:${s.count}`)
    .join(',')

export const lbSettingsOf = (node: Node | undefined): LoadBalancerSettings => {
  const data = dataOf(node)
  return data?.componentType === 'loadbalancer'
    ? data.settings
    : DEFAULT_SETTINGS.loadbalancer
}

/**
 * Stable ordering for anything keyed off a node list. Sorting by the numeric
 * part of the id keeps round-robin deterministic even if React Flow reorders
 * the nodes array for z-index reasons.
 */
const byCreationOrder = (a: Node, b: Node) => {
  const na = Number(a.id.replace(/\D/g, ''))
  const nb = Number(b.id.replace(/\D/g, ''))
  if (Number.isNaN(na) || Number.isNaN(nb)) return a.id.localeCompare(b.id)
  return na - nb
}

/** Human-facing name, e.g. "Server (2)" — numbered within its own type. */
export function displayName(nodes: Node[], nodeId: string): string {
  const node = nodes.find((n) => n.id === nodeId)
  const type = dataOf(node)?.componentType
  if (!node || !type) return nodeId
  const sameType = nodes
    .filter((n) => dataOf(n)?.componentType === type)
    .sort(byCreationOrder)
  const label = COMPONENT_LABELS[type]
  const index = sameType.findIndex((n) => n.id === nodeId)
  return sameType.length > 1 ? `${label} (${index + 1})` : label
}

const COMPONENT_LABELS: Record<ComponentType, string> = {
  client: 'Client',
  loadbalancer: 'Load Balancer',
  server: 'Server',
  cache: 'Cache',
  database: 'Database',
}

/** Servers wired to a balancer, in stable order. */
export function backendsOf(
  nodes: Node[],
  edges: Edge[],
  lbId: string,
): { node: Node; edgeId: string }[] {
  const found: { node: Node; edgeId: string }[] = []
  for (const edge of edges) {
    const otherId =
      edge.source === lbId ? edge.target : edge.target === lbId ? edge.source : undefined
    if (otherId === undefined) continue
    const node = nodes.find((n) => n.id === otherId)
    if (dataOf(node)?.componentType !== 'server' || !node) continue
    if (!found.some((f) => f.node.id === node.id)) found.push({ node, edgeId: edge.id })
  }
  return found.sort((a, b) => byCreationOrder(a.node, b.node))
}

/**
 * Load as the balancer must see it: work at the server, work queued there, and
 * work already dispatched but still crossing the wire. Without that last term
 * a burst routed within one LB hop all sees an idle fleet and piles onto the
 * same backend. Deliberately separate from countServerActive, which gates
 * admission at the server and must keep its original meaning.
 */
export const countServerLoad = (
  requests: InFlightRequest[],
  serverId: string,
) =>
  countServerActive(requests, serverId) +
  countServerQueued(requests, serverId) +
  requests.filter(
    (r) => r.targetNodeId === serverId && r.phase === 'lb-to-server',
  ).length

export const databaseRoleOf = (node: Node | undefined): DatabaseRole =>
  dataOf(node)?.componentType === 'database'
    ? databaseSettingsOf(node).role
    : 'standalone'

/** The database on the other end of a database-to-database edge, if any. */
function pairedDatabase(
  nodes: Node[],
  edges: Edge[],
  nodeId: string,
  wantedRole: DatabaseRole,
): { node: Node; edgeId: string } | undefined {
  for (const edge of edges) {
    const otherId =
      edge.source === nodeId
        ? edge.target
        : edge.target === nodeId
          ? edge.source
          : undefined
    if (otherId === undefined) continue
    const other = nodes.find((n) => n.id === otherId)
    if (!other) continue
    if (dataOf(other)?.componentType !== 'database') continue
    if (databaseRoleOf(other) !== wantedRole) continue
    return { node: other, edgeId: edge.id }
  }
  return undefined
}

/**
 * The replica behind a primary. Returns the first one found: this phase
 * supports a single replica, but nothing here assumes it — swapping this for a
 * list is the whole change needed to fan out to several later.
 */
export const replicaOf = (nodes: Node[], edges: Edge[], primaryId: string) =>
  pairedDatabase(nodes, edges, primaryId, 'replica')

/** The primary a replica hangs off. Undefined means it is misconfigured. */
export const primaryOf = (nodes: Node[], edges: Edge[], replicaId: string) =>
  pairedDatabase(nodes, edges, replicaId, 'primary')

/** Replica reads are counted against the replica, not the primary. */
export const countReplicaActive = (
  requests: InFlightRequest[],
  replicaId: string,
) =>
  requests.filter(
    (r) => r.replicaNodeId === replicaId && r.phase === 'replica-processing',
  ).length

export const countReplicaQueued = (
  requests: InFlightRequest[],
  replicaId: string,
) =>
  requests.filter(
    (r) => r.replicaNodeId === replicaId && r.phase === 'replica-queued',
  ).length

/**
 * A read is stale when the primary has a newer write for that key than the
 * replica has seen. With no write on record there is nothing to lag behind, so
 * the read counts as fresh rather than stale-by-default.
 */
export function readFreshnessFor(
  primaryWrites: Record<string, KeyTimestamps>,
  replicaSyncs: Record<string, KeyTimestamps>,
  primaryId: string,
  replicaId: string,
  key: string,
): ReadFreshness {
  const lastWritten = primaryWrites[primaryId]?.[key]
  if (lastWritten === undefined) return 'fresh'
  const lastSynced = replicaSyncs[replicaId]?.[key]
  return lastSynced !== undefined && lastSynced >= lastWritten ? 'fresh' : 'stale'
}

/** True when a node has been manually switched off. */
export const isNodeKilled = (node: Node | undefined): boolean =>
  Boolean(dataOf(node)?.isKilled)

/** A server is unhealthy when it is both at capacity and out of queue room. */
export const isServerRejecting = (
  requests: InFlightRequest[],
  server: Node,
): boolean => {
  const settings = serverSettingsOf(server)
  return (
    countServerActive(requests, server.id) >= settings.concurrencyLimit &&
    countServerQueued(requests, server.id) >= settings.maxQueueDepth
  )
}

/**
 * Why a node turned a request away. Now that queues are opt-in, "the queue was
 * full" is only half the story — most rejections happen at a node that has no
 * queue at all, and saying which case it was points straight at the fix.
 */
export const atCapacityDetail = (
  concurrencyLimit: number,
  maxQueueDepth: number,
): string =>
  maxQueueDepth === 0
    ? `all ${concurrencyLimit} workers busy, no queue configured`
    : `all ${concurrencyLimit} workers busy, all ${maxQueueDepth} queue slots taken`

/** What a load balancer's health check considers unroutable. */
export const isBackendUnhealthy = (
  requests: InFlightRequest[],
  server: Node,
): boolean => isNodeKilled(server) || isServerRejecting(requests, server)

/**
 * The key hot traffic piles onto. The first key in the pool by convention, so
 * skew needs one number rather than a number and a key picker.
 */
export const HOT_KEY = 'resource-1'

/**
 * Picks one key from the client's pool, e.g. resource-1 .. resource-3.
 *
 * With no hot-key share this is the original uniform draw, reached before any
 * new arithmetic runs: an unset or zero `hotKeyPercent` must select keys
 * exactly as it did before hot keys existed, including consuming the same
 * single Math.random() call.
 *
 * Above zero, the remaining traffic is drawn from the pool MINUS the hot key.
 * Leaving the hot key in that draw would push its real share above the
 * configured number — at 75% of 10 keys it would land at 77.5% — and the point
 * of the setting is that the share you ask for is the share you get.
 */
export const pickResourceKey = (count: number, hotKeyPercent = 0) => {
  const pool = Math.max(1, count)
  if (hotKeyPercent <= 0) return `resource-${1 + Math.floor(Math.random() * pool)}`
  // A one-key pool is entirely hot key; there is no "rest" to spread.
  if (pool === 1 || Math.random() * 100 < hotKeyPercent) return HOT_KEY
  // resource-2 .. resource-<pool>: uniform over everything but the hot key.
  return `resource-${2 + Math.floor(Math.random() * (pool - 1))}`
}

/** Picks GET or POST from the client's configured mix. */
export const pickMethod = (getPercent: number): RequestMethod =>
  Math.random() * 100 < getPercent ? 'GET' : 'POST'

const databaseSettingsOf = (node: Node | undefined): DatabaseSettings => {
  const data = dataOf(node)
  return data?.componentType === 'database'
    ? data.settings
    : DEFAULT_SETTINGS.database
}

const clientSettingsOf = (node: Node | undefined): ClientSettings => {
  const data = dataOf(node)
  return data?.componentType === 'client' ? data.settings : DEFAULT_SETTINGS.client
}

function bumpDbStat(
  stats: Record<string, DbStats>,
  dbId: string,
  key: keyof DbStats,
): Record<string, DbStats> {
  const current = stats[dbId] ?? EMPTY_DB_STATS
  return { ...stats, [dbId]: { ...current, [key]: current[key] + 1 } }
}

function bumpStat(
  stats: Record<string, ClientStats>,
  clientId: string,
  key: keyof ClientStats,
): Record<string, ClientStats> {
  const current = stats[clientId] ?? EMPTY_STATS
  return { ...stats, [clientId]: { ...current, [key]: current[key] + 1 } }
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

type FlowState = {
  nodes: Node[]
  edges: Edge[]
  requests: InFlightRequest[]
  clientStats: Record<string, ClientStats>
  dbStats: Record<string, DbStats>
  /** Cache contents, keyed by cache node id then resource key. */
  cacheContents: Record<string, CacheContents>
  cacheStats: Record<string, CacheStats>
  lbStats: Record<string, LbStats>
  serverStats: Record<string, ServerStats>
  /** Primary node id -> key -> lastWrittenAt. */
  primaryWrites: Record<string, KeyTimestamps>
  /** Replica node id -> key -> lastSyncedAt. */
  replicaSyncs: Record<string, KeyTimestamps>
  replicaStats: Record<string, ReplicaStats>
  /** Rotating cursor per balancer, for round robin. */
  lbRoundRobin: Record<string, number>
  /** Write-back flushes not yet durable, keyed by cache node id. */
  pendingSyncs: Record<string, number>
  /**
   * Running census of deferred writes. Kept in the store rather than derived
   * from `logs`, which holds only the most recent LOG_CAP entries — durability
   * is a claim about every acknowledged write, not about a sample of them.
   */
  writeDurability: WriteDurability
  notices: Record<string, string | undefined>
  /** Node whose settings panel is open, or null when the panel is closed. */
  selectedNodeId: string | null

  /** Id of the Problem currently loaded, or null for free play. */
  activeProblemId: string | null
  isBriefOpen: boolean
  isDevToolsOpen: boolean
  isSidebarOpen: boolean
  /** Bumped whenever the canvas is replaced wholesale, so the view can refit. */
  canvasVersion: number

  /** Newest-first, capped at LOG_CAP entries. The log viewer's buffer. */
  logs: LogEntry[]
  /** Oldest-first, whole session. What the metric panels actually measure. */
  metrics: MetricSample[]
  /** Manual kill/revive toggles, newest last. */
  nodeEvents: NodeToggleEvent[]
  /** Recorded baselines, keyed by problem id. */
  baselines: Record<string, BaselineMetrics>
  isLogOpen: boolean
  isHealthOpen: boolean
  isLatencyOpen: boolean

  /** Continuous firing mode. */
  isAutoFiring: boolean
  requestsPerSecond: number
  /** Auto-stop after this many seconds. 0 means run until stopped by hand. */
  runDurationSeconds: number
  /** When the current run began, for the elapsed readout. */
  autoFireStartedAt: number | null
  /** Session total of requests actually created, manual and auto alike. */
  totalFired: number

  onNodesChange: (changes: NodeChange[]) => void
  onEdgesChange: (changes: EdgeChange[]) => void
  onConnect: (connection: Connection) => void
  addNode: (type: ComponentType, position: XYPosition) => void

  logEvent: (requestId: string, hop: LogEventName, detail?: string) => void
  clearLogs: () => void
  setLogOpen: (open: boolean) => void
  setHealthOpen: (open: boolean) => void
  setLatencyOpen: (open: boolean) => void

  /** Replaces canvas and history wholesale, e.g. from localStorage. */
  hydrate: (payload: {
    nodes?: Node[]
    edges?: Edge[]
    logs?: LogEntry[]
    metrics?: MetricSample[]
    baselines?: Record<string, BaselineMetrics>
    clientStats?: Record<string, ClientStats>
    dbStats?: Record<string, DbStats>
    cacheStats?: Record<string, CacheStats>
    lbStats?: Record<string, LbStats>
    serverStats?: Record<string, ServerStats>
    totalFired?: number
    activeProblemId?: string | null
  }) => void
  /** Wipes canvas, history and counters, and stops auto-fire. */
  clearAll: () => void
  /** Clear-all, then drop a Problem's starting diagram in its place. */
  loadProblem: (problem: { id: string; nodes: Node[]; edges: Edge[] }) => void
  setBriefOpen: (open: boolean) => void
  setDevToolsOpen: (open: boolean) => void
  setSidebarOpen: (open: boolean) => void
  /** Removes a node together with every edge attached to it. */
  deleteNode: (nodeId: string) => void
  deleteEdge: (edgeId: string) => void
  /** Replaces the canvas from a pasted setup, same reset as loading a problem. */
  loadSetup: (nodes: Node[], edges: Edge[]) => void

  setAutoFiring: (on: boolean) => void
  setRequestsPerSecond: (rps: number) => void
  setRunDuration: (seconds: number) => void
  resetCounters: () => void

  selectNode: (nodeId: string | null) => void
  /** Merges a patch into one node's data.settings (two-way binding target). */
  updateNodeSettings: (nodeId: string, patch: SettingsPatch) => void

  /** Kicks off one GET from the given client toward its connected server. */
  fireRequest: (clientId: string) => void

  // Lifecycle steps — exported on the store so each timer callback re-reads
  // the latest state rather than closing over a stale snapshot.
  arriveAtLoadBalancer: (requestId: string) => void
  routeFromLoadBalancer: (requestId: string) => void
  arriveBackAtLoadBalancer: (requestId: string) => void
  startResponseHome: (requestId: string) => void
  arriveAtServer: (requestId: string) => void
  beginProcessing: (requestId: string) => void
  finishProcessing: (requestId: string) => void
  startCacheLookupLeg: (requestId: string) => void
  arriveAtCache: (requestId: string) => void
  finishCacheLookup: (requestId: string) => void
  arriveBackFromCache: (requestId: string) => void
  startCacheUpdateLeg: (
    requestId: string,
    action: 'populate' | 'write' | 'invalidate',
  ) => void
  applyCacheUpdate: (requestId: string) => void
  startDbLeg: (requestId: string) => void
  arriveAtDatabase: (requestId: string) => void
  startReplicaLeg: (requestId: string) => void
  arriveAtReplica: (requestId: string) => void
  beginReplicaWork: (requestId: string) => void
  finishReplicaWork: (requestId: string) => void
  arriveBackAtPrimary: (requestId: string) => void
  admitFromReplicaQueue: (replicaId: string) => void
  replicateWrite: (
    originRequestId: string,
    primaryId: string,
    resourceKey: string,
  ) => void
  beginDbWork: (requestId: string) => void
  finishDbWork: (requestId: string) => void
  arriveBackAtServer: (requestId: string) => void
  scheduleWriteBackFlush: (requestId: string) => void
  syncArriveAtDatabase: (syncId: string) => void
  beginSyncWrite: (syncId: string) => void
  /** Give up on a deferred write: acknowledged to the client, never stored. */
  loseSync: (syncId: string, reason: string) => void
  finishSync: (syncId: string) => void
  startInboundLeg: (requestId: string) => void
  completeRequest: (requestId: string) => void
  rejectRequest: (
    requestId: string,
    atNodeId: string,
    reason: FailureReason,
    detail?: string,
  ) => void
  /** Fails a request that has been sitting in a queue for too long. */
  timeoutRequest: (requestId: string) => void
  /** Flips a node between online and offline. */
  toggleNodeKilled: (nodeId: string) => void
  recordBaseline: (problemId: string, baseline: BaselineMetrics) => void
  clearBaseline: (problemId: string) => void
  removeRequest: (requestId: string) => void
  admitFromServerQueue: (serverId: string) => void
  admitFromDbQueue: (dbId: string) => void
  pruneRequests: () => void
}

export const useFlowStore = create<FlowState>((set, get) => ({
  nodes: [],
  edges: [],
  requests: [],
  clientStats: {},
  dbStats: {},
  cacheContents: {},
  cacheStats: {},
  lbStats: {},
  serverStats: {},
  primaryWrites: {},
  replicaSyncs: {},
  replicaStats: {},
  lbRoundRobin: {},
  pendingSyncs: {},
  writeDurability: EMPTY_DURABILITY,
  notices: {},
  selectedNodeId: null,
  activeProblemId: null,
  isBriefOpen: false,
  isDevToolsOpen: false,
  // Collapsed by default where there is no room for it, which is the case
  // that made this toggle necessary in the first place.
  isSidebarOpen: typeof window === 'undefined' ? true : window.innerWidth >= 768,
  canvasVersion: 0,
  logs: [],
  metrics: [],
  nodeEvents: [],
  baselines: {},
  isLogOpen: false,
  isHealthOpen: false,
  isLatencyOpen: false,
  isAutoFiring: false,
  requestsPerSecond: 2,
  runDurationSeconds: 0,
  autoFireStartedAt: null,
  totalFired: 0,

  onNodesChange: (changes) => {
    const nodes = applyNodeChanges(changes, get().nodes)
    const { selectedNodeId } = get()
    set({
      nodes,
      // Close the panel if the node it describes was just deleted.
      selectedNodeId:
        selectedNodeId && nodes.some((n) => n.id === selectedNodeId)
          ? selectedNodeId
          : null,
    })
    get().pruneRequests()
  },

  onEdgesChange: (changes) => {
    set({ edges: applyEdgeChanges(changes, get().edges) })
    get().pruneRequests()
  },

  onConnect: (connection) => {
    const nodes = get().nodes
    set({ edges: addEdge({ ...connection, ...EDGE_DEFAULTS }, get().edges) })
    track('connection_created', {
      sourceComponentType: dataOf(
        nodes.find((node) => node.id === connection.source),
      )?.componentType,
      targetComponentType: dataOf(
        nodes.find((node) => node.id === connection.target),
      )?.componentType,
    })
  },

  addNode: (type, position) => {
    const node: SystemNode = {
      id: nextNodeId(),
      type: 'systemNode',
      position,
      data: {
        componentType: type,
        label: type,
        // structuredClone so nested defaults (requestMix) are not shared
        // between every node of the same type.
        settings: structuredClone(DEFAULT_SETTINGS[type]),
      } as SystemNodeData,
    }
    set({ nodes: [...get().nodes, node] })
    track('node_added', { componentType: type })
  },

  logEvent: (requestId, hop, detail) => {
    set((state) => ({ logs: withLogEvent(state.logs, requestId, hop, detail) }))
  },

  recordBaseline: (problemId, baseline) => {
    set({ baselines: { ...get().baselines, [problemId]: baseline } })
  },

  clearBaseline: (problemId) => {
    const next = { ...get().baselines }
    delete next[problemId]
    set({ baselines: next })
  },

  clearLogs: () => {
    // Clears the measurement history too, so the Health and Latency panels
    // drop to their empty states alongside the log they sit under.
    set({ logs: [], metrics: [], nodeEvents: [] })
  },

  // Independent: the three metric panels stack, so you can watch the log, the
  // health chart and the percentiles at the same time.
  setLogOpen: (open) => {
    set({ isLogOpen: open })
  },

  setHealthOpen: (open) => {
    set({ isHealthOpen: open })
  },

  setLatencyOpen: (open) => {
    set({ isLatencyOpen: open })
  },

  hydrate: (payload) => {
    const nodes = payload.nodes ?? []
    // Node ids are handed out from a module counter; without advancing it past
    // whatever was restored, the next added node would reuse an existing id.
    for (const node of nodes) {
      const numeric = Number(node.id.replace(/\D/g, ''))
      if (!Number.isNaN(numeric)) nodeCounter = Math.max(nodeCounter, numeric)
    }

    set({
      nodes,
      edges: payload.edges ?? [],
      // Requests never survive a reload: their timers are gone.
      requests: [],
      logs: payload.logs ?? [],
      metrics: payload.metrics ?? [],
      baselines: payload.baselines ?? {},
      nodeEvents: [],
      clientStats: payload.clientStats ?? {},
      dbStats: payload.dbStats ?? {},
      cacheStats: payload.cacheStats ?? {},
      lbStats: payload.lbStats ?? {},
      serverStats: payload.serverStats ?? {},
      totalFired: payload.totalFired ?? 0,
      canvasVersion: get().canvasVersion + 1,
      activeProblemId: payload.activeProblemId ?? null,
      // A cache is volatile by nature; it comes back cold, like a restart.
      cacheContents: {},
      pendingSyncs: {},
      writeDurability: EMPTY_DURABILITY,
      notices: {},
      selectedNodeId: null,
      isAutoFiring: false,
    })
  },

  loadProblem: (problem) => {
    clearAllTimers()
    // structuredClone so editing a loaded node never mutates the Problem
    // constant and leaks into the next load.
    const nodes = structuredClone(problem.nodes)
    const edges = structuredClone(problem.edges)
    for (const node of nodes) {
      const numeric = Number(node.id.replace(/\D/g, ''))
      if (!Number.isNaN(numeric)) nodeCounter = Math.max(nodeCounter, numeric)
    }
    set({
      nodes,
      edges,
      requests: [],
      logs: [],
      metrics: [],
      nodeEvents: [],
      baselines: {},
      clientStats: {},
      dbStats: {},
      cacheStats: {},
      lbStats: {},
      serverStats: {},
      primaryWrites: {},
      replicaSyncs: {},
      replicaStats: {},
      lbRoundRobin: {},
      cacheContents: {},
      pendingSyncs: {},
      writeDurability: EMPTY_DURABILITY,
      notices: {},
      selectedNodeId: null,
      totalFired: 0,
      isAutoFiring: false,
      autoFireStartedAt: null,
      canvasVersion: get().canvasVersion + 1,
      activeProblemId: problem.id,
      // The brief is a multi-minute reference, so it opens and stays open.
      isBriefOpen: true,
    })
  },

  setBriefOpen: (open) => {
    set({ isBriefOpen: open })
  },

  setDevToolsOpen: (open) => {
    set({ isDevToolsOpen: open })
  },

  setSidebarOpen: (open) => {
    set({ isSidebarOpen: open })
  },

  deleteNode: (nodeId) => {
    const state = get()
    const node = state.nodes.find((item) => item.id === nodeId)
    set({
      nodes: state.nodes.filter((n) => n.id !== nodeId),
      // An edge to a node that no longer exists would strand any request
      // routed along it, so they go together.
      edges: state.edges.filter(
        (e) => e.source !== nodeId && e.target !== nodeId,
      ),
      selectedNodeId: state.selectedNodeId === nodeId ? null : state.selectedNodeId,
    })
    get().pruneRequests()
    if (node) track('node_deleted', { componentType: dataOf(node)!.componentType })
  },

  deleteEdge: (edgeId) => {
    set({ edges: get().edges.filter((e) => e.id !== edgeId) })
    get().pruneRequests()
  },

  loadSetup: (nodes, edges) => {
    // Deliberately routed through loadProblem's reset so an imported setup and
    // a loaded preset leave the app in exactly the same state.
    get().loadProblem({ id: '', nodes, edges })
    set({ activeProblemId: null, isBriefOpen: false })
  },

  clearAll: () => {
    clearAllTimers()
    set({
      nodes: [],
      edges: [],
      requests: [],
      logs: [],
      metrics: [],
      nodeEvents: [],
      baselines: {},
      clientStats: {},
      dbStats: {},
      cacheStats: {},
      lbStats: {},
      serverStats: {},
      primaryWrites: {},
      replicaSyncs: {},
      replicaStats: {},
      lbRoundRobin: {},
      cacheContents: {},
      pendingSyncs: {},
      writeDurability: EMPTY_DURABILITY,
      notices: {},
      selectedNodeId: null,
      totalFired: 0,
      // Never leave auto-fire running into an empty canvas.
      isAutoFiring: false,
      autoFireStartedAt: null,
      activeProblemId: null,
      isBriefOpen: false,
    })
  },

  setAutoFiring: (on) => {
    // Only a stopped-to-running transition is a started run; the auto-stop and
    // every reset call this too.
    const starting = on && !get().isAutoFiring
    // Stamping the start here means the readout measures the actual run, not
    // whenever a component happened to mount.
    set({ isAutoFiring: on, autoFireStartedAt: on ? Date.now() : null })
    if (starting) {
      track('simulation_started', {
        mode: 'auto_fire',
        rps: get().requestsPerSecond,
      })
    }
  },

  setRunDuration: (seconds) => {
    set({ runDurationSeconds: Math.max(0, seconds) })
  },

  setRequestsPerSecond: (rps) => {
    set({ requestsPerSecond: Math.min(MAX_RPS, Math.max(MIN_RPS, rps)) })
  },

  /**
   * Clears the tallies only. In-flight requests and cache contents are left
   * alone, so pressing this mid-run does not disturb the simulation — it just
   * rebases the numbers you are reading.
   */
  resetCounters: () => {
    // The durability census resets with everything else. Leaving it behind
    // meant losses from a baseline run were still counted against the redesign
    // that fixed them, so a correct answer graded as a failure.
    //
    // Flushes already in the air are deliberately left to finish rather than
    // dropped, since they carry real cache-dirty state. One that lands after
    // this point is counted against the new run; it resolves within a couple of
    // seconds, and only a design that was already losing writes can be affected.
    set({
      totalFired: 0,
      clientStats: {},
      dbStats: {},
      cacheStats: {},
      lbStats: {},
      serverStats: {},
      replicaStats: {},
      metrics: [],
      writeDurability: EMPTY_DURABILITY,
    })
  },

  selectNode: (nodeId) => {
    set({ selectedNodeId: nodeId })
  },

  updateNodeSettings: (nodeId, patch) => {
    set({
      nodes: get().nodes.map((node) => {
        if (node.id !== nodeId) return node
        const data = node.data as SystemNodeData
        // New node and data objects so React Flow re-renders the card, and the
        // simulation picks the values up on its next read.
        return {
          ...node,
          data: { ...data, settings: { ...data.settings, ...patch } },
        }
      }),
    })
  },

  fireRequest: (clientId) => {
    const { nodes, edges } = get()
    const client = nodes.find((n) => n.id === clientId)
    if (!client) return

    const notify = (message: string) => {
      set({ notices: { ...get().notices, [clientId]: message } })
      const existing = noticeTimers.get(clientId)
      if (existing !== undefined) clearTimeout(existing)
      noticeTimers.set(
        clientId,
        setTimeout(() => {
          noticeTimers.delete(clientId)
          set({ notices: { ...get().notices, [clientId]: undefined } })
        }, NOTICE_MS),
      )
    }

    // Edges are accepted in either direction throughout: with loose handles a
    // user may well draw server -> client, and silently doing nothing would be
    // baffling.
    const neighbourVia = (edge: Edge, nodeId: string) =>
      edge.source === nodeId
        ? edge.target
        : edge.target === nodeId
          ? edge.source
          : undefined

    // The client routes nothing: it simply sends to whatever it is wired to.
    // A balancer in front is the only thing that changes the journey.
    const frontLink = edges.find((edge) => {
      const otherId = neighbourVia(edge, clientId)
      if (otherId === undefined) return false
      const type = dataOf(nodes.find((n) => n.id === otherId))?.componentType
      return type === 'server' || type === 'loadbalancer'
    })

    if (!frontLink) {
      notify('Connect a Server first')
      return
    }

    const frontId =
      frontLink.source === clientId ? frontLink.target : frontLink.source
    const frontType = dataOf(nodes.find((n) => n.id === frontId))?.componentType
    const viaLb = frontType === 'loadbalancer'

    if (viaLb && backendsOf(nodes, edges, frontId).length === 0) {
      notify('Connect a Server to the Load Balancer')
      return
    }

    // With a balancer, the server is unknown until it routes; borrow the
    // network latency of its first backend for the client <-> LB legs, since
    // that leg is a property of the network rather than of any one backend.
    const serverId = viaLb
      ? backendsOf(nodes, edges, frontId)[0].node.id
      : frontId

    const linkFromServerTo = (kind: ComponentType) =>
      edges.find((edge) => {
        const otherId = neighbourVia(edge, serverId)
        if (otherId === undefined) return false
        return dataOf(nodes.find((n) => n.id === otherId))?.componentType === kind
      })

    const dbLink = linkFromServerTo('database')
    const cacheLink = linkFromServerTo('cache')
    const cacheNodeId = cacheLink
      ? cacheLink.source === serverId
        ? cacheLink.target
        : cacheLink.source
      : undefined
    const databaseNodeId = dbLink
      ? dbLink.source === serverId
        ? dbLink.target
        : dbLink.source
      : undefined

    const clientSettings = clientSettingsOf(client)
    const method = pickMethod(clientSettings.requestMix.getPercent)
    const resourceKey = pickResourceKey(
      clientSettings.resourceKeyCount,
      clientSettings.hotKeyPercent,
    )
    const isHotKey =
      (clientSettings.hotKeyPercent ?? 0) > 0 && resourceKey === HOT_KEY

    // A POST with nowhere to persist is refused outright rather than quietly
    // faked. Chosen over a server-only fallback because it reuses the existing
    // notice mechanism and leaves no misleading "success" in the counters.
    if (method === 'POST' && !databaseNodeId) {
      notify('Connect a Database to send POST requests')
      return
    }

    // The client <-> front-door leg is a property of the node the client is
    // actually connected to — a balancer when there is one, otherwise the
    // server. It must never be read off a backend the client cannot see.
    const frontDoorNode = nodes.find((n) => n.id === frontId)
    const frontDoorLatencyMs = viaLb
      ? lbSettingsOf(frontDoorNode).networkLatencyMs
      : serverSettingsOf(frontDoorNode).networkLatencyMs

    const cachePolicy = cacheNodeId
      ? cacheSettingsOf(nodes.find((n) => n.id === cacheNodeId)).writePolicy
      : undefined

    const taken = new Set([
      ...get().requests.map((r) => r.id),
      ...get().logs.map((l) => l.requestId),
    ])

    const request: InFlightRequest = {
      id: nextRequestId(taken),
      sourceNodeId: clientId,
      // Left empty until the balancer picks a backend.
      targetNodeId: viaLb ? '' : serverId,
      loadBalancerNodeId: viaLb ? frontId : undefined,
      routedVia: viaLb ? 'load_balancer' : 'direct',
      databaseNodeId,
      clientEdgeId: frontLink.id,
      dbEdgeId: dbLink?.id,
      cacheNodeId,
      cacheEdgeId: cacheLink?.id,
      currentEdgeId: frontLink.id,
      legFromNodeId: clientId,
      legToNodeId: frontId,
      phase: viaLb ? 'lb-outbound' : 'outbound',
      method,
      resourceKey,
      isHotKey,
      kind: 'request',
      legDurationMs: frontDoorLatencyMs,
    }

    const now = Date.now()
    const entry: LogEntry = {
      requestId: request.id,
      method,
      resourceKey,
      startedAt: now,
      finishedAt: null,
      totalDurationMs: null,
      outcome: 'in_progress',
      failureReason: null,
      // A cache result only means something for reads that can consult a
      // cache. Writes are tracked through writePolicyApplied instead.
      cacheResult:
        cacheNodeId === undefined || method === 'POST' ? 'not_applicable' : null,
      // Set when a replica actually serves the read; otherwise resolved to
      // 'not_applicable' the moment the request finishes.
      readFreshness: null,
      writePolicyApplied:
        cacheNodeId !== undefined && method === 'POST'
          ? (cachePolicy ?? null)
          : null,
      pendingSync: false,
      routedVia: viaLb ? 'load_balancer' : 'direct',
      loadBalancerNodeId: viaLb ? frontId : null,
      loadBalancerLabel: viaLb ? displayName(nodes, frontId) : null,
      servedByNodeId: viaLb ? null : serverId,
      events: [
        {
          ts: now,
          hop: 'request_created',
          detail: `${method} ${resourceKey}${isHotKey ? ' (hot key)' : ''}`,
        },
        {
          ts: now,
          hop: 'outbound_start',
          detail: viaLb ? 'client -> load balancer' : 'client -> server',
        },
      ],
    }

    set((state) => ({
      requests: [...state.requests, request],
      clientStats: bumpStat(state.clientStats, clientId, 'sent'),
      // Counted here rather than at the call site, so manual clicks and
      // auto-fire ticks are tallied identically and refused fires are excluded.
      totalFired: state.totalFired + 1,
      logs: [entry, ...state.logs].slice(0, LOG_CAP),
    }))

    scheduleFor(request.id, frontDoorLatencyMs, () =>
      viaLb
        ? get().arriveAtLoadBalancer(request.id)
        : get().arriveAtServer(request.id),
    )
  },

  /** The balancer pauses for its own transit cost before deciding. */
  arriveAtLoadBalancer: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request || !request.loadBalancerNodeId) return

    const settings = lbSettingsOf(
      state.nodes.find((n) => n.id === request.loadBalancerNodeId),
    )

    // Without this the client -> balancer network leg is invisible: the next
    // logged event is the routing decision, which lands transitLatencyMs later.
    get().logEvent(
      requestId,
      'lb_received',
      `deciding for ${settings.transitLatencyMs}ms`,
    )

    set({
      requests: state.requests.map((r) =>
        r.id === requestId
          ? {
              ...r,
              phase: 'lb-processing' as const,
              legDurationMs: settings.transitLatencyMs,
            }
          : r,
      ),
    })

    scheduleFor(requestId, settings.transitLatencyMs, () =>
      get().routeFromLoadBalancer(requestId),
    )
  },

  routeFromLoadBalancer: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request || !request.loadBalancerNodeId) return

    const lbId = request.loadBalancerNodeId
    const settings = lbSettingsOf(state.nodes.find((n) => n.id === lbId))
    const backends = backendsOf(state.nodes, state.edges, lbId)

    if (backends.length === 0) {
      get().rejectRequest(requestId, lbId, 'no_backend_available')
      return
    }

    // Health check first: prefer backends that are not already turning
    // requests away. If every one is full we fall through to normal routing,
    // so the request fails at a server rather than at the balancer.
    const healthy = settings.healthCheckEnabled
      ? backends.filter((b) => !isBackendUnhealthy(state.requests, b.node))
      : backends
    const skipped =
      settings.healthCheckEnabled && healthy.length > 0 && healthy.length < backends.length
        ? backends.filter((b) => !healthy.some((h) => h.node.id === b.node.id))
        : []
    const pool = healthy.length > 0 ? healthy : backends

    const cursor = state.lbRoundRobin[lbId] ?? 0

    /**
     * Both ordered algorithms rotate over the FULL backend ring rather than
     * over whatever subset is eligible this time. Rotating over a subset whose
     * membership changes between decisions is not a rotation: it silently
     * starves whichever backend is excluded most often.
     */
    const pickFromRing = (eligible: (poolIndex: number) => boolean) => {
      for (let i = 0; i < backends.length; i += 1) {
        const ring = (cursor + i) % backends.length
        const poolIndex = pool.findIndex(
          (p) => p.node.id === backends[ring].node.id,
        )
        if (poolIndex >= 0 && eligible(poolIndex)) return { poolIndex, ring }
      }
      return null
    }

    let index: number
    let cursorUpdate: Record<string, number> | undefined

    if (settings.routingAlgorithm === 'random') {
      index = Math.floor(Math.random() * pool.length)
    } else {
      let eligible: (poolIndex: number) => boolean
      if (settings.routingAlgorithm === 'least_connections') {
        const loads = pool.map((b) => countServerLoad(state.requests, b.node.id))
        const minLoad = Math.min(...loads)
        // Ties are the common case on a quiet fleet; the ring walk decides
        // them, so an idle fleet is shared instead of hammering one backend.
        eligible = (poolIndex) => loads[poolIndex] === minLoad
      } else {
        eligible = () => true
      }

      const picked = pickFromRing(eligible) ?? { poolIndex: 0, ring: cursor % backends.length }
      index = picked.poolIndex
      // Advance past whoever was picked so the next decision starts after it.
      cursorUpdate = {
        ...state.lbRoundRobin,
        [lbId]: (picked.ring + 1) % backends.length,
      }
    }

    const chosen = pool[index]
    const chosenName = displayName(state.nodes, chosen.node.id)

    // Downstreams belong to the backend that was actually chosen, not to
    // whichever one happened to be first when the request was created.
    const downstreamOf = (kind: ComponentType) => {
      const edge = state.edges.find((e) => {
        const otherId =
          e.source === chosen.node.id
            ? e.target
            : e.target === chosen.node.id
              ? e.source
              : undefined
        if (otherId === undefined) return false
        return (
          dataOf(state.nodes.find((n) => n.id === otherId))?.componentType === kind
        )
      })
      if (!edge) return { nodeId: undefined, edgeId: undefined }
      return {
        nodeId: edge.source === chosen.node.id ? edge.target : edge.source,
        edgeId: edge.id,
      }
    }
    const db = downstreamOf('database')
    const cache = downstreamOf('cache')
    const detail =
      skipped.length > 0
        ? `${settings.routingAlgorithm} -> ${chosenName} (skipped ${skipped
            .map(
              (b) =>
                `${displayName(state.nodes, b.node.id)} [${
                  isNodeKilled(b.node) ? 'offline' : 'full'
                }]`,
            )
            .join(', ')})`
        : `${settings.routingAlgorithm} -> ${chosenName}`

    const lbStat = state.lbStats[lbId] ?? { routed: 0 }

    set({
      requests: state.requests.map((r) =>
        r.id === requestId
          ? {
              ...r,
              targetNodeId: chosen.node.id,
              lbServerEdgeId: chosen.edgeId,
              databaseNodeId: db.nodeId,
              dbEdgeId: db.edgeId,
              cacheNodeId: cache.nodeId,
              cacheEdgeId: cache.edgeId,
              phase: 'lb-to-server' as const,
              currentEdgeId: chosen.edgeId,
              legFromNodeId: lbId,
              legToNodeId: chosen.node.id,
              legDurationMs: LB_HOP_MS,
            }
          : r,
      ),
      lbStats: { ...state.lbStats, [lbId]: { routed: lbStat.routed + 1 } },
      ...(cursorUpdate ? { lbRoundRobin: cursorUpdate } : {}),
      logs: withLogEntry(
        withLogEvent(state.logs, requestId, 'lb_routing_decision', detail),
        requestId,
        (entry) => ({ ...entry, servedByNodeId: chosen.node.id }),
      ),
    })

    scheduleFor(requestId, LB_HOP_MS, () => get().arriveAtServer(requestId))
  },

  /** Response leaving the server travels back through the balancer. */
  arriveBackAtLoadBalancer: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request || !request.loadBalancerNodeId) return

    // Symmetric with the outbound leg: the balancer's own network latency,
    // never the handling server's.
    const lbLatencyMs = lbSettingsOf(
      state.nodes.find((n) => n.id === request.loadBalancerNodeId),
    ).networkLatencyMs

    set({
      requests: state.requests.map((r) =>
        r.id === requestId
          ? {
              ...r,
              phase: 'lb-inbound' as const,
              currentEdgeId: r.clientEdgeId,
              legFromNodeId: request.loadBalancerNodeId!,
              legToNodeId: r.sourceNodeId,
              legDurationMs: lbLatencyMs,
            }
          : r,
      ),
    })

    get().logEvent(
      requestId,
      'inbound_start',
      `load balancer -> client, ${lbLatencyMs}ms`,
    )
    scheduleFor(requestId, lbLatencyMs, () =>
      get().completeRequest(requestId),
    )
  },

  arriveAtServer: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request) return

    const server = state.nodes.find((n) => n.id === request.targetNodeId)
    if (!server) {
      get().removeRequest(requestId)
      return
    }

    // Offline short-circuits everything: this is not a capacity problem, so
    // concurrency and queue depth are never consulted.
    if (isNodeKilled(server)) {
      get().rejectRequest(
        requestId,
        request.targetNodeId,
        'node_offline',
        'Server is offline',
      )
      return
    }

    const settings = serverSettingsOf(server)
    const active = countServerActive(state.requests, request.targetNodeId)
    const queued = countServerQueued(state.requests, request.targetNodeId)

    set((current) => ({
      serverStats: {
        ...current.serverStats,
        [request.targetNodeId]: {
          served: (current.serverStats[request.targetNodeId]?.served ?? 0) + 1,
        },
      },
    }))
    get().logEvent(requestId, 'server_received')

    if (active < settings.concurrencyLimit) {
      get().beginProcessing(requestId)
    } else if (queued < settings.maxQueueDepth) {
      set({
        requests: state.requests.map((r) =>
          r.id === requestId
            ? { ...r, phase: 'queued' as const, queuedAt: Date.now() }
            : r,
        ),
      })
      get().logEvent(
        requestId,
        'server_queued',
        `${queued + 1} waiting, times out in ${settings.timeoutMs}ms`,
      )
      // scheduleFor replaces a request's pending timer, so being promoted into
      // processing cancels this automatically — no separate bookkeeping.
      armTimerFor(requestId, settings.timeoutMs, () =>
        get().timeoutRequest(requestId),
      )
    } else {
      get().rejectRequest(
        requestId,
        request.targetNodeId,
        'server_queue_full',
        atCapacityDetail(settings.concurrencyLimit, settings.maxQueueDepth),
      )
    }
  },

  beginProcessing: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request) return
    chargeQueueWait(request)

    const settings = serverSettingsOf(
      state.nodes.find((n) => n.id === request.targetNodeId),
    )

    set({
      requests: state.requests.map((r) =>
        r.id === requestId
          ? {
              ...r,
              phase: 'processing' as const,
              // Kept in step with the phase even though nothing draws it: a
              // server that is thinking shows a busy ring rather than a
              // travelling dot. Leaving it stale meant the field silently
              // described the *previous* leg, which is a trap for anyone who
              // later renders this phase — and every other working phase
              // (cache-lookup, db-processing, cache-writing) already sets it.
              legDurationMs: settings.baseProcessingMs,
            }
          : r,
      ),
    })

    get().logEvent(
      requestId,
      'server_processing_start',
      `${settings.baseProcessingMs}ms`,
    )
    scheduleFor(requestId, settings.baseProcessingMs, () =>
      get().finishProcessing(requestId),
    )
  },

  finishProcessing: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request) return

    get().logEvent(requestId, 'server_processing_end')

    const hasCache =
      request.cacheNodeId !== undefined &&
      state.nodes.some((n) => n.id === request.cacheNodeId) &&
      state.edges.some((e) => e.id === request.cacheEdgeId)

    // A GET always asks the cache first when one is wired up.
    if (hasCache && request.method === 'GET') {
      get().startCacheLookupLeg(requestId)
      return
    }

    // A POST branches on the cache's write policy.
    if (hasCache && request.method === 'POST') {
      const policy = cacheSettingsOf(
        state.nodes.find((n) => n.id === request.cacheNodeId),
      ).writePolicy

      // Write-back answers from the cache and lets the database catch up later,
      // so the cache write is the only thing on the critical path.
      if (policy === 'write-back') {
        get().startCacheUpdateLeg(requestId, 'write')
        return
      }
      // cache-aside, write-through and write-around all hit the database first;
      // what differs is what happens to the cache afterwards.
    }

    get().startDbLeg(requestId)
  },

  /** Server -> cache, to look a key up. */
  startCacheLookupLeg: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request || !request.cacheNodeId || !request.cacheEdgeId) return

    set({
      requests: state.requests.map((r) =>
        r.id === requestId
          ? {
              ...r,
              phase: 'cache-outbound' as const,
              currentEdgeId: request.cacheEdgeId!,
              legFromNodeId: r.targetNodeId,
              legToNodeId: request.cacheNodeId!,
              legDurationMs: CACHE_TRANSIT_MS,
            }
          : r,
      ),
    })
    get().logEvent(
      requestId,
      'server_to_cache_start',
      `lookup, ${CACHE_TRANSIT_MS}ms`,
    )
    scheduleFor(requestId, CACHE_TRANSIT_MS, () => get().arriveAtCache(requestId))
  },

  arriveAtCache: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request || !request.cacheNodeId) return

    const cacheId = request.cacheNodeId
    const cacheNode = state.nodes.find((n) => n.id === cacheId)
    if (isNodeKilled(cacheNode)) {
      get().rejectRequest(requestId, cacheId, 'node_offline', 'Cache is offline')
      return
    }

    const settings = cacheSettingsOf(cacheNode)
    const hit = isCacheHit(
      state.cacheContents[cacheId],
      request.resourceKey,
      settings.ttlSeconds,
    )

    const current = state.cacheStats[cacheId] ?? EMPTY_CACHE_STATS
    set({
      requests: state.requests.map((r) =>
        r.id === requestId
          ? {
              ...r,
              phase: 'cache-lookup' as const,
              cacheOutcome: hit ? ('hit' as const) : ('miss' as const),
              // A hit costs the configured hit latency; discovering a miss is
              // quick, and its real cost is the database trip that follows.
              legDurationMs: hit ? settings.hitLatencyMs : CACHE_MISS_LOOKUP_MS,
            }
          : r,
      ),
      cacheStats: {
        ...state.cacheStats,
        [cacheId]: hit
          ? { ...current, hits: current.hits + 1 }
          : { ...current, misses: current.misses + 1 },
      },
    })

    set((current) => ({
      logs: withLogEntry(current.logs, requestId, (entry) => ({
        ...entry,
        cacheResult: hit ? 'hit' : 'miss',
        events: [
          ...entry.events,
          {
            ts: Date.now(),
            hop: hit ? ('cache_hit' as const) : ('cache_miss' as const),
            detail: request.resourceKey,
          },
        ],
      })),
    }))

    scheduleFor(requestId, hit ? settings.hitLatencyMs : CACHE_MISS_LOOKUP_MS, () =>
      get().finishCacheLookup(requestId),
    )
  },

  /** Cache -> server, carrying either the value or the bad news. */
  finishCacheLookup: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request || !request.cacheNodeId || !request.cacheEdgeId) return

    set({
      requests: state.requests.map((r) =>
        r.id === requestId
          ? {
              ...r,
              phase: 'cache-inbound' as const,
              currentEdgeId: request.cacheEdgeId!,
              legFromNodeId: request.cacheNodeId!,
              legToNodeId: r.targetNodeId,
              legDurationMs: CACHE_TRANSIT_MS,
            }
          : r,
      ),
    })
    get().logEvent(
      requestId,
      'cache_response_start',
      `cache -> server, ${CACHE_TRANSIT_MS}ms`,
    )
    scheduleFor(requestId, CACHE_TRANSIT_MS, () =>
      get().arriveBackFromCache(requestId),
    )
  },

  arriveBackFromCache: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request) return

    get().logEvent(
      requestId,
      'cache_response_received',
      request.cacheAction
        ? `${request.cacheAction} acknowledged`
        : (request.cacheOutcome ?? 'lookup'),
    )

    // Returning from a populate / write / invalidate side trip: head home.
    if (request.cacheAction) {
      const policy = cacheSettingsOf(
        state.nodes.find((n) => n.id === request.cacheNodeId),
      ).writePolicy
      const wasWriteBack =
        request.cacheAction === 'write' &&
        policy === 'write-back' &&
        request.method === 'POST'

      set({
        requests: state.requests.map((r) =>
          r.id === requestId ? { ...r, cacheAction: undefined } : r,
        ),
      })
      get().startResponseHome(requestId)
      if (wasWriteBack) get().scheduleWriteBackFlush(requestId)
      return
    }

    // Returning from a lookup.
    if (request.cacheOutcome === 'hit') {
      get().startResponseHome(requestId)
      return
    }

    const dbAvailable =
      request.databaseNodeId !== undefined &&
      state.nodes.some((n) => n.id === request.databaseNodeId) &&
      state.edges.some((e) => e.id === request.dbEdgeId)

    if (dbAvailable) {
      get().startDbLeg(requestId)
      return
    }

    // Cache but no database: hits are served fine, misses have nowhere to go.
    // Chosen over refusing to fire at all, because that would also block the
    // hits, which are the interesting case for a cache-only topology.
    set({
      notices: {
        ...get().notices,
        [request.sourceNodeId]:
          'Connect a Database — cache misses need somewhere to read from',
      },
    })
    const existing = noticeTimers.get(request.sourceNodeId)
    if (existing !== undefined) clearTimeout(existing)
    noticeTimers.set(
      request.sourceNodeId,
      setTimeout(() => {
        noticeTimers.delete(request.sourceNodeId)
        set({ notices: { ...get().notices, [request.sourceNodeId]: undefined } })
      }, NOTICE_MS),
    )
    get().rejectRequest(
      requestId,
      request.cacheNodeId!,
      'no_database_for_cache_miss',
    )
  },

  /** Server -> cache, to populate, overwrite or invalidate a key. */
  startCacheUpdateLeg: (requestId, action) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request || !request.cacheNodeId || !request.cacheEdgeId) {
      get().startResponseHome(requestId)
      return
    }

    set({
      requests: state.requests.map((r) =>
        r.id === requestId
          ? {
              ...r,
              phase: 'cache-update' as const,
              cacheAction: action,
              currentEdgeId: request.cacheEdgeId!,
              legFromNodeId: r.targetNodeId,
              legToNodeId: request.cacheNodeId!,
              legDurationMs: CACHE_TRANSIT_MS,
            }
          : r,
      ),
    })
    get().logEvent(
      requestId,
      'server_to_cache_start',
      `${action}, ${CACHE_TRANSIT_MS}ms`,
    )
    scheduleFor(requestId, CACHE_TRANSIT_MS, () => get().applyCacheUpdate(requestId))
  },

  applyCacheUpdate: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request || !request.cacheNodeId) return

    const cacheId = request.cacheNodeId
    if (isNodeKilled(state.nodes.find((n) => n.id === cacheId))) {
      get().rejectRequest(requestId, cacheId, 'node_offline', 'Cache is offline')
      return
    }
    const contents = { ...(state.cacheContents[cacheId] ?? {}) }

    if (request.cacheAction === 'invalidate') {
      delete contents[request.resourceKey]
    } else {
      contents[request.resourceKey] = { value: true, cachedAt: Date.now() }
    }

    // A write-back cache answers at cache speed; the others are applying a
    // small bookkeeping update.
    const settings = cacheSettingsOf(state.nodes.find((n) => n.id === cacheId))
    const isWriteBack =
      request.cacheAction === 'write' && settings.writePolicy === 'write-back'
    const workMs = isWriteBack ? settings.hitLatencyMs : CACHE_WRITE_MS

    set({
      cacheContents: { ...state.cacheContents, [cacheId]: contents },
      requests: state.requests.map((r) =>
        r.id === requestId
          ? { ...r, phase: 'cache-writing' as const, legDurationMs: workMs }
          : r,
      ),
    })

    get().logEvent(
      requestId,
      request.cacheAction === 'invalidate'
        ? 'cache_invalidated'
        : request.cacheAction === 'write'
          ? 'cache_written'
          : 'cache_populated',
      request.resourceKey,
    )
    scheduleFor(requestId, workMs, () => get().finishCacheLookup(requestId))
  },

  /** Server -> database. */
  startDbLeg: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request) return

    const dbNode = request.databaseNodeId
      ? state.nodes.find((n) => n.id === request.databaseNodeId)
      : undefined
    const dbEdgeStillThere =
      request.dbEdgeId !== undefined &&
      state.edges.some((e) => e.id === request.dbEdgeId)

    // No database (or it was deleted mid-flight): Phase 2 behaviour exactly.
    if (!dbNode || !dbEdgeStillThere || !request.dbEdgeId) {
      get().startResponseHome(requestId)
      return
    }

    const hopMs = databaseSettingsOf(dbNode).networkLatencyMs

    set({
      requests: state.requests.map((r) =>
        r.id === requestId
          ? {
              ...r,
              phase: 'db-outbound' as const,
              currentEdgeId: request.dbEdgeId!,
              legFromNodeId: r.targetNodeId,
              legToNodeId: dbNode.id,
              legDurationMs: hopMs,
            }
          : r,
      ),
    })

    get().logEvent(requestId, 'server_to_database_start', `${hopMs}ms`)
    scheduleFor(requestId, hopMs, () => get().arriveAtDatabase(requestId))
  },

  arriveAtDatabase: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request || !request.databaseNodeId) return

    const dbNode = state.nodes.find((n) => n.id === request.databaseNodeId)
    if (!dbNode) {
      // Database vanished mid-hop: head home rather than stranding the request.
      get().startResponseHome(requestId)
      return
    }

    if (isNodeKilled(dbNode)) {
      get().rejectRequest(requestId, dbNode.id, 'node_offline', 'Database is offline')
      return
    }

    // A primary with a replica routes reads to it instead of serving them
    // itself. Standalone databases never reach this branch.
    if (
      request.method === 'GET' &&
      databaseRoleOf(dbNode) === 'primary' &&
      replicaOf(state.nodes, state.edges, dbNode.id) !== undefined
    ) {
      const windowMs = databaseSettingsOf(dbNode).readYourWritesWindowMs
      const lastWritten = state.primaryWrites[dbNode.id]?.[request.resourceKey]
      const ageMs = lastWritten === undefined ? null : Date.now() - lastWritten

      // Read-your-writes: a key touched this recently is served here, where the
      // write definitely landed. At the default of 0 this is never true, so the
      // request forwards exactly as it did before this setting existed.
      if (windowMs > 0 && ageMs !== null && ageMs <= windowMs) {
        set({
          requests: state.requests.map((r) =>
            r.id === requestId ? { ...r, readFreshness: 'fresh' as const } : r,
          ),
          logs: withLogEntry(
            withLogEvent(
              state.logs,
              requestId,
              'read_routed_to_primary',
              `written ${ageMs}ms ago, within the ${windowMs}ms window`,
            ),
            requestId,
            (entry) => ({ ...entry, readFreshness: 'fresh' as const }),
          ),
        })
        // Falls through to the primary's own admission and read below.
      } else {
        get().startReplicaLeg(requestId)
        return
      }
    }

    const settings = databaseSettingsOf(dbNode)
    const active = countDbActive(state.requests, dbNode.id)
    const queued = countDbQueued(state.requests, dbNode.id)

    if (active < settings.concurrencyLimit) {
      get().beginDbWork(requestId)
    } else if (queued < settings.maxQueueDepth) {
      set({
        requests: state.requests.map((r) =>
          r.id === requestId
            ? { ...r, phase: 'db-queued' as const, queuedAt: Date.now() }
            : r,
        ),
      })
      get().logEvent(
        requestId,
        'database_queued',
        `${queued + 1} waiting, times out in ${settings.timeoutMs}ms`,
      )
      armTimerFor(requestId, settings.timeoutMs, () =>
        get().timeoutRequest(requestId),
      )
    } else {
      get().rejectRequest(
        requestId,
        dbNode.id,
        'database_queue_full',
        atCapacityDetail(settings.concurrencyLimit, settings.maxQueueDepth),
      )
    }
  },

  /** Primary -> replica. */
  startReplicaLeg: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request || !request.databaseNodeId) return
    const pair = replicaOf(state.nodes, state.edges, request.databaseNodeId)
    if (!pair) {
      // Replica disappeared between arrival and forwarding.
      get().beginDbWork(requestId)
      return
    }

    // Read from the replica, not the primary: this leg's cost describes how far
    // away the replica is, which is the whole point of being able to set it.
    const replicaHopMs = databaseSettingsOf(pair.node).networkLatencyMs

    set({
      requests: state.requests.map((r) =>
        r.id === requestId
          ? {
              ...r,
              phase: 'replica-outbound' as const,
              replicaNodeId: pair.node.id,
              replicaEdgeId: pair.edgeId,
              currentEdgeId: pair.edgeId,
              legFromNodeId: request.databaseNodeId!,
              legToNodeId: pair.node.id,
              legDurationMs: replicaHopMs,
            }
          : r,
      ),
    })
    get().logEvent(
      requestId,
      'primary_forwarded_to_replica',
      displayName(state.nodes, pair.node.id),
    )
    scheduleFor(requestId, replicaHopMs, () => get().arriveAtReplica(requestId))
  },

  arriveAtReplica: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request || !request.replicaNodeId) return

    const replica = state.nodes.find((n) => n.id === request.replicaNodeId)
    if (!replica) {
      get().arriveBackAtPrimary(requestId)
      return
    }
    if (isNodeKilled(replica)) {
      get().rejectRequest(requestId, replica.id, 'node_offline', 'Replica is offline')
      return
    }

    // The replica is a full database node: its own limits, its own queue.
    const settings = databaseSettingsOf(replica)
    const active = countReplicaActive(state.requests, replica.id)
    const queued = countReplicaQueued(state.requests, replica.id)

    if (active < settings.concurrencyLimit) {
      get().beginReplicaWork(requestId)
    } else if (queued < settings.maxQueueDepth) {
      set({
        requests: state.requests.map((r) =>
          r.id === requestId
            ? { ...r, phase: 'replica-queued' as const, queuedAt: Date.now() }
            : r,
        ),
      })
      get().logEvent(
        requestId,
        'database_queued',
        `${queued + 1} waiting at the replica, times out in ${settings.timeoutMs}ms`,
      )
      armTimerFor(requestId, settings.timeoutMs, () =>
        get().timeoutRequest(requestId),
      )
    } else {
      get().rejectRequest(
        requestId,
        replica.id,
        'database_queue_full',
        atCapacityDetail(settings.concurrencyLimit, settings.maxQueueDepth),
      )
    }
  },

  beginReplicaWork: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request || !request.replicaNodeId || !request.databaseNodeId) return
    chargeQueueWait(request)

    const replicaId = request.replicaNodeId
    const settings = databaseSettingsOf(
      state.nodes.find((n) => n.id === replicaId),
    )
    // Freshness is decided when the read is served, not when it was routed.
    const freshness = readFreshnessFor(
      state.primaryWrites,
      state.replicaSyncs,
      request.databaseNodeId,
      replicaId,
      request.resourceKey,
    )
    const tally = state.replicaStats[replicaId] ?? { fresh: 0, stale: 0 }

    set({
      requests: state.requests.map((r) =>
        r.id === requestId
          ? {
              ...r,
              phase: 'replica-processing' as const,
              readFreshness: freshness,
              legDurationMs: settings.readLatencyMs,
            }
          : r,
      ),
      replicaStats: {
        ...state.replicaStats,
        [replicaId]:
          freshness === 'stale'
            ? { ...tally, stale: tally.stale + 1 }
            : { ...tally, fresh: tally.fresh + 1 },
      },
      logs: withLogEntry(
        withLogEvent(
          state.logs,
          requestId,
          'replica_read_start',
          `${freshness} · ${settings.readLatencyMs}ms`,
        ),
        requestId,
        (entry) => ({ ...entry, readFreshness: freshness }),
      ),
    })

    scheduleFor(requestId, settings.readLatencyMs, () =>
      get().finishReplicaWork(requestId),
    )
  },

  finishReplicaWork: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request || !request.replicaNodeId || !request.replicaEdgeId) return
    const replicaId = request.replicaNodeId
    const replicaHopMs = databaseSettingsOf(
      state.nodes.find((n) => n.id === replicaId),
    ).networkLatencyMs

    set({
      requests: state.requests.map((r) =>
        r.id === requestId
          ? {
              ...r,
              phase: 'replica-inbound' as const,
              currentEdgeId: request.replicaEdgeId!,
              legFromNodeId: replicaId,
              legToNodeId: r.databaseNodeId ?? replicaId,
              legDurationMs: replicaHopMs,
            }
          : r,
      ),
      // A replica read is still a read; it counts on the replica's own card.
      dbStats: bumpDbStat(state.dbStats, replicaId, 'reads'),
    })
    get().logEvent(requestId, 'replica_read_end', request.readFreshness)
    scheduleFor(requestId, replicaHopMs, () =>
      get().arriveBackAtPrimary(requestId),
    )
    get().admitFromReplicaQueue(replicaId)
  },

  /** Back at the primary; from here the normal database return leg applies. */
  arriveBackAtPrimary: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request || !request.dbEdgeId || !request.databaseNodeId) return
    const hopMs = databaseSettingsOf(
      state.nodes.find((n) => n.id === request.databaseNodeId),
    ).networkLatencyMs

    set({
      requests: state.requests.map((r) =>
        r.id === requestId
          ? {
              ...r,
              phase: 'db-inbound' as const,
              currentEdgeId: request.dbEdgeId!,
              legFromNodeId: request.databaseNodeId!,
              legToNodeId: r.targetNodeId,
              legDurationMs: hopMs,
            }
          : r,
      ),
    })
    scheduleFor(requestId, hopMs, () => get().arriveBackAtServer(requestId))
  },

  /**
   * Fire-and-forget catch-up. Events land on the ORIGINAL request's log entry
   * after it has already completed, exactly like a write-back flush, so the
   * trace shows work that outlived the response.
   */
  replicateWrite: (originRequestId, primaryId, resourceKey) => {
    const state = get()
    const pair = replicaOf(state.nodes, state.edges, primaryId)
    if (!pair) return
    const replicaId = pair.node.id
    // The lag is configured on the replica — it describes how far behind that
    // replica runs, not something the primary decides.
    const lagMs = databaseSettingsOf(pair.node).replicationLagMs

    get().logEvent(
      originRequestId,
      'replica_sync_start',
      `${resourceKey} -> ${displayName(state.nodes, replicaId)}, ${lagMs}ms behind`,
    )

    const flushId = nextSyncId()
    flushTimers.set(
      flushId,
      setTimeout(() => {
        flushTimers.delete(flushId)
        const now = get()
        if (!now.nodes.some((n) => n.id === replicaId)) return
        set((current) => ({
          replicaSyncs: {
            ...current.replicaSyncs,
            [replicaId]: {
              ...(current.replicaSyncs[replicaId] ?? {}),
              [resourceKey]: Date.now(),
            },
          },
        }))
        get().logEvent(
          originRequestId,
          'replica_sync_end',
          `${resourceKey} now in sync`,
        )
      }, lagMs),
    )
  },

  admitFromReplicaQueue: (replicaId) => {
    const state = get()
    const replica = state.nodes.find((n) => n.id === replicaId)
    if (isNodeKilled(replica)) return
    const settings = databaseSettingsOf(replica)
    if (countReplicaActive(state.requests, replicaId) >= settings.concurrencyLimit)
      return
    const next = state.requests.find(
      (r) => r.replicaNodeId === replicaId && r.phase === 'replica-queued',
    )
    if (next) get().beginReplicaWork(next.id)
  },

  beginDbWork: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request || !request.databaseNodeId) return
    chargeQueueWait(request)

    const settings = databaseSettingsOf(
      state.nodes.find((n) => n.id === request.databaseNodeId),
    )
    // Reads and writes cost different amounts; writes are the slow path.
    const workMs =
      request.method === 'GET' ? settings.readLatencyMs : settings.writeLatencyMs

    set({
      requests: state.requests.map((r) =>
        r.id === requestId
          ? { ...r, phase: 'db-processing' as const, legDurationMs: workMs }
          : r,
      ),
    })

    get().logEvent(
      requestId,
      'database_processing_start',
      request.method === 'GET' ? 'read' : 'write',
    )
    scheduleFor(requestId, workMs, () => get().finishDbWork(requestId))
  },

  finishDbWork: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request || !request.databaseNodeId || !request.dbEdgeId) return

    const dbId = request.databaseNodeId
    const hopMs = databaseSettingsOf(
      state.nodes.find((n) => n.id === dbId),
    ).networkLatencyMs

    set({
      requests: state.requests.map((r) =>
        r.id === requestId
          ? {
              ...r,
              phase: 'db-inbound' as const,
              currentEdgeId: request.dbEdgeId!,
              legFromNodeId: dbId,
              legToNodeId: r.targetNodeId,
              legDurationMs: hopMs,
            }
          : r,
      ),
      dbStats: bumpDbStat(
        state.dbStats,
        dbId,
        request.method === 'GET' ? 'reads' : 'writes',
      ),
    })

    get().logEvent(
      requestId,
      'database_processing_end',
      request.method === 'GET' ? 'read' : 'write',
    )
    scheduleFor(requestId, hopMs, () => get().arriveBackAtServer(requestId))

    // A committed write on a primary starts replication. The client is on its
    // way home already: replicationLagMs must never touch its response time.
    if (request.method === 'POST' && request.databaseNodeId) {
      const primaryId = request.databaseNodeId
      const after = get()
      if (databaseRoleOf(after.nodes.find((n) => n.id === primaryId)) === 'primary') {
        const committedAt = Date.now()
        set((current) => ({
          primaryWrites: {
            ...current.primaryWrites,
            [primaryId]: {
              ...(current.primaryWrites[primaryId] ?? {}),
              [request.resourceKey]: committedAt,
            },
          },
        }))
        get().replicateWrite(requestId, primaryId, request.resourceKey)
      }
    }

    // That database worker is free now.
    get().admitFromDbQueue(dbId)
  },

  arriveBackAtServer: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request) return

    get().logEvent(
      requestId,
      'database_response_received',
      `database -> server, ${request.legDurationMs}ms`,
    )

    const hasCache =
      request.cacheNodeId !== undefined &&
      state.nodes.some((n) => n.id === request.cacheNodeId) &&
      state.edges.some((e) => e.id === request.cacheEdgeId)

    if (hasCache) {
      const policy = cacheSettingsOf(
        state.nodes.find((n) => n.id === request.cacheNodeId),
      ).writePolicy

      // Read path: populate on miss regardless of policy. The write policies
      // describe what happens to writes, not to read-misses.
      if (request.method === 'GET' && request.cacheOutcome === 'miss') {
        get().startCacheUpdateLeg(requestId, 'populate')
        return
      }

      if (request.method === 'POST') {
        // Synchronously refresh the cache before answering the client.
        if (policy === 'write-through') {
          get().startCacheUpdateLeg(requestId, 'write')
          return
        }
        // Drop the key so the next read is a genuine miss.
        if (policy === 'write-around') {
          get().startCacheUpdateLeg(requestId, 'invalidate')
          return
        }
        // cache-aside: the cache is deliberately left untouched, which means
        // any previously cached copy of this key is now stale.
      }
    }

    get().startResponseHome(requestId)
  },

  /**
   * Write-back only: the client has already been answered, so this flush runs
   * on its own clock and deliberately skips database admission control — it is
   * background work, not a client-facing request.
   */
  scheduleWriteBackFlush: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (
      !request ||
      !request.cacheNodeId ||
      !request.databaseNodeId ||
      !request.dbEdgeId
    )
      return

    const { cacheNodeId, databaseNodeId, dbEdgeId, targetNodeId, resourceKey } =
      request
    const flushId = nextSyncId()

    const originRequestId = request.id

    set({
      pendingSyncs: {
        ...state.pendingSyncs,
        [cacheNodeId]: (state.pendingSyncs[cacheNodeId] ?? 0) + 1,
      },
      // This is the moment the promise is made: the client has been told the
      // write succeeded while the database has not seen it yet.
      writeDurability: {
        ...state.writeDurability,
        acknowledged: state.writeDurability.acknowledged + 1,
      },
      // The client has already been answered; the entry stays 'success' with
      // its original duration, and only gains a pendingSync flag.
      logs: withLogEntry(state.logs, originRequestId, (entry) => ({
        ...entry,
        pendingSync: true,
      })),
    })

    const releasePending = () =>
      set((current) => ({
        pendingSyncs: {
          ...current.pendingSyncs,
          [cacheNodeId]: Math.max(
            0,
            (current.pendingSyncs[cacheNodeId] ?? 1) - 1,
          ),
        },
      }))

    flushTimers.set(
      flushId,
      setTimeout(() => {
        flushTimers.delete(flushId)
        const now = get()
        const stillWired =
          now.nodes.some((n) => n.id === databaseNodeId) &&
          now.nodes.some((n) => n.id === targetNodeId) &&
          now.edges.some((e) => e.id === dbEdgeId)
        if (!stillWired) {
          releasePending()
          set((current) => ({
            // Unwired before the flush could leave: the acknowledged write is
            // gone, which counts against durability exactly like a drop.
            writeDurability: {
              ...current.writeDurability,
              lost: current.writeDurability.lost + 1,
            },
            cacheStats: {
              ...current.cacheStats,
              [cacheNodeId]: {
                ...(current.cacheStats[cacheNodeId] ?? EMPTY_CACHE_STATS),
                lostWrites:
                  (current.cacheStats[cacheNodeId]?.lostWrites ?? 0) + 1,
              },
            },
            // The same event the drop path emits, so the Log panel's "write
            // lost" badge and the Cache card's counter always agree about what
            // counts as a lost write.
            logs: withLogEntry(
              withLogEvent(
                current.logs,
                originRequestId,
                'async_db_write_lost',
                `${resourceKey} was acknowledged but never stored — the database or its link was removed before the write could be sent`,
              ),
              originRequestId,
              (entry) => ({ ...entry, pendingSync: false }),
            ),
          }))
          return
        }

        const flushHopMs = databaseSettingsOf(
          now.nodes.find((n) => n.id === databaseNodeId),
        ).networkLatencyMs

        const sync: InFlightRequest = {
          id: flushId,
          sourceNodeId: targetNodeId,
          targetNodeId,
          databaseNodeId,
          cacheNodeId,
          clientEdgeId: dbEdgeId,
          dbEdgeId,
          currentEdgeId: dbEdgeId,
          legFromNodeId: targetNodeId,
          legToNodeId: databaseNodeId,
          phase: 'sync-outbound',
          method: 'POST',
          resourceKey,
          kind: 'sync',
          routedVia: 'direct',
          originRequestId,
          legDurationMs: flushHopMs,
        }
        set((current) => ({ requests: [...current.requests, sync] }))
        scheduleFor(flushId, flushHopMs, () =>
          get().syncArriveAtDatabase(flushId),
        )
      }, WRITE_BACK_DELAY_MS),
    )
  },

  /**
   * A flush reaching the database takes its turn like any other write: it needs
   * a free connection, or a place in the queue, or it is dropped. Dropping one
   * is the whole risk of write-back — the customer was told the order went
   * through before the database had ever seen it.
   */
  syncArriveAtDatabase: (syncId) => {
    const state = get()
    const sync = state.requests.find((r) => r.id === syncId)
    if (!sync || !sync.databaseNodeId) return

    const dbNode = state.nodes.find((n) => n.id === sync.databaseNodeId)
    if (!dbNode || isNodeKilled(dbNode)) {
      get().loseSync(syncId, dbNode ? 'database offline' : 'database is gone')
      return
    }

    const settings = databaseSettingsOf(dbNode)
    const active = countDbActive(state.requests, dbNode.id)
    const queued = countDbQueued(state.requests, dbNode.id)

    if (active >= settings.concurrencyLimit) {
      if (queued >= settings.maxQueueDepth) {
        // Dropped on the first rejection, with no retry and no backoff. That is
        // a deliberate simplification, not an oversight: a real write-back cache
        // would hold the entry dirty and try again later. Retry with backoff is
        // a separate feature, and adding it here would change what this models —
        // the point of the drop is to make the risk of acknowledging a write
        // before it is stored visible and countable.
        get().loseSync(
          syncId,
          atCapacityDetail(settings.concurrencyLimit, settings.maxQueueDepth),
        )
        return
      }
      set({
        requests: state.requests.map((r) =>
          r.id === syncId
            ? { ...r, phase: 'sync-queued' as const, queuedAt: Date.now() }
            : r,
        ),
      })
      if (sync.originRequestId) {
        get().logEvent(
          sync.originRequestId,
          'async_db_write_queued',
          `deferred write of ${sync.resourceKey} waiting for a connection`,
        )
      }
      return
    }

    get().beginSyncWrite(syncId)
  },

  /** A flush that has won a database connection. */
  beginSyncWrite: (syncId) => {
    const state = get()
    const sync = state.requests.find((r) => r.id === syncId)
    if (!sync) return
    // The database's own write cost, not a flat rate: a deferred write is the
    // same work as a synchronous one, just later.
    const writeMs = databaseSettingsOf(
      state.nodes.find((n) => n.id === sync.databaseNodeId),
    ).writeLatencyMs
    if (sync.originRequestId) {
      get().logEvent(
        sync.originRequestId,
        'async_db_write_start',
        `deferred write of ${sync.resourceKey}, ${writeMs}ms`,
      )
    }
    set({
      requests: state.requests.map((r) =>
        r.id === syncId
          ? { ...r, phase: 'sync-writing' as const, legDurationMs: writeMs }
          : r,
      ),
    })
    scheduleFor(syncId, writeMs, () => get().finishSync(syncId))
  },

  loseSync: (syncId, reason) => {
    const state = get()
    const sync = state.requests.find((r) => r.id === syncId)
    if (!sync) return
    clearTimerFor(syncId)
    set({
      requests: state.requests.filter((r) => r.id !== syncId),
      pendingSyncs: sync.cacheNodeId
        ? {
            ...state.pendingSyncs,
            [sync.cacheNodeId]: Math.max(
              0,
              (state.pendingSyncs[sync.cacheNodeId] ?? 1) - 1,
            ),
          }
        : state.pendingSyncs,
      writeDurability: {
        ...state.writeDurability,
        lost: state.writeDurability.lost + 1,
      },
      cacheStats: sync.cacheNodeId
        ? {
            ...state.cacheStats,
            [sync.cacheNodeId]: {
              ...(state.cacheStats[sync.cacheNodeId] ?? EMPTY_CACHE_STATS),
              lostWrites:
                (state.cacheStats[sync.cacheNodeId]?.lostWrites ?? 0) + 1,
            },
          }
        : state.cacheStats,
      logs: sync.originRequestId
        ? withLogEntry(
            withLogEvent(
              state.logs,
              sync.originRequestId,
              'async_db_write_lost',
              `${sync.resourceKey} was acknowledged but never stored — ${reason}`,
            ),
            sync.originRequestId,
            (entry) => ({ ...entry, pendingSync: false }),
          )
        : state.logs,
    })
    // That attempt freed nothing, but a queued flush may now fit.
    if (sync.databaseNodeId) get().admitFromDbQueue(sync.databaseNodeId)
  },

  finishSync: (syncId) => {
    const state = get()
    const sync = state.requests.find((r) => r.id === syncId)
    if (!sync) return
    clearTimerFor(syncId)
    set({
      requests: state.requests.filter((r) => r.id !== syncId),
      dbStats: sync.databaseNodeId
        ? bumpDbStat(state.dbStats, sync.databaseNodeId, 'writes')
        : state.dbStats,
      pendingSyncs: sync.cacheNodeId
        ? {
            ...state.pendingSyncs,
            [sync.cacheNodeId]: Math.max(
              0,
              (state.pendingSyncs[sync.cacheNodeId] ?? 1) - 1,
            ),
          }
        : state.pendingSyncs,
      writeDurability: {
        ...state.writeDurability,
        durable: state.writeDurability.durable + 1,
      },
      logs: sync.originRequestId
        ? withLogEntry(
            withLogEvent(
              state.logs,
              sync.originRequestId,
              'async_db_write_end',
              'now durable',
            ),
            sync.originRequestId,
            // finishedAt / totalDurationMs / outcome deliberately unchanged:
            // this work happened after the user-visible response.
            (entry) => ({ ...entry, pendingSync: false }),
          )
        : state.logs,
    })
    // The connection this flush held is free now.
    if (sync.databaseNodeId) get().admitFromDbQueue(sync.databaseNodeId)
  },

  /**
   * Response leaving the server. This is where the server worker is released,
   * whichever way home the request takes.
   */
  startResponseHome: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request) return

    const lbStillThere =
      request.loadBalancerNodeId !== undefined &&
      state.nodes.some((n) => n.id === request.loadBalancerNodeId) &&
      state.edges.some((e) => e.id === request.lbServerEdgeId)

    if (!lbStillThere) {
      // Direct topology, or the balancer vanished mid-flight.
      get().startInboundLeg(requestId)
      return
    }

    set({
      requests: state.requests.map((r) =>
        r.id === requestId
          ? {
              ...r,
              phase: 'server-to-lb' as const,
              currentEdgeId: r.lbServerEdgeId!,
              legFromNodeId: r.targetNodeId,
              legToNodeId: request.loadBalancerNodeId!,
              legDurationMs: LB_HOP_MS,
            }
          : r,
      ),
    })

    scheduleFor(requestId, LB_HOP_MS, () =>
      get().arriveBackAtLoadBalancer(requestId),
    )
    get().admitFromServerQueue(request.targetNodeId)
  },

  /** Final leg home on a direct topology. */
  startInboundLeg: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request) return

    const settings = serverSettingsOf(
      state.nodes.find((n) => n.id === request.targetNodeId),
    )

    set({
      requests: state.requests.map((r) =>
        r.id === requestId
          ? {
              ...r,
              phase: 'inbound' as const,
              currentEdgeId: r.clientEdgeId,
              legFromNodeId: r.targetNodeId,
              legToNodeId: r.sourceNodeId,
              legDurationMs: settings.networkLatencyMs,
            }
          : r,
      ),
    })

    get().logEvent(requestId, 'inbound_start', 'server -> client')
    scheduleFor(requestId, settings.networkLatencyMs, () =>
      get().completeRequest(requestId),
    )

    get().admitFromServerQueue(request.targetNodeId)
  },

  admitFromServerQueue: (serverId) => {
    const state = get()
    const server = state.nodes.find((n) => n.id === serverId)
    if (isNodeKilled(server)) return
    const settings = serverSettingsOf(server)
    if (countServerActive(state.requests, serverId) >= settings.concurrencyLimit)
      return
    const next = state.requests.find(
      (r) => r.targetNodeId === serverId && r.phase === 'queued',
    )
    if (next) get().beginProcessing(next.id)
  },

  admitFromDbQueue: (dbId) => {
    const state = get()
    const dbNode = state.nodes.find((n) => n.id === dbId)
    if (isNodeKilled(dbNode)) return
    const settings = databaseSettingsOf(dbNode)
    if (countDbActive(state.requests, dbId) >= settings.concurrencyLimit) return
    // Waiting client requests and waiting deferred writes share one queue, and
    // the oldest goes first — a flush cannot jump ahead of a live request, and
    // live traffic cannot starve the backlog forever.
    const next = state.requests
      .filter(
        (r) =>
          r.databaseNodeId === dbId &&
          (r.phase === 'db-queued' || r.phase === 'sync-queued'),
      )
      .sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0))[0]
    if (!next) return
    if (next.phase === 'sync-queued') get().beginSyncWrite(next.id)
    else get().beginDbWork(next.id)
  },

  completeRequest: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request) return

    set({
      requests: state.requests.map((r) =>
        r.id === requestId ? { ...r, phase: 'complete' as const } : r,
      ),
      clientStats: bumpStat(state.clientStats, request.sourceNodeId, 'completed'),
      metrics: withSample(
        state.metrics,
        request,
        'success',
      ),
      logs: withLogEntry(
        withLogEvent(state.logs, requestId, 'request_completed'),
        requestId,
        (entry) => ({
          ...entry,
          finishedAt: Date.now(),
          totalDurationMs: simElapsed(requestId),
          outcome: 'success',
          readFreshness: entry.readFreshness ?? 'not_applicable',
        }),
      ),
    })

    armTimerFor(requestId, COMPLETION_LINGER_MS, () =>
      get().removeRequest(requestId),
    )
  },

  rejectRequest: (requestId, atNodeId, reason, detail) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request) return

    set({
      requests: state.requests.map((r) =>
        r.id === requestId
          ? {
              ...r,
              phase: 'failed' as const,
              failedNodeId: atNodeId,
              failureReason: reason,
            }
          : r,
      ),
      clientStats: bumpStat(state.clientStats, request.sourceNodeId, 'failed'),
      metrics: withSample(
        state.metrics,
        request,
        'failed',
      ),
      // A failed request stops emitting normal hops; this is its last event.
      logs: withLogEntry(
        withLogEvent(state.logs, requestId, 'request_failed', detail ?? reason),
        requestId,
        (entry) => ({
          ...entry,
          finishedAt: Date.now(),
          totalDurationMs: simElapsed(requestId),
          outcome: 'failed',
          failureReason: reason,
          readFreshness: entry.readFreshness ?? 'not_applicable',
        }),
      ),
    })

    armTimerFor(requestId, REJECTION_LINGER_MS, () =>
      get().removeRequest(requestId),
    )

    // A request rejected at the database was holding a server worker.
    get().admitFromServerQueue(request.targetNodeId)
    if (request.databaseNodeId) get().admitFromDbQueue(request.databaseNodeId)
  },

  toggleNodeKilled: (nodeId) => {
    const state = get()
    const node = state.nodes.find((n) => n.id === nodeId)
    if (!node) return
    const data = node.data as SystemNodeData
    const nextKilled = !data.isKilled

    set({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...data, isKilled: nextKilled } } : n,
      ),
      // Timestamped so the kill-test criterion can tell whether an outage
      // actually happened inside the window being graded.
      nodeEvents: [
        ...state.nodeEvents,
        {
          nodeId,
          action: (nextKilled ? 'killed' : 'revived') as NodeToggleEvent['action'],
          ts: Date.now(),
        },
      ].slice(-NODE_EVENT_CAP),
    })

    track(nextKilled ? 'node_killed' : 'node_revived', {
      componentType: data.componentType,
    })

    if (!nextKilled) return

    // A real outage drops whatever was waiting for a slot. Work that is
    // already mid-processing is left alone and runs to completion.
    const stranded = get().requests.filter(
      (r) =>
        (r.phase === 'queued' && r.targetNodeId === nodeId) ||
        (r.phase === 'db-queued' && r.databaseNodeId === nodeId),
    )
    for (const request of stranded) {
      get().rejectRequest(
        request.id,
        nodeId,
        'node_offline',
        'Node was taken offline while this request waited in its queue',
      )
    }
  },

  timeoutRequest: (requestId) => {
    const state = get()
    const request = state.requests.find((r) => r.id === requestId)
    if (!request) return
    // Only queued work can time out. Once a request holds a slot and is
    // thinking, it always runs to completion.
    if (request.phase !== 'queued' && request.phase !== 'db-queued') return

    const atNodeId =
      request.phase === 'db-queued'
        ? (request.databaseNodeId ?? request.targetNodeId)
        : request.targetNodeId
    const waited = request.queuedAt ? Date.now() - request.queuedAt : 0
    chargeQueueWait(request)

    get().rejectRequest(
      requestId,
      atNodeId,
      'timeout',
      `Timed out after waiting ${waited}ms in queue`,
    )
  },

  removeRequest: (requestId) => {
    clearTimerFor(requestId)
    simClocks.delete(requestId)
    set({ requests: get().requests.filter((r) => r.id !== requestId) })
  },

  /** Drops in-flight requests whose node or edge has been deleted. */
  pruneRequests: () => {
    const { nodes, edges, requests } = get()
    const nodeIds = new Set(nodes.map((n) => n.id))
    const edgeIds = new Set(edges.map((e) => e.id))

    const survivors = requests.filter(
      (r) =>
        nodeIds.has(r.sourceNodeId) &&
        // Empty until a balancer picks a backend; not yet a missing node.
        (r.targetNodeId === '' || nodeIds.has(r.targetNodeId)) &&
        edgeIds.has(r.clientEdgeId) &&
        edgeIds.has(r.currentEdgeId),
    )
    if (survivors.length === requests.length) return

    const pendingSyncs = { ...get().pendingSyncs }
    for (const request of requests) {
      if (survivors.includes(request)) continue
      clearTimerFor(request.id)
      // A dropped flush must not leave its "pending" marker stuck on screen.
      if (request.kind === 'sync' && request.cacheNodeId) {
        pendingSyncs[request.cacheNodeId] = Math.max(
          0,
          (pendingSyncs[request.cacheNodeId] ?? 1) - 1,
        )
      }
    }
    set({ requests: survivors, pendingSyncs })
  },
}))
