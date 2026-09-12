/**
 * Run with `npm test`.
 *
 * Drives the real store end to end and asserts that the latency it reports is
 * the latency the node settings describe. Reported duration used to be wall
 * clock across a dozen setTimeout hops, so the same design measured a
 * different number on every run and drifted upward under load.
 */
import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import {
  clearAllTimers,
  DEFAULT_SETTINGS,
  useFlowStore,
  type ComponentType,
} from '../src/store'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let seq = 0
function place(type: ComponentType): string {
  seq += 1
  const before = new Set(useFlowStore.getState().nodes.map((n) => n.id))
  useFlowStore.getState().addNode(type, { x: seq * 200, y: 0 })
  const added = useFlowStore.getState().nodes.find((n) => !before.has(n.id))
  assert.ok(added, `addNode did not create a ${type}`)
  return added.id
}

function wire(source: string, target: string) {
  useFlowStore.getState().onConnect({
    source,
    target,
    sourceHandle: null,
    targetHandle: null,
  })
}

function reset() {
  clearAllTimers()
  useFlowStore.getState().clearAll()
}

/** Fires one request and resolves with the duration the panel would show. */
async function fireOnce(clientId: string, budgetMs: number): Promise<number> {
  const seen = useFlowStore.getState().metrics.length
  useFlowStore.getState().fireRequest(clientId)
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const { metrics } = useFlowStore.getState()
    if (metrics.length > seen) {
      const latest = metrics[metrics.length - 1]
      assert.equal(latest.outcome, 'success', 'request did not succeed')
      return latest.d
    }
    await sleep(10)
  }
  throw new Error('request never completed')
}

