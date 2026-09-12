import type { Edge, Node } from '@xyflow/react'
import type { ComponentType } from './componentTypes'
import type { SuccessCriteria } from './grading'
import {
  DEFAULT_SETTINGS,
  EDGE_DEFAULTS,
  type SettingsByType,
  type SystemNodeData,
} from './store'

export type Difficulty = 'Beginner' | 'Intermediate' | 'Hard'

export type Problem = {
  id: string
  title: string
  difficulty: Difficulty
  /** One line for the dropdown. The brief below is the real content. */
  summary: string
  /** Paragraphs, rendered verbatim. Line breaks inside one are preserved. */
  brief: string[]
  /**
   * Machine-readable version of what the brief asks for. Optional: some
   * problems are read off the Log panel by hand instead of being scored.
   */
  successCriteria?: SuccessCriteria
  nodes: Node[]
  edges: Edge[]
}

const COLUMN = 280

function node<T extends ComponentType>(
  id: string,
  componentType: T,
  column: number,
  y: number,
  settings: Partial<SettingsByType[T]> = {},
  label?: string,
): Node {
  return {
    id,
    type: 'systemNode',
    position: { x: column * COLUMN, y },
    data: {
      componentType,
      label: label ?? componentType,
      settings: { ...DEFAULT_SETTINGS[componentType], ...settings },
    } as SystemNodeData,
  } as Node
}

function edge(source: string, target: string): Edge {
  return {
    id: `${source}-${target}`,
    source,
    target,
    sourceHandle: 'right',
    targetHandle: 'left',
    ...EDGE_DEFAULTS,
  }
}

