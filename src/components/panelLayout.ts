/**
 * Shared dock geometry. Every panel measures itself against these so the
 * control bar can position itself around whatever is open, rather than
 * guessing and overlapping.
 */

/** Component palette, pinned to the left edge. */
export const SIDEBAR_WIDTH = 220

/** Problem Brief and node Settings share one width. */
export const SIDE_PANEL_WIDTH = 300

/**
 * The three metric panels stack: the log drawer sits on the floor, and the
 * Health/Latency band rides above it, splitting left/right when both are open.
 * Kept tighter than a comfortable reading height on purpose — all three open
 * at once still has to leave a usable canvas on a 768px screen.
 */
export const LOG_PANEL_HEIGHT = 252
export const METRICS_BAND_HEIGHT = 168

/** Total vertical space the metric stack occupies right now. */
export function dockHeight(open: {
  isLogOpen: boolean
  isHealthOpen: boolean
  isLatencyOpen: boolean
}) {
  return (
    (open.isLogOpen ? LOG_PANEL_HEIGHT : 0) +
    (open.isHealthOpen || open.isLatencyOpen ? METRICS_BAND_HEIGHT : 0)
  )
}
