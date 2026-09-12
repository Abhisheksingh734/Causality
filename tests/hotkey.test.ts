/**
 * Run with `npm test`.
 *
 * Hot-key traffic distribution, and the stampede census the Cache card reads.
 *
 * The load-bearing claim here is the backward-compatibility one: none of the
 * three Problems that existed before this feature set hotKeyPercent, so all
 * three must select keys exactly as they always did. That is asserted two ways
 * — the distribution itself, and the settings fingerprint grading.ts keys
 * saved baselines off.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fingerprintTopology } from '../src/grading'
import { PROBLEMS } from '../src/problems'
import {
  DEFAULT_SETTINGS,
  HOT_KEY,
  STAMPEDE_THRESHOLD,
  pickResourceKey,
  stampedingKeys,
  type InFlightRequest,
  type SystemNodeData,
} from '../src/store'

/**
 * The draw is seedless, so every distribution assertion is statistical. 200k
 * samples puts the standard error on any share at or below 0.12%, which makes
 * a 1.5% tolerance about twelve sigma — tight enough to catch a real bias,
 * loose enough never to flake.
 */
const DRAWS = 200_000
const TOLERANCE = 1.5

function distribution(count: number, hotKeyPercent?: number) {
  const counts = new Map<string, number>()
  for (let i = 0; i < DRAWS; i += 1) {
    const key = pickResourceKey(count, hotKeyPercent)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return (key: string) => ((counts.get(key) ?? 0) / DRAWS) * 100
}

const clientsOf = (problemId: string) =>
  PROBLEMS.find((p) => p.id === problemId)!
    .nodes.map((n) => n.data as SystemNodeData)
    .filter((d) => d.componentType === 'client')

describe('hot-key traffic distribution', () => {
  it('is uniform when no hot-key share is configured', () => {
    for (const pool of [1, 3, 4, 5, 10]) {
      const share = distribution(pool)
      const expected = 100 / pool
      for (let i = 1; i <= pool; i += 1) {
        const actual = share(`resource-${i}`)
        assert.ok(
          Math.abs(actual - expected) < TOLERANCE,
          `pool=${pool} resource-${i} got ${actual.toFixed(2)}%, expected ${expected.toFixed(2)}%`,
        )
      }
    }
  })

  it('treats an explicit 0 exactly like an unset share', () => {
    const unset = distribution(4)
    const zero = distribution(4, 0)
    for (let i = 1; i <= 4; i += 1) {
      const key = `resource-${i}`
      assert.ok(
        Math.abs(unset(key) - zero(key)) < TOLERANCE,
        `${key}: unset ${unset(key).toFixed(2)}% vs 0 ${zero(key).toFixed(2)}%`,
      )
    }
  })

  it('hits the configured share precisely, not approximately', () => {
    // The hot key is excluded from the draw for the remaining traffic. Leaving
    // it in would put 75% of 10 keys at 77.5% — close enough to look right and
    // wrong enough to make the setting a lie.
    for (const hot of [25, 50, 75, 90]) {
      const share = distribution(10, hot)
      assert.ok(
        Math.abs(share(HOT_KEY) - hot) < TOLERANCE,
        `configured ${hot}%, observed ${share(HOT_KEY).toFixed(2)}%`,
      )
      const eachOther = (100 - hot) / 9
      for (let i = 2; i <= 10; i += 1) {
        const actual = share(`resource-${i}`)
        assert.ok(
          Math.abs(actual - eachOther) < TOLERANCE,
          `hot=${hot}% resource-${i} got ${actual.toFixed(2)}%, expected ${eachOther.toFixed(2)}%`,
        )
      }
    }
  })

  it('never starves the pool when there is nothing but a hot key', () => {
    // A one-key pool has no "remaining keys" to spread the rest over.
    const share = distribution(1, 80)
    assert.equal(share(HOT_KEY), 100)
  })

  it('leaves every pre-existing Problem on the uniform path', () => {
    for (const id of ['slow-product-page', 'vanishing-update', 'flash-sale']) {
      const clients = clientsOf(id)
      assert.ok(clients.length > 0, `${id} has no client`)
      for (const client of clients) {
        assert.equal(
          client.settings.hotKeyPercent,
          undefined,
          `${id} must not carry a hot-key share`,
        )
        const pool = client.settings.resourceKeyCount
        const share = distribution(pool, client.settings.hotKeyPercent)
        const expected = 100 / pool
        for (let i = 1; i <= pool; i += 1) {
          const actual = share(`resource-${i}`)
          assert.ok(
            Math.abs(actual - expected) < TOLERANCE,
            `${id} resource-${i} got ${actual.toFixed(2)}%, expected ${expected.toFixed(2)}%`,
          )
        }
      }
    }
  })

  it('keeps the setting out of the defaults, so fingerprints do not move', () => {
    // grading.ts stringifies a node's whole settings object to decide whether a
    // saved baseline describes the design being graded. A key present on every
    // client would change every stored fingerprint on upgrade.
    assert.ok(
      !('hotKeyPercent' in DEFAULT_SETTINGS.client),
      'hotKeyPercent must not be in DEFAULT_SETTINGS.client',
    )
    const stock = JSON.stringify(DEFAULT_SETTINGS.client)
    assert.equal(stock, '{"requestMix":{"getPercent":100},"resourceKeyCount":3}')

    for (const id of ['slow-product-page', 'vanishing-update', 'flash-sale']) {
      const problem = PROBLEMS.find((p) => p.id === id)!
      assert.ok(
        !fingerprintTopology(problem.nodes, problem.edges).includes('hotKeyPercent'),
        `${id} fingerprint must not mention hotKeyPercent`,
      )
    }
  })

  it('clears back to the pristine fingerprint when the slider returns to 0', () => {
    // The panel commits `undefined` rather than 0, and JSON.stringify drops an
    // undefined-valued key — so a client turned up and back down again is
    // indistinguishable from one nobody touched.
    const pristine = JSON.stringify(DEFAULT_SETTINGS.client)
    const turnedUp = { ...DEFAULT_SETTINGS.client, hotKeyPercent: 75 }
    const turnedBackDown = { ...turnedUp, hotKeyPercent: undefined }
    assert.notEqual(JSON.stringify(turnedUp), pristine)
    assert.equal(JSON.stringify(turnedBackDown), pristine)
  })
})

describe('The Viral Link', () => {
  const problem = PROBLEMS.find((p) => p.id === 'viral-link')

  it('ships, unscored, at the configured skew', () => {
    assert.ok(problem, 'The Viral Link should be in PROBLEMS')
    assert.equal(problem.difficulty, 'Intermediate')
    // Deliberately self-graded, like The Vanishing Update.
    assert.equal(problem.successCriteria, undefined)

    const client = clientsOf('viral-link')[0]
    assert.equal(client.settings.hotKeyPercent, 75)
    assert.equal(client.settings.resourceKeyCount, 10)
    assert.equal(client.settings.requestMix.getPercent, 100)

    const cache = problem.nodes
      .map((n) => n.data as SystemNodeData)
      .find((d) => d.componentType === 'cache')!
    assert.equal(cache.settings.writePolicy, 'cache-aside')
    assert.ok(
      cache.settings.ttlSeconds <= 5,
      `TTL must be short enough to expire inside a test window, got ${cache.settings.ttlSeconds}s`,
    )

    // No load balancer and no replica: this one stays about the cache alone.
    const types = problem.nodes.map((n) => (n.data as SystemNodeData).componentType)
    assert.ok(!types.includes('loadbalancer'))
    assert.equal(types.filter((t) => t === 'database').length, 1)
  })
})

describe('stampede census', () => {
  const request = (over: Partial<InFlightRequest>): InFlightRequest =>
    ({
      id: Math.random().toString(36).slice(2),
      sourceNodeId: 'client',
      targetNodeId: 'server',
      cacheNodeId: 'cache',
      clientEdgeId: 'e1',
      currentEdgeId: 'e1',
      legFromNodeId: 'server',
      legToNodeId: 'cache',
      phase: 'db-processing',
      method: 'GET',
      legDurationMs: 10,
      resourceKey: HOT_KEY,
      cacheOutcome: 'miss',
      kind: 'request',
      routedVia: 'direct',
      ...over,
    }) as InFlightRequest

  it('reports nothing below the threshold', () => {
    const requests = Array.from({ length: STAMPEDE_THRESHOLD - 1 }, () => request({}))
    assert.deepEqual(stampedingKeys(requests, 'cache'), [])
  })

  it('reports a key once enough requests pile onto it', () => {
    const requests = Array.from({ length: STAMPEDE_THRESHOLD }, () => request({}))
    assert.deepEqual(stampedingKeys(requests, 'cache'), [
      { key: HOT_KEY, count: STAMPEDE_THRESHOLD },
    ])
  })

  it('does not add up misses on different keys', () => {
    // Five concurrent misses spread over five keys is a cold cache, not a
    // stampede. Only same-key pile-ups are duplicated work.
    const requests = Array.from({ length: 5 }, (_, i) =>
      request({ resourceKey: `resource-${i + 1}` }),
    )
    assert.deepEqual(stampedingKeys(requests, 'cache'), [])
  })

  it('ignores hits, other caches, and the trip home', () => {
    const base = Array.from({ length: STAMPEDE_THRESHOLD }, () => request({}))
    assert.equal(stampedingKeys(base, 'cache').length, 1)

    // A hit never falls through.
    assert.deepEqual(
      stampedingKeys(
        base.map((r) => ({ ...r, cacheOutcome: 'hit' as const })),
        'cache',
      ),
      [],
    )
    // Belongs to a different cache node.
    assert.deepEqual(stampedingKeys(base, 'other-cache'), [])
    // db-inbound already has the data; the pile-up is over.
    assert.deepEqual(
      stampedingKeys(
        base.map((r) => ({ ...r, phase: 'db-inbound' as const })),
        'cache',
      ),
      [],
    )
    // The populate side trip reuses cache-inbound but is the request leaving.
    assert.deepEqual(
      stampedingKeys(
        base.map((r) => ({
          ...r,
          phase: 'cache-inbound' as const,
          cacheAction: 'populate' as const,
        })),
        'cache',
      ),
      [],
    )
  })

  it('sorts the worst offender first', () => {
    const requests = [
      ...Array.from({ length: 3 }, () => request({ resourceKey: 'resource-2' })),
      ...Array.from({ length: 6 }, () => request({ resourceKey: HOT_KEY })),
    ]
    assert.deepEqual(stampedingKeys(requests, 'cache'), [
      { key: HOT_KEY, count: 6 },
      { key: 'resource-2', count: 3 },
    ])
  })
})
