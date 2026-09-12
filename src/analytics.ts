/**
 * PostHog analytics — entirely optional infrastructure.
 *
 * Three properties this module guarantees, because the app has to keep working
 * without it:
 *
 *   1. No key, no analytics. `VITE_POSTHOG_KEY` is read from the environment at
 *      build time; when it is absent (every local `npm run dev` by default)
 *      nothing is loaded, nothing is sent, and every `track` call is a no-op
 *      that returns immediately.
 *   2. `posthog-js` is imported dynamically, so it is in its own chunk and the
 *      module graph outside this file never depends on it. That also keeps the
 *      store importable from Node — the tests build `src/store.ts` for SSR and
 *      must not pull a browser SDK in behind it.
 *   3. A failure to load — an ad blocker, an offline user, a bad key — is
 *      swallowed. Analytics must never be able to break the canvas.
 *
 * There is deliberately no UI for any of this.
 */
import type { PostHog } from 'posthog-js'
import type { ComponentType } from './componentTypes'
// Type-only, so this does not create a runtime cycle with the store (which
// imports `track` from here).
import type { DatabaseRole, RoutingAlgorithm, WritePolicy } from './store'

/* ------------------------------------------------------------------ *
 * The event catalogue
 * ------------------------------------------------------------------ */

/** One graded criterion, flattened for the check-solution event. */
export type CriterionOutcome = { label: string; passed: boolean }

/**
 * Every event this app sends, and the properties it carries. `void` means the
 * event has no properties, and `track` then takes no second argument.
 *
 * Keeping the catalogue in one place is the point: the names here are the
 * names in PostHog, so a typo is a type error rather than a silently empty
 * chart three weeks later.
 */
type EventProperties = {
  /** Once per page load. */
  app_loaded: void
  problem_selected: { problemName: string }
  problem_baseline_recorded: { problemName: string }
  problem_check_solution: {
    problemName: string
    overallPass: boolean
    criteriaResults: CriterionOutcome[]
    /**
     * 'graded' is a real attempt. The others are the grader refusing to
     * compare — worth keeping, since a user stuck on `rps_mismatch` looks
     * identical to one who never pressed the button otherwise.
     */
    status: 'graded' | 'no_baseline' | 'rps_mismatch' | 'insufficient_samples'
  }
  node_added: { componentType: ComponentType }
  node_killed: { componentType: ComponentType }
  node_revived: { componentType: ComponentType }
  /** `rps` is only meaningful for auto-fire; a manual click has no rate. */
  simulation_started: { mode: 'manual' | 'auto_fire'; rps?: number }
  cache_write_policy_set: { policy: WritePolicy }
  database_role_set: { role: DatabaseRole }
  load_balancer_algorithm_set: {
    algorithm: RoutingAlgorithm
    healthCheckEnabled: boolean
  }
  dev_tools_import_used: void
  log_exported: {
    filtered: boolean
    entryCount: number
    method: 'download' | 'clipboard'
  }
  mobile_guard_shown: void
  mobile_guard_continue_anyway_clicked: void
}

export type AnalyticsEvent = keyof EventProperties

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

/**
 * Vite replaces `import.meta.env.VITE_*` at build time. The guard covers the
 * SSR test build, where the object exists but need not carry our keys.
 */
function readEnv(name: string): string {
  try {
    const env = import.meta.env as unknown as Record<string, string | undefined>
    const value = env?.[name]
    return typeof value === 'string' ? value.trim() : ''
  } catch {
    return ''
  }
}

const PROJECT_KEY = readEnv('VITE_POSTHOG_KEY')

/** Override for EU projects (`https://eu.i.posthog.com`) or a reverse proxy. */
const API_HOST = readEnv('VITE_POSTHOG_HOST') || 'https://us.i.posthog.com'

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

let client: PostHog | null = null
/** False the moment we know nothing will ever be sent. */
let enabled = PROJECT_KEY !== ''
let started = false

type QueuedEvent = { name: AnalyticsEvent; properties?: Record<string, unknown> }

/**
 * Events fired between `initAnalytics()` and the dynamic import resolving.
 * `app_loaded` is always one of them, so the buffer is not optional. Capped
 * because a load that never resolves must not grow without bound.
 */
let queue: QueuedEvent[] = []
const QUEUE_CAP = 50

function flush() {
  const pending = queue
  queue = []
  for (const event of pending) client?.capture(event.name, event.properties)
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Loads and initialises PostHog, once. Safe to call when no key is configured —
 * it returns without importing anything.
 */
export function initAnalytics(): void {
  if (started) return
  started = true
  if (!enabled) return

  void import('posthog-js')
    .then(({ posthog }) => {
      posthog.init(PROJECT_KEY, {
        api_host: API_HOST,
        // Opt in to the current defaults rather than the legacy ones; the
        // explicit options below still win over whatever the bundle sets.
        defaults: '2025-11-30',

        // Autocapture gives clicks and pageviews for free. The custom events
        // are what actually answer questions, but this fills in the gaps.
        autocapture: true,
        capture_pageview: 'history_change',
        capture_pageleave: true,

        // ---- privacy ----
        // No cookies, no localStorage, no sessionStorage: identity lives in
        // page memory for the life of the tab and is gone on reload. That is
        // what keeps this side of a cookie-consent banner, at the cost of a
        // reload reading as a new anonymous visitor — a trade worth making
        // here, since nothing in this app needs to follow a person over time.
        //
        // PostHog's newer server-hash `cookieless_mode: 'always'` is the other
        // way to do this, and gives better visitor counts — but it silently
        // drops every event unless "Cookieless server hash mode" is first
        // enabled in the project's settings, so it is not the safe default.
        persistence: 'memory',
        // Never call identify(), so no person profiles are ever created and
        // every event stays anonymous.
        person_profiles: 'identified_only',
        // Recording is off unless it is switched on for the project; if it ever
        // is, inputs and textareas must stay masked. This is PostHog's default
        // too — pinned here so it cannot drift, since the Dev Tools textarea
        // holds pasted JSON and the filters hold typed resource keys.
        session_recording: { maskAllInputs: true },
      })
      client = posthog
      flush()
    })
    .catch(() => {
      // Blocked, offline, or a bad chunk. Stop pretending and drop the buffer.
      enabled = false
      queue = []
      client = null
    })
}

/**
 * Sends one event, or does nothing at all when analytics is not configured.
 *
 * Events with no properties take a single argument: `track('app_loaded')`.
 */
export function track<K extends AnalyticsEvent>(
  name: K,
  ...[properties]: EventProperties[K] extends void ? [] : [EventProperties[K]]
): void {
  if (!enabled) return
  const props = properties as Record<string, unknown> | undefined
  if (client) {
    client.capture(name, props)
    return
  }
  if (queue.length < QUEUE_CAP) queue.push({ name, properties: props })
}

/** Whether anything is actually being sent. Exposed for tests, not for UI. */
export const isAnalyticsEnabled = () => enabled
