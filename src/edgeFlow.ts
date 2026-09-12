import { create } from 'zustand'
import { TRAVEL_PHASES, useFlowStore } from './store'

/**
 * Rendering-layer only. Nothing here feeds back into the simulation: it reads
 * request state, decides how an edge should be *drawn*, and stops there.
 */

/** Concurrent dots on one edge at which it switches to aggregated flow. */
export const FLOW_MODE_ENTER = 8
/** ...and the lower count at which it drops back to individual dots. The gap
 *  is deliberate: a single threshold flickers when traffic hovers on it. */
export const FLOW_MODE_EXIT = 4

export const SAMPLE_MS = 250
export const THROUGHPUT_WINDOW_MS = 2000

export type EdgeMode = 'dots' | 'flow'
export type EdgeFlow = {
  mode: EdgeMode
  concurrent: number
  /** Rounded, so tiny fluctuations do not wake every subscriber. */
  requestsPerSecond: number
}

export const EMPTY_FLOW: EdgeFlow = {
  mode: 'dots',
  concurrent: 0,
  requestsPerSecond: 0,
}

type EdgeFlowState = { edges: Record<string, EdgeFlow> }

export const useEdgeFlowStore = create<EdgeFlowState>(() => ({ edges: {} }))

export function resetEdgeFlow() {
  useEdgeFlowStore.setState({ edges: {} })
}

/**
 * Samples in-flight requests on a timer rather than subscribing, so the hot
 * simulation store never drives a render directly through this path.
 */
export function startEdgeFlowSampler(intervalMs = SAMPLE_MS) {
  let previous = new Map<string, Set<string>>()
  const completions = new Map<string, { ts: number; count: number }[]>()

  const tick = () => {
    const { requests } = useFlowStore.getState()

    const current = new Map<string, Set<string>>()
    for (const request of requests) {
      if (!TRAVEL_PHASES.includes(request.phase)) continue
      let set = current.get(request.currentEdgeId)
      if (!set) {
        set = new Set()
        current.set(request.currentEdgeId, set)
      }
      // Keyed by phase too: the same request crossing the same edge on a
      // later leg is a separate traversal.
      set.add(`${request.id}:${request.phase}`)
    }

    const now = Date.now()
    const existing = useEdgeFlowStore.getState().edges
    const next: Record<string, EdgeFlow> = {}
    const edgeIds = new Set([
      ...current.keys(),
      ...previous.keys(),
      ...Object.keys(existing),
    ])

    for (const edgeId of edgeIds) {
      const nowSet = current.get(edgeId) ?? new Set<string>()
      const wasSet = previous.get(edgeId) ?? new Set<string>()

      // A traversal that was in flight last tick and is gone now finished.
      let finished = 0
      for (const key of wasSet) if (!nowSet.has(key)) finished += 1

      const ring = completions.get(edgeId) ?? []
      if (finished > 0) ring.push({ ts: now, count: finished })
      const windowed = ring.filter((e) => now - e.ts <= THROUGHPUT_WINDOW_MS)
      completions.set(edgeId, windowed)

      const total = windowed.reduce((sum, e) => sum + e.count, 0)
      const requestsPerSecond = Math.round(
        total / (THROUGHPUT_WINDOW_MS / 1000),
      )

      const concurrent = nowSet.size
      const wasFlow = (existing[edgeId]?.mode ?? 'dots') === 'flow'
      const mode: EdgeMode = wasFlow
        ? concurrent <= FLOW_MODE_EXIT
          ? 'dots'
          : 'flow'
        : concurrent >= FLOW_MODE_ENTER
          ? 'flow'
          : 'dots'

      // Forget edges that are idle again, so this map cannot grow forever.
      if (mode === 'dots' && concurrent === 0 && windowed.length === 0) {
        completions.delete(edgeId)
        continue
      }
      next[edgeId] = { mode, concurrent, requestsPerSecond }
    }

    previous = current

    // Only publish on a real change; an unconditional write would wake every
    // edge four times a second for nothing.
    const keysA = Object.keys(existing)
    const keysB = Object.keys(next)
    let changed = keysA.length !== keysB.length
    if (!changed) {
      for (const key of keysB) {
        const a = existing[key]
        const b = next[key]
        if (
          !a ||
          a.mode !== b.mode ||
          a.concurrent !== b.concurrent ||
          a.requestsPerSecond !== b.requestsPerSecond
        ) {
          changed = true
          break
        }
      }
    }
    if (changed) useEdgeFlowStore.setState({ edges: next })
  }

  const timer = setInterval(tick, intervalMs)
  return () => clearInterval(timer)
}