describe('reported latency is the modelled latency', () => {
  before(() => reset())

  it('a client -> server -> database GET costs exactly what the settings say', async () => {
    reset()
    const client = place('client')
    const server = place('server')
    const database = place('database')
    wire(client, server)
    wire(server, database)

    const store = useFlowStore.getState()
    // Small numbers so the suite stays quick; the arithmetic is the point.
    store.updateNodeSettings(server, {
      networkLatencyMs: 40,
      baseProcessingMs: 30,
      concurrencyLimit: 5,
    })
    store.updateNodeSettings(database, {
      networkLatencyMs: 15,
      readLatencyMs: 50,
      concurrencyLimit: 5,
    })

    const d = await fireOnce(client, 4000)

    // client -> server, server thinks, server -> db, db reads, db -> server,
    // server -> client. Both database legs cost the database's own network
    // latency, which used to be a fixed constant.
    const expected = 40 + 30 + 15 + 50 + 15 + 40
    assert.equal(
      d,
      expected,
      `reported ${d}ms, settings add up to ${expected}ms`,
    )
  })

  it('reports the identical number every time, with no scheduler drift', async () => {
    reset()
    const client = place('client')
    const server = place('server')
    const database = place('database')
    wire(client, server)
    wire(server, database)

    const store = useFlowStore.getState()
    store.updateNodeSettings(server, {
      networkLatencyMs: 20,
      baseProcessingMs: 20,
      concurrencyLimit: 5,
    })
    store.updateNodeSettings(database, { readLatencyMs: 20, concurrencyLimit: 5 })

    const runs: number[] = []
    for (let i = 0; i < 12; i += 1) runs.push(await fireOnce(client, 4000))

    const unique = [...new Set(runs)]
    assert.equal(
      unique.length,
      1,
      `same design reported ${unique.length} different latencies: ${unique.join(', ')}`,
    )
  })

  it('stays identical when many requests are in flight at once', async () => {
    reset()
    const client = place('client')
    const server = place('server')
    const database = place('database')
    wire(client, server)
    wire(server, database)

    const store = useFlowStore.getState()
    // Wide enough that nothing queues: every request should be independent,
    // so concurrency must not change any of their reported latencies.
    store.updateNodeSettings(server, {
      networkLatencyMs: 20,
      baseProcessingMs: 20,
      concurrencyLimit: 50,
      maxQueueDepth: 50,
    })
    store.updateNodeSettings(database, {
      readLatencyMs: 20,
      concurrencyLimit: 50,
      maxQueueDepth: 50,
    })

    const seen = useFlowStore.getState().metrics.length
    for (let i = 0; i < 25; i += 1) useFlowStore.getState().fireRequest(client)

    const deadline = Date.now() + 6000
    while (
      useFlowStore.getState().metrics.length - seen < 25 &&
      Date.now() < deadline
    ) {
      await sleep(20)
    }

    const produced = useFlowStore.getState().metrics.slice(seen)
    assert.equal(produced.length, 25, 'not every request finished')
    assert.ok(
      produced.every((m) => m.outcome === 'success'),
      'some requests failed',
    )

    const unique = [...new Set(produced.map((m) => m.d))]
    assert.equal(
      unique.length,
      1,
      `25 concurrent identical requests reported ${unique.length} latencies: ${unique.join(', ')}`,
    )
  })

  it('prices a cached read and an uncached read from the settings alone', async () => {
    // The topology from a reported session: client -> server, server -> cache,
    // server -> database, cache-aside. A hit and a miss should each cost one
    // fixed, explainable number.
    reset()
    const client = place('client')
    const server = place('server')
    const database = place('database')
    const cache = place('cache')
    wire(client, server)
    wire(server, database)
    wire(server, cache)

    const store = useFlowStore.getState()
    store.updateNodeSettings(client, { resourceKeyCount: 1 })
    store.updateNodeSettings(server, {
      networkLatencyMs: 20,
      baseProcessingMs: 30,
      concurrencyLimit: 3,
    })
    store.updateNodeSettings(database, {
      networkLatencyMs: 150,
      readLatencyMs: 600,
      concurrencyLimit: 2,
    })
    store.updateNodeSettings(cache, {
      hitLatencyMs: 100,
      ttlSeconds: 30,
      writePolicy: 'cache-aside',
    })

    // 20 out + 30 think + 10 to cache + 40 miss + 10 back + 150 to db +
    // 600 read + 150 back + 10 to cache + 60 write + 10 back + 20 home.
    const miss = await fireOnce(client, 6000)
    assert.equal(miss, 1110, `cache miss reported ${miss}ms`)

    // 20 out + 30 think + 10 to cache + 100 lookup + 10 back + 20 home.
    const hit = await fireOnce(client, 6000)
    assert.equal(hit, 190, `cache hit reported ${hit}ms`)
  })

  it('prices the stock defaults, with no per-node overrides at all', async () => {
    // The regression that prompted the retune: out of the box a GET cost
    // 2500ms and the server had 1.76 req/s of capacity against a default fire
    // rate of 2/s. These two numbers pin the defaults so that cannot drift back
    // in unnoticed.
    reset()
    const client = place('client')
    const server = place('server')
    const database = place('database')
    const cache = place('cache')
    wire(client, server)
    wire(server, database)

    const d = DEFAULT_SETTINGS.database
    const s = DEFAULT_SETTINGS.server
    const expectedUncached =
      s.networkLatencyMs +
      s.baseProcessingMs +
      d.networkLatencyMs +
      d.readLatencyMs +
      d.networkLatencyMs +
      s.networkLatencyMs

    useFlowStore.getState().updateNodeSettings(client, { resourceKeyCount: 1 })
    const uncached = await fireOnce(client, 6000)
    assert.equal(uncached, expectedUncached, 'default GET without a cache')
    assert.equal(uncached, 580, 'default GET should be 580ms')

    wire(server, cache)
    await fireOnce(client, 6000) // miss, populates the cache
    const hit = await fireOnce(client, 6000)
    assert.equal(hit, 200, `default warm cache hit reported ${hit}ms`)
    assert.ok(
      uncached / hit >= 2.5,
      `caching should be a clear win, got ${(uncached / hit).toFixed(2)}x`,
    )
  })

  it('turns requests away rather than queueing when no queue is configured', async () => {
    reset()
    const client = place('client')
    const server = place('server')
    wire(client, server)

    // One worker, no queue: the second arrival has nowhere to wait.
    useFlowStore.getState().updateNodeSettings(server, {
      networkLatencyMs: 10,
      baseProcessingMs: 200,
      concurrencyLimit: 1,
      maxQueueDepth: 0,
    })

    const seen = useFlowStore.getState().metrics.length
    for (let i = 0; i < 3; i += 1) useFlowStore.getState().fireRequest(client)

    const deadline = Date.now() + 5000
    while (
      useFlowStore.getState().metrics.length - seen < 3 &&
      Date.now() < deadline
    ) {
      await sleep(20)
    }

    const produced = useFlowStore.getState().metrics.slice(seen)
    assert.equal(produced.length, 3, 'not every request resolved')
    assert.equal(
      produced.filter((m) => m.outcome === 'success').length,
      1,
      'exactly one request should have found the free worker',
    )

    // Nothing may have sat in a queue, so the two failures are immediate
    // rejections rather than timeouts.
    const failures = useFlowStore
      .getState()
      .logs.filter((l) => l.outcome === 'failed')
    assert.equal(failures.length, 2)
    for (const entry of failures) {
      assert.equal(entry.failureReason, 'server_queue_full')
      assert.ok(
        !entry.events.some((e) => e.hop === 'server_queued'),
        'a queueless server must never queue anything',
      )
    }
  })

  it('makes a deferred write compete for the database like any other write', async () => {
    // Write-back flushes used to skip database admission entirely: unlimited
    // parallelism, no queue, no way to ever drop one. That made write-back
    // free, and made a lost order impossible to demonstrate.
    reset()
    const client = place('client')
    const server = place('server')
    const database = place('database')
    const cache = place('cache')
    wire(client, server)
    wire(server, database)
    wire(server, cache)

    const store = useFlowStore.getState()
    store.updateNodeSettings(client, {
      requestMix: { getPercent: 0 },
      resourceKeyCount: 12,
    })
    store.updateNodeSettings(server, {
      networkLatencyMs: 5,
      baseProcessingMs: 5,
      concurrencyLimit: 20,
      maxQueueDepth: 20,
    })
    store.updateNodeSettings(cache, { writePolicy: 'write-back' })
    // One connection, slow writes, no queue: the backlog has nowhere to go.
    store.updateNodeSettings(database, {
      networkLatencyMs: 5,
      writeLatencyMs: 400,
      concurrencyLimit: 1,
      maxQueueDepth: 0,
    })

    for (let i = 0; i < 12; i += 1) {
      useFlowStore.getState().fireRequest(client)
      await sleep(30)
    }
    // Long enough for the 1500ms deferral plus the writes that do get through.
    await sleep(4000)

    const overwhelmed = useFlowStore.getState().writeDurability
    assert.ok(
      overwhelmed.acknowledged > 0,
      'write-back should have deferred some writes',
    )
    assert.ok(
      overwhelmed.lost > 0,
      `a single busy connection should drop deferred writes, lost=${overwhelmed.lost}`,
    )
    assert.equal(
      overwhelmed.acknowledged,
      overwhelmed.durable + overwhelmed.lost,
      'every acknowledged write must be accounted for',
    )

    // Same load, a database that can keep up: nothing may be lost.
    useFlowStore.getState().resetCounters()
    useFlowStore.getState().updateNodeSettings(database, {
      concurrencyLimit: 12,
      maxQueueDepth: 12,
    })
    for (let i = 0; i < 12; i += 1) {
      useFlowStore.getState().fireRequest(client)
      await sleep(30)
    }
    await sleep(4000)

    const roomy = useFlowStore.getState().writeDurability
    assert.ok(roomy.acknowledged > 0, 'writes should still be deferred')
    assert.equal(roomy.lost, 0, `a database with room must lose nothing, lost=${roomy.lost}`)
    assert.equal(
      Object.values(useFlowStore.getState().pendingSyncs).reduce((a, b) => a + b, 0),
      0,
      'the backlog should have drained',
    )
  })

  it('reports a lost write the same way everywhere it can be seen', async () => {
    // Three displays describe the same event: the Cache card's counter, the
    // Log panel's "write lost" badge, and the durability census the grader
    // reads. A write can be lost two ways — the database is full, or it is
    // unwired before the flush leaves — and the second used to increment the
    // counters without ever emitting the event the badge keys off, so the card
    // showed losses the log did not.
    const lostEverywhere = (cacheId: string) => {
      const state = useFlowStore.getState()
      return {
        card: state.cacheStats[cacheId]?.lostWrites ?? 0,
        badges: state.logs.filter((l) =>
          l.events.some((e) => e.hop === 'async_db_write_lost'),
        ).length,
        census: state.writeDurability.lost,
      }
    }

    const buildWriteBack = () => {
      const client = place('client')
      const server = place('server')
      const database = place('database')
      const cache = place('cache')
      wire(client, server)
      wire(server, database)
      wire(server, cache)
      const store = useFlowStore.getState()
      store.updateNodeSettings(client, {
        requestMix: { getPercent: 0 },
        resourceKeyCount: 10,
      })
      store.updateNodeSettings(cache, { writePolicy: 'write-back' })
      store.updateNodeSettings(server, {
        networkLatencyMs: 5,
        baseProcessingMs: 5,
        concurrencyLimit: 20,
      })
      return { client, database, cache }
    }

    // Path one: the database has no room for the deferred write.
    reset()
    {
      const { client, database, cache } = buildWriteBack()
      useFlowStore.getState().updateNodeSettings(database, {
        networkLatencyMs: 5,
        writeLatencyMs: 400,
        concurrencyLimit: 1,
        maxQueueDepth: 0,
      })
      for (let i = 0; i < 10; i += 1) {
        useFlowStore.getState().fireRequest(client)
        await sleep(30)
      }
      await sleep(4000)

      const seen = lostEverywhere(cache)
      assert.ok(seen.card > 0, 'a full database should have dropped a write')
      assert.equal(seen.badges, seen.card, 'log badges must match the card')
      assert.equal(seen.census, seen.card, 'the census must match the card')
    }

    // Path two: the database is removed while a flush is still deferred.
    reset()
    {
      const { client, database, cache } = buildWriteBack()
      useFlowStore.getState().updateNodeSettings(database, {
        networkLatencyMs: 5,
        writeLatencyMs: 50,
        concurrencyLimit: 20,
        maxQueueDepth: 20,
      })
      for (let i = 0; i < 6; i += 1) {
        useFlowStore.getState().fireRequest(client)
        await sleep(30)
      }
      // Answered to the client, flush scheduled, not yet sent.
      await sleep(600)
      useFlowStore.getState().deleteNode(database)
      await sleep(4000)

      const seen = lostEverywhere(cache)
      assert.ok(seen.card > 0, 'deleting the database should lose the deferred writes')
      assert.equal(seen.badges, seen.card, 'log badges must match the card')
      assert.equal(seen.census, seen.card, 'the census must match the card')
    }
  })

  it('charges real waiting time when requests queue behind a busy worker', async () => {
    reset()
    const client = place('client')
    const server = place('server')
    wire(client, server)

    const store = useFlowStore.getState()
    store.updateNodeSettings(server, {
      networkLatencyMs: 10,
      baseProcessingMs: 120,
      concurrencyLimit: 1,
      maxQueueDepth: 5,
      timeoutMs: 5000,
    })

    const seen = useFlowStore.getState().metrics.length
    for (let i = 0; i < 3; i += 1) useFlowStore.getState().fireRequest(client)

    const deadline = Date.now() + 6000
    while (
      useFlowStore.getState().metrics.length - seen < 3 &&
      Date.now() < deadline
    ) {
      await sleep(20)
    }

    const produced = useFlowStore.getState().metrics.slice(seen)
    assert.equal(produced.length, 3, 'not every request finished')
    const durations = produced.map((m) => m.d).sort((a, b) => a - b)
    const unloaded = 10 + 120 + 10

    // The first request walks straight in; the other two wait roughly one and
    // two processing slots behind it. Queue wait is measured, so allow slack.
    assert.equal(durations[0], unloaded, 'the unqueued request should be clean')
    for (const [index, expected] of [120, 240].entries()) {
      const actual = durations[index + 1] - unloaded
      assert.ok(
        Math.abs(actual - expected) < 60,
        `queued request waited ${actual}ms, expected about ${expected}ms`,
      )
    }
  })
})
