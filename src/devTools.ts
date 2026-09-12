import type { Edge, Node } from '@xyflow/react'
import type { ComponentType } from './componentTypes'
import { buildSessionExport, type ExportedEdge, type ExportedNode } from './exportSession'
import {
  DEFAULT_SETTINGS,
  type CacheResult,
  type LogEntry,
  type ReadFreshness,
  type SystemNodeData,
} from './store'

/* ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */

const KNOWN_TYPES = new Set<ComponentType>([
  'client',
  'loadbalancer',
  'server',
  'cache',
  'database',
])

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export type ParsedSetup =
  | { ok: true; nodes: Node[]; edges: Edge[]; ignoredKeys: string[] }
  | { ok: false; error: string }

/**
 * Accepts both node shapes in circulation: the nested `data: { componentType,
 * settings }` form the presets use, and the flat form this app's own export
 * produces. Pasting a full session export straight back in therefore works,
 * which is exactly what someone will try.
 */
export function parseSetup(raw: string): ParsedSetup {
  const text = raw.trim()
  if (text === '') return { ok: false, error: 'Nothing pasted yet.' }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      error: `Not valid JSON — ${error instanceof Error ? error.message : 'could not parse'}`,
    }
  }

  if (!isObject(parsed)) return { ok: false, error: 'Top level must be an object.' }
  if (!Array.isArray(parsed.nodes))
    return { ok: false, error: 'Missing a "nodes" array.' }
  if (!Array.isArray(parsed.edges))
    return { ok: false, error: 'Missing an "edges" array.' }
  if (parsed.nodes.length === 0)
    return { ok: false, error: '"nodes" is empty — nothing to load.' }

  const nodes: Node[] = []
  for (const [index, candidate] of parsed.nodes.entries()) {
    if (!isObject(candidate))
      return { ok: false, error: `Node ${index} is not an object.` }

    const data = isObject(candidate.data) ? candidate.data : candidate
    const id = candidate.id
    if (typeof id !== 'string' || id === '')
      return { ok: false, error: `Node ${index} needs a string "id".` }

    const componentType = data.componentType
    if (typeof componentType !== 'string' || !KNOWN_TYPES.has(componentType as ComponentType))
      return {
        ok: false,
        error: `Node "${id}" has an unknown componentType: ${JSON.stringify(componentType)}. Expected one of ${[...KNOWN_TYPES].join(', ')}.`,
      }
    const type = componentType as ComponentType

    const position = isObject(candidate.position) ? candidate.position : undefined
    nodes.push({
      id,
      type: 'systemNode',
      // Laid out in a row when the paste omits positions, rather than piling
      // every node on the origin.
      position: {
        x: typeof position?.x === 'number' ? position.x : index * 280,
        y: typeof position?.y === 'number' ? position.y : 120,
      },
      data: {
        componentType: type,
        label: typeof data.label === 'string' ? data.label : type,
        // Merged over defaults so a partial settings object still loads.
        settings: {
          ...DEFAULT_SETTINGS[type],
          ...(isObject(data.settings) ? data.settings : {}),
        },
      } as SystemNodeData,
    } as Node)
  }

  const ids = new Set(nodes.map((n) => n.id))
  if (ids.size !== nodes.length)
    return { ok: false, error: 'Two nodes share the same id.' }

  const edges: Edge[] = []
  for (const [index, candidate] of parsed.edges.entries()) {
    if (!isObject(candidate))
      return { ok: false, error: `Edge ${index} is not an object.` }
    const { source, target } = candidate
    if (typeof source !== 'string' || typeof target !== 'string')
      return { ok: false, error: `Edge ${index} needs string "source" and "target".` }
    if (!ids.has(source))
      return { ok: false, error: `Edge ${index} points at an unknown source "${source}".` }
    if (!ids.has(target))
      return { ok: false, error: `Edge ${index} points at an unknown target "${target}".` }

    edges.push({
      id: typeof candidate.id === 'string' ? candidate.id : `${source}-${target}`,
      source,
      target,
      sourceHandle:
        typeof candidate.sourceHandle === 'string' ? candidate.sourceHandle : 'right',
      targetHandle:
        typeof candidate.targetHandle === 'string' ? candidate.targetHandle : 'left',
      type: 'requestEdge',
      style: { stroke: '#94a3b8', strokeWidth: 2 },
      markerEnd: { type: 'arrowclosed', color: '#94a3b8' },
    } as unknown as Edge)
  }

  // Anything else in the paste — logEntries, metricSamples, exportedAt — is
  // deliberately dropped rather than treated as an error.
  const ignoredKeys = Object.keys(parsed).filter(
    (key) => key !== 'nodes' && key !== 'edges',
  )

  return { ok: true, nodes, edges, ignoredKeys }
}