export const PROBLEMS: Problem[] = [
  {
    id: 'slow-product-page',
    title: 'Fix the Slow Product Page',
    difficulty: 'Beginner',
    summary:
      'Every page load goes to the database. Make it twice as fast, without changing Server or Database settings.',
    brief: [
      'Every time someone opens a product page, the app asks the database for it. Users say the page feels slow.',
      'Step 1 — See how slow it is.\nSet the rate to 6/s and run for 20 seconds. Change nothing while it runs.\nOpen the Latency panel and write down p50. That is your starting number.',
      'Step 2 — Make it faster.\nChange the setup however you like.',
      'Step 3 — Show that it worked.\nRun at 6/s for another 20 seconds. You need p50 down to less than half your starting number, and failures at or below 2%.\nKeep the rate at 6/s. Sending less traffic is not a fix.',
      'Hint: you should not need to change any Server or Database settings to solve this.',
    ],
    successCriteria: {
      requiredRps: 6,
      minDurationSec: 20,
      criteria: [
        { type: 'p50_reduction_vs_baseline', minReductionPercent: 50 },
        { type: 'max_failure_rate', maxPercent: 2 },
      ],
    },
    nodes: [
      node('node-1', 'client', 0, 120, {
        requestMix: { getPercent: 100 },
        resourceKeyCount: 4,
      }),
      node('node-2', 'server', 1, 120, {
        concurrencyLimit: 5,
        baseProcessingMs: 20,
        maxQueueDepth: 10,
        networkLatencyMs: 30,
        timeoutMs: 3000,
      }),
      node('node-3', 'database', 2, 120, {
        networkLatencyMs: 10,
        // A slow query is the whole problem. It has to be big enough that the
        // part a cache can remove dominates the part it cannot: the client legs
        // and the server's own thinking are fixed costs no cache touches, so a
        // read that is merely a little slow caps the achievable reduction below
        // the 50% this problem asks for.
        //   baseline 30 + 20 + 10 + 300 + 10 + 30 = 400ms
        //   cached   30 + 20 + 10 +  20 + 10 + 30 = 120ms  -> 70%
        readLatencyMs: 300,
        writeLatencyMs: 600,
        concurrencyLimit: 5,
        maxQueueDepth: 10,
        timeoutMs: 3000,
      }),
    ],
    edges: [edge('node-1', 'node-2'), edge('node-2', 'node-3')],
  },
  {
    id: 'vanishing-update',
    title: 'The Vanishing Update',
    difficulty: 'Intermediate',
    summary:
      'People save a change, refresh, and see the old value. Find the race, fix it without throwing away the replica.',
    brief: [
      "Users keep filing tickets: 'I just updated my profile, but when I refresh, I still see my OLD data — did my change even save?' Support's standard reply is 'wait a few seconds and refresh again' — and that workaround always works, which is exactly why nobody's fixed the real cause yet. You've been asked to actually fix it.",
      'Step 1 — Reproduce it: run auto-fire for 20-30 seconds. Open the Log panel and filter by readFreshness = stale. You should see stale reads that happened shortly after a POST to that SAME resource key — that\'s the bug. It isn\'t a failure (the request still succeeds), it\'s just returning old data to the person who just changed it.',
      'Step 2 — Understand why: look at how long it takes for a write to actually reach the Replica versus how quickly a read for that same key can arrive afterward.',
      'Step 3 — Fix it: reconfigure the system so that a read for a key you JUST wrote to reliably comes back fresh, without giving up the Replica entirely for everything else. Re-run and confirm, via the Log panel, that stale reads immediately following a same-key write are gone (or dramatically reduced).',
      'Two traps worth knowing about before you start:\n  - Cranking the replication lag down to near-zero will make this hard to reproduce in a short test, but it doesn\'t actually fix anything — it just makes the race condition rare enough not to show up. A staff engineer would ask what happens when replication lag spikes back up under real load.\n  - Removing the Replica entirely (making the Database standalone again) also \'fixes\' this trivially, since there\'s nothing left to be stale. But that throws away the entire reason a replica existed — you\'d be giving up real read-scaling capacity to dodge the problem instead of solving it.',
    ],
    // Deliberately unscored: this one is read off the Log panel's readFreshness
    // filter rather than reduced to a pass/fail number.
    nodes: [
      node('node-1', 'client', 0, 160, {
        requestMix: { getPercent: 50 },
        resourceKeyCount: 3,
      }),
      node('node-2', 'server', 1, 160, {
        concurrencyLimit: 5,
        baseProcessingMs: 20,
        maxQueueDepth: 10,
        networkLatencyMs: 30,
        timeoutMs: 3000,
      }),
      node('node-3', 'database', 2, 160, {
        networkLatencyMs: 10,
        readLatencyMs: 50,
        writeLatencyMs: 80,
        concurrencyLimit: 5,
        maxQueueDepth: 10,
        timeoutMs: 3000,
        role: 'primary',
        // Starts off: this is the broken state the problem is about.
        readYourWritesWindowMs: 0,
      }, 'primary'),
      node('node-4', 'database', 3, 160, {
        networkLatencyMs: 10,
        readLatencyMs: 50,
        writeLatencyMs: 80,
        concurrencyLimit: 5,
        maxQueueDepth: 10,
        timeoutMs: 3000,
        role: 'replica',
        replicationLagMs: 1500,
      }, 'replica'),
    ],
    edges: [
      edge('node-1', 'node-2'),
      edge('node-2', 'node-3'),
      edge('node-3', 'node-4'),
    ],
  },
  {
    id: 'flash-sale',
    title: 'The Flash Sale',
    difficulty: 'Hard',
    summary:
      'Sale traffic, real orders, and lost sales hiding behind a perfect failure rate.',
    brief: [
      "You run the checkout for an online shop. A big sale starts in 10 minutes.\nMost of the traffic will be people looking at product pages (GET). Some of it will be people actually buying (POST). Every buy is a real order. Lose one and you lose a sale — or worse, you take someone's money and never record it.",
      'This setup is fine on a normal day. Nobody has tried it at sale traffic. Nobody has tried it with a server dying halfway through either, which has happened before.',
      'Step 1 — See how bad it is.\nSet the rate to 15/s and run for 30 seconds. Change nothing while it runs.\nThen open the Log panel and filter for POST requests.\nHeads up: you will see zero failures. That does not mean it is healthy. Every one of those orders was answered "done" — check whether the database ever actually received them.',
      'Step 2 — Redesign it.\nAdd, remove, rewire or reconfigure anything on the canvas.',
      'Step 3 — Show that it worked. Keep the rate at 15/s.\n  a) Run for 30 seconds. Every order the shop accepted must actually be stored. Not one may be lost.\n     (Going after the failure rate will not help — it was already near zero. A lost order never counted as a failure in the first place.)\n  b) Run another 30 seconds. About halfway through, switch off one Server using the power button on its card. Failures must stay under 1% for the whole run, and the Log panel should show the other server picking up the work.',
      "Worth thinking about before you change anything: what happens to someone's order if the database is busy for a moment? Does the shop say \"done\" before the order is really saved? \"It worked when I tried it\" and \"the order is safely stored\" are not the same thing.",
      'One rule: real servers cost real money. Turning every limit up to a huge number is not a fix, it is just avoiding the question.',
    ],
    successCriteria: {
      requiredRps: 15,
      minDurationSec: 30,
      criteria: [
        // Was a p99 reduction. Nothing client-visible in this design can
        // reflect database write capacity: the write-back cache answers the
        // client and defers the write, so p50, p95, p99 and even POST-only
        // percentiles are all flat whether the database has one connection or
        // six. Measured across four trials each, every windowing of latency
        // discriminated 0/3. What does move is whether the orders survive.
        { type: 'durability_check', maxPendingWrites: 10 },
        {
          type: 'kill_test_resilience',
          maxFailureRatePercent: 1,
          requiresKillEventDuringWindow: true,
        },
      ],
    },
    nodes: [
      node('node-1', 'client', 0, 160, {
        requestMix: { getPercent: 75 },
        resourceKeyCount: 5,
      }),
      node('node-2', 'loadbalancer', 1, 160, {
        routingAlgorithm: 'round_robin',
        // Deliberately off: part of the puzzle, not an oversight.
        healthCheckEnabled: false,
        networkLatencyMs: 40,
        transitLatencyMs: 50,
      }),
      node('node-3', 'server', 2, 0, {
        concurrencyLimit: 4,
        baseProcessingMs: 25,
        maxQueueDepth: 6,
        networkLatencyMs: 40,
        timeoutMs: 2000,
      }, 'server A'),
      node('node-4', 'server', 2, 320, {
        concurrencyLimit: 4,
        baseProcessingMs: 25,
        maxQueueDepth: 6,
        networkLatencyMs: 40,
        timeoutMs: 2000,
      }, 'server B'),
      node('node-5', 'cache', 3, 60, {
        // Deliberately risky for a checkout workload.
        writePolicy: 'write-back',
        ttlSeconds: 45,
        hitLatencyMs: 100,
      }),
      node('node-6', 'database', 3, 260, {
        networkLatencyMs: 10,
        readLatencyMs: 120,
        // An order is expensive to store. At 280ms this sat right on the edge
        // of the single connection's capacity, so whether writes were lost came
        // down to luck: 17 lost one run, 4 the next. At 600ms the connection is
        // decisively overwhelmed and the outcome is stable.
        writeLatencyMs: 600,
        // Intended as the bottleneck: a single connection everything queues
        // behind. Both limits are set explicitly, so this problem keeps its
        // queue whatever the defaults do.
        //
        // KNOWN ISSUE, pre-dating the default retune and measured both before
        // and after it: with only five products the cache absorbs nearly every
        // read after warm-up, so this connection is barely exercised from the
        // request path and the p99 the brief asks you to halve is mostly
        // cold-start misses, which no redesign can remove. Measured p99
        // reductions for the intended fix: 0-18% before the retune, 26-37%
        // after, against a 50% target. Widening the catalogue makes it
        // reducible, but every configuration that produces deep waiting with
        // near-zero failures sits exactly at capacity and is bistable — one
        // trial collapsed to 36% failures where the next had none. This needs a
        // design decision about the criterion, not another tuning pass.
        concurrencyLimit: 1,
        maxQueueDepth: 8,
        timeoutMs: 2500,
      }),
    ],
    edges: [
      edge('node-1', 'node-2'),
      edge('node-2', 'node-3'),
      edge('node-2', 'node-4'),
      edge('node-3', 'node-5'),
      edge('node-3', 'node-6'),
      edge('node-4', 'node-5'),
      edge('node-4', 'node-6'),
    ],
  },
]

export const problemById = (id: string | null) =>
  id === null ? undefined : PROBLEMS.find((p) => p.id === id)
