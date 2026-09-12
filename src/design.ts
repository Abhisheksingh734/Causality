/**
 * The design language, written down once.
 *
 * COLOUR — every colour in the UI means one of these things:
 *   red    failures, offline/killed nodes, stale reads
 *   amber  busy/degraded, warnings, queued state
 *   green  success, healthy, fresh reads, cache hits
 *   blue   GET requests, informational elements, primary actions
 *   orange POST requests, write operations
 *
 * Two hues sit deliberately outside that list because they identify a *tier*
 * rather than a *state*, and would otherwise fight with GET-blue on the same
 * canvas: violet for cache traffic, slate for background/system work.
 *
 * RADIUS — one step per level of nesting, never mixed within a level:
 *   rounded-xl   floating surfaces (panels, popovers, the control bar)
 *   rounded-md   things inside a surface (cards, inputs, buttons)
 *   rounded      badges
 *
 * SHADOW — floating surfaces use shadow-lg; inline cards use shadow-sm.
 * Nothing else casts a shadow.
 *
 * TYPE — text-sm surface titles · text-xs labels and buttons ·
 * text-[11px] body copy · text-[10px] meta and badges.
 */

export const SURFACE =
  'rounded-xl border border-slate-200 bg-white shadow-lg'
export const INNER_CARD =
  'rounded-md border border-slate-200 bg-white shadow-sm'

/** Packet colours on the canvas, shared by the edge renderer. */
export const PACKET = {
  get: '#2563eb',
  post: '#ea580c',
  ok: '#16a34a',
  /** Cache miss: degraded, not failed. */
  miss: '#d97706',
  /** A stale read is a correctness problem, so it reads as a failure would. */
  stale: '#dc2626',
  cache: '#7c3aed',
  system: '#64748b',
} as const