/* ------------------------------------------------------------------ *
 * Filtering
 * ------------------------------------------------------------------ */

export type LogFilters = {
  outcomes: { success: boolean; failed: boolean; in_progress: boolean }
  methods: { GET: boolean; POST: boolean }
  cache: { hit: boolean; miss: boolean; not_applicable: boolean }
  freshness: { fresh: boolean; stale: boolean; not_applicable: boolean }
  /** Exact match. Blank means no filter. */
  resourceKey: string
  /** Node id, or '' for any. */
  servedByNodeId: string
  /** Only entries started within the last N seconds. Null for no limit. */
  lastSeconds: number | null
  /** Cap on how many of the most recent matches to include. Null for no cap. */
  maxEntries: number | null
}

/** Everything on, nothing restricted: an export identical to the old one. */
export const DEFAULT_FILTERS: LogFilters = {
  outcomes: { success: true, failed: true, in_progress: true },
  methods: { GET: true, POST: true },
  cache: { hit: true, miss: true, not_applicable: true },
  freshness: { fresh: true, stale: true, not_applicable: true },
  resourceKey: '',
  servedByNodeId: '',
  lastSeconds: null,
  maxEntries: null,
}

export const isDefaultFilters = (f: LogFilters) =>
  JSON.stringify(f) === JSON.stringify(DEFAULT_FILTERS)

/** Null cache/freshness values are treated as "not applicable". */
const cacheKeyOf = (v: CacheResult | null) => v ?? 'not_applicable'
const freshnessKeyOf = (v: ReadFreshness | null) => v ?? 'not_applicable'

export function filterLogs(
  logs: LogEntry[],
  filters: LogFilters,
  now: number = Date.now(),
): LogEntry[] {
  const cutoff =
    filters.lastSeconds === null ? null : now - filters.lastSeconds * 1000

  const matched = logs.filter((entry) => {
    if (!filters.outcomes[entry.outcome]) return false
    if (!filters.methods[entry.method]) return false
    if (!filters.cache[cacheKeyOf(entry.cacheResult)]) return false
    if (!filters.freshness[freshnessKeyOf(entry.readFreshness)]) return false
    if (filters.resourceKey !== '' && entry.resourceKey !== filters.resourceKey)
      return false
    if (
      filters.servedByNodeId !== '' &&
      entry.servedByNodeId !== filters.servedByNodeId
    )
      return false
    if (cutoff !== null && entry.startedAt < cutoff) return false
    return true
  })

  // The store keeps logs newest-first, so the most recent N is the head.
  return filters.maxEntries === null ? matched : matched.slice(0, filters.maxEntries)
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

export type FilteredExport = {
  appliedFilters: LogFilters
  matchedCount: number
  totalLogStoreCount: number
  exportedAt: string
  nodes: ExportedNode[]
  edges: ExportedEdge[]
  logEntries: LogEntry[]
}

export function buildFilteredExport(
  state: { nodes: Node[]; edges: Edge[]; logs: LogEntry[] },
  filters: LogFilters,
  now: number = Date.now(),
): FilteredExport {
  const entries = filterLogs(state.logs, filters, now)
  // Reuses the existing exporter for the canvas half, so an unfiltered export
  // stays byte-identical to what the old button produced.
  const base = buildSessionExport({ ...state, metrics: [] })
  return {
    appliedFilters: filters,
    matchedCount: entries.length,
    totalLogStoreCount: state.logs.length,
    exportedAt: new Date(now).toISOString(),
    nodes: base.nodes,
    edges: base.edges,
    logEntries: entries,
  }
}

export function filteredFilename(date = new Date()) {
  const stamp = date.toISOString().slice(0, 19).replace(/:/g, '-')
  return `paperdraw-logs-${stamp}.json`
}
