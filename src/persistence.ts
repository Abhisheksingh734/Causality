import type { Edge, Node } from '@xyflow/react'
import type { ComponentType } from './componentTypes'
import type { BaselineMetrics } from './grading'
import {
  METRIC_CAP,
  DEFAULT_SETTINGS,
  LOG_CAP,
  useFlowStore,
  type CacheStats,
  type ClientStats,
  type DbStats,
  type LbStats,
  type LogEntry,
  type MetricSample,
  type ServerStats,
  type SystemNodeData,
} from './store'

export const CANVAS_KEY = 'paperdraw-canvas-v1'
export const HISTORY_KEY = 'paperdraw-history-v1'
export const SAVE_DEBOUNCE_MS = 500

/** Narrow slice of the Storage API, so tests can pass a stand-in. */
export type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** localStorage throws outright in some privacy modes, and is absent in Node. */
export function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

export type CanvasSnapshot = { version: 1; nodes: Node[]; edges: Edge[] }
export type HistorySnapshot = {
  version: 1
  logs: LogEntry[]
  clientStats: Record<string, ClientStats>
  dbStats: Record<string, DbStats>
  cacheStats: Record<string, CacheStats>
  lbStats: Record<string, LbStats>
  serverStats: Record<string, ServerStats>
  totalFired: number
  activeProblemId: string | null
  metrics: MetricSample[]
  baselines: Record<string, BaselineMetrics>
}

/** localStorage has a few MB; the in-memory store may hold far more. */
export const PERSISTED_METRIC_CAP = 2000

const KNOWN_TYPES = new Set<string>(Object.keys(DEFAULT_SETTINGS))
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/* ------------------------------------------------------------------ *
 * Serialise
 * ------------------------------------------------------------------ */

export function serializeCanvas(nodes: Node[], edges: Edge[]): CanvasSnapshot {
  return {
    version: 1,
    // Drop transient interaction flags: a node should not come back mid-drag
    // or still selected from a previous session.
    nodes: nodes.map(({ id, type, position, data }) => ({
      id,
      type,
      position,
      // isKilled is transient: an outage you staged during an experiment
      // should not survive a refresh.
      data: Object.fromEntries(
        Object.entries(data).filter(([key]) => key !== 'isKilled'),
      ),
    })),
    edges: edges.map(({ id, source, target, sourceHandle, targetHandle, type, style, markerEnd }) => ({
      id,
      source,
      target,
      sourceHandle,
      targetHandle,
      type,
      style,
      markerEnd,
    })),
  }
}

export function serializeHistory(state: {
  logs: LogEntry[]
  clientStats: Record<string, ClientStats>
  dbStats: Record<string, DbStats>
  cacheStats: Record<string, CacheStats>
  lbStats: Record<string, LbStats>
  serverStats: Record<string, ServerStats>
  totalFired: number
  activeProblemId: string | null
  metrics: MetricSample[]
  baselines: Record<string, BaselineMetrics>
}): HistorySnapshot {
  return {
    version: 1,
    // In-progress entries can never resolve across a reload — their timers are
    // gone — so they are dropped rather than restored as permanent spinners.
    logs: state.logs.filter((entry) => entry.outcome !== 'in_progress').slice(0, LOG_CAP),
    clientStats: state.clientStats,
    dbStats: state.dbStats,
    cacheStats: state.cacheStats,
    lbStats: state.lbStats,
    serverStats: state.serverStats,
    totalFired: state.totalFired,
    // The brief must survive a refresh: solving a Problem takes minutes.
    activeProblemId: state.activeProblemId,
    metrics: state.metrics.slice(-PERSISTED_METRIC_CAP),
    // A baseline represents real measurement work; losing it on refresh would
    // force the whole run to be repeated.
    baselines: state.baselines,
  }
}

/* ------------------------------------------------------------------ *
 * Parse + validate
 * ------------------------------------------------------------------ */

export function parseCanvas(raw: string | null): CanvasSnapshot | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isObject(parsed)) throw new Error('not an object')
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges))
      throw new Error('missing nodes/edges')

    const nodes: Node[] = parsed.nodes.map((candidate: unknown) => {
      if (!isObject(candidate)) throw new Error('bad node')
      const { id, position, data } = candidate
      if (typeof id !== 'string') throw new Error('node id')
      if (!isObject(position) || typeof position.x !== 'number' || typeof position.y !== 'number')
        throw new Error('node position')
      if (!isObject(data) || typeof data.componentType !== 'string')
        throw new Error('node data')
      const componentType = data.componentType as ComponentType
      if (!KNOWN_TYPES.has(componentType)) throw new Error(`unknown type ${componentType}`)

      // Merging over defaults means a setting added in a later version simply
      // appears with its default rather than arriving undefined.
      const settings = {
        ...DEFAULT_SETTINGS[componentType],
        ...(isObject(data.settings) ? data.settings : {}),
      }
      return {
        id,
        type: 'systemNode',
        position: { x: position.x, y: position.y },
        data: {
          componentType,
          label: typeof data.label === 'string' ? data.label : componentType,
          settings,
        } as SystemNodeData,
      } as Node
    })

    const nodeIds = new Set(nodes.map((n) => n.id))
    const edges: Edge[] = parsed.edges
      .map((candidate: unknown) => {
        if (!isObject(candidate)) throw new Error('bad edge')
        const { id, source, target } = candidate
        if (typeof id !== 'string' || typeof source !== 'string' || typeof target !== 'string')
          throw new Error('edge fields')
        return candidate as unknown as Edge
      })
      // An edge to a node that did not survive would dangle forever.
      .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))

    return { version: 1, nodes, edges }
  } catch (error) {
    console.warn(
      `[persistence] Ignoring corrupt canvas in localStorage ("${CANVAS_KEY}"); starting from a blank canvas.`,
      error,
    )
    return null
  }
}

export function parseHistory(raw: string | null): HistorySnapshot | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isObject(parsed)) throw new Error('not an object')
    if (!Array.isArray(parsed.logs)) throw new Error('missing logs')

    const logs = parsed.logs.filter(
      (entry: unknown) =>
        isObject(entry) &&
        typeof entry.requestId === 'string' &&
        typeof entry.outcome === 'string' &&
        Array.isArray(entry.events),
    ) as LogEntry[]

    const counters = <T,>(value: unknown): Record<string, T> =>
      isObject(value) ? (value as Record<string, T>) : {}

    return {
      version: 1,
      logs: logs.slice(0, LOG_CAP),
      clientStats: counters<ClientStats>(parsed.clientStats),
      dbStats: counters<DbStats>(parsed.dbStats),
      cacheStats: counters<CacheStats>(parsed.cacheStats),
      lbStats: counters<LbStats>(parsed.lbStats),
      serverStats: counters<ServerStats>(parsed.serverStats),
      totalFired: typeof parsed.totalFired === 'number' ? parsed.totalFired : 0,
      activeProblemId:
        typeof parsed.activeProblemId === 'string' ? parsed.activeProblemId : null,
      baselines:
        parsed.baselines && typeof parsed.baselines === 'object'
          ? (parsed.baselines as Record<string, BaselineMetrics>)
          : {},
      metrics: Array.isArray(parsed.metrics)
        ? (parsed.metrics as MetricSample[])
            .filter((m) => m && typeof m.t === 'number' && typeof m.d === 'number')
            .slice(-METRIC_CAP)
        : [],
    }
  } catch (error) {
    console.warn(
      `[persistence] Ignoring corrupt history in localStorage ("${HISTORY_KEY}"); counters start from zero.`,
      error,
    )
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Read / write / clear
 * ------------------------------------------------------------------ */

export function loadPersisted(storage: StorageLike | null = defaultStorage()) {
  if (!storage) return { canvas: null, history: null }
  try {
    return {
      canvas: parseCanvas(storage.getItem(CANVAS_KEY)),
      history: parseHistory(storage.getItem(HISTORY_KEY)),
    }
  } catch (error) {
    console.warn('[persistence] Could not read from localStorage.', error)
    return { canvas: null, history: null }
  }
}

export function saveNow(storage: StorageLike | null = defaultStorage()) {
  if (!storage) return
  const state = useFlowStore.getState()
  try {
    storage.setItem(CANVAS_KEY, JSON.stringify(serializeCanvas(state.nodes, state.edges)))
    storage.setItem(HISTORY_KEY, JSON.stringify(serializeHistory(state)))
  } catch (error) {
    // Quota exceeded, private mode, etc. Losing a save is survivable.
    console.warn('[persistence] Could not write to localStorage.', error)
  }
}

export function clearPersisted(storage: StorageLike | null = defaultStorage()) {
  if (!storage) return
  try {
    storage.removeItem(CANVAS_KEY)
    storage.removeItem(HISTORY_KEY)
  } catch (error) {
    console.warn('[persistence] Could not clear localStorage.', error)
  }
}

/** Restores whatever is in storage. Safe to call with nothing stored. */
export function hydrateFromStorage(storage: StorageLike | null = defaultStorage()) {
  const { canvas, history } = loadPersisted(storage)
  if (!canvas && !history) return false
  useFlowStore.getState().hydrate({
    nodes: canvas?.nodes ?? [],
    edges: canvas?.edges ?? [],
    logs: history?.logs ?? [],
    clientStats: history?.clientStats ?? {},
    dbStats: history?.dbStats ?? {},
    cacheStats: history?.cacheStats ?? {},
    lbStats: history?.lbStats ?? {},
    serverStats: history?.serverStats ?? {},
    totalFired: history?.totalFired ?? 0,
    activeProblemId: history?.activeProblemId ?? null,
    metrics: history?.metrics ?? [],
    baselines: history?.baselines ?? {},
  })
  return true
}

/**
 * Saves on meaningful change, debounced so a drag writes once when it settles
 * rather than on every pixel. Returns an unsubscribe function.
 */
export function startAutoSave(
  storage: StorageLike | null = defaultStorage(),
  debounceMs = SAVE_DEBOUNCE_MS,
) {
  if (!storage) return () => {}
  let timer: ReturnType<typeof setTimeout> | undefined

  const unsubscribe = useFlowStore.subscribe((state, previous) => {
    const changed =
      state.nodes !== previous.nodes ||
      state.edges !== previous.edges ||
      state.logs !== previous.logs ||
      state.clientStats !== previous.clientStats ||
      state.dbStats !== previous.dbStats ||
      state.cacheStats !== previous.cacheStats ||
      state.lbStats !== previous.lbStats ||
      state.serverStats !== previous.serverStats
    if (!changed) return

    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      saveNow(storage)
    }, debounceMs)
  })

  return () => {
    if (timer !== undefined) clearTimeout(timer)
    unsubscribe()
  }
}
