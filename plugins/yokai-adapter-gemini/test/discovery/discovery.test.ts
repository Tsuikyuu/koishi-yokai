import type { Model } from '@google/genai'
import { expect, it } from '@effect/vitest'
import {
  AdapterId,
  AdapterProviderResponseError,
  AdapterRateLimitError,
  AdapterTransportError,
  type AdapterInvocationError,
} from '@yokai/protocol'
import { Deferred, Effect, Layer, Option, Ref } from 'effect'
import { TestClock } from 'effect/testing'

import { GeminiConnection } from '../../src/connection/connection'
import { GeminiModelDiscovery } from '../../src/discovery/discovery'

const ADAPTER_ID = AdapterId.make('gemini-discovery-service-test')

const discoveryRetry = {
  maxAttempts: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 10_000,
  backoffMultiplier: 2,
}

const model = (id: string, displayName: string): Model => ({
  name: `models/${id}`,
  displayName,
  supportedActions: ['generateContent'],
})

const transportError = () =>
  new AdapterTransportError({
    adapterId: ADAPTER_ID,
    operation: 'discoverModels',
    message: 'Unable to reach the Gemini model service',
  })

const rateLimitError = () =>
  new AdapterRateLimitError({
    adapterId: ADAPTER_ID,
    operation: 'discoverModels',
    message: 'Gemini model discovery was rate limited',
  })

const providerUnavailableError = () =>
  new AdapterProviderResponseError({
    adapterId: ADAPTER_ID,
    operation: 'discoverModels',
    message: 'Gemini rejected the model discovery request',
    statusCode: 503,
  })

const makeScriptedConnection = Effect.fn('GeminiModelDiscoveryTest.makeScriptedConnection')(
  function* (
    steps: ReadonlyArray<Effect.Effect<GeminiConnection.ModelListing, AdapterInvocationError>>,
  ) {
    const remaining = yield* Ref.make(steps)
    const callCount = yield* Ref.make(0)
    const listModels = <A>(
      accept: (listing: GeminiConnection.ModelListing) => Effect.Effect<A, AdapterInvocationError>,
    ): Effect.Effect<A, AdapterInvocationError> =>
      Effect.gen(function* () {
        yield* Ref.update(callCount, (count) => count + 1)
        const step = yield* Ref.modify(remaining, (current) => [current[0], current.slice(1)])
        if (step === undefined) return yield* Effect.die('Discovery script exhausted')
        return yield* step.pipe(Effect.flatMap(accept))
      })

    return {
      connection: GeminiConnection.Service.of({
        adapterId: ADAPTER_ID,
        discoveryRetry,
        listModels,
        generateContent: () => Effect.die('Unexpected generation request in model discovery test'),
        close: Effect.fn('GeminiModelDiscoveryTest.Connection.close')(() => Effect.succeed(true)),
      }),
      callCount: Effect.fn('GeminiModelDiscoveryTest.callCount')(function* () {
        return yield* Ref.get(callCount)
      }),
    }
  },
)

const makeDiscoveryLayer = (connection: GeminiConnection.Interface, startAutomatically = false) =>
  (startAutomatically ? GeminiModelDiscovery.layer : GeminiModelDiscovery.layerWithoutStartup).pipe(
    Layer.provide(Layer.succeed(GeminiConnection.Service, connection)),
  )

it.effect('publishes fresh snapshots, retains failures as stale, and recovers atomically', () =>
  Effect.gen(function* () {
    const scripted = yield* makeScriptedConnection([
      Effect.succeed({ models: [model('first', 'First model')] }),
      Effect.fail(transportError()),
      Effect.succeed({ models: [model('second', 'Second model')] }),
    ])

    yield* Effect.gen(function* () {
      const discovery = yield* GeminiModelDiscovery.Service
      expect(Option.isNone(yield* discovery.currentSnapshot())).toBe(true)

      yield* TestClock.setTime(Date.parse('2026-08-21T08:00:00.000Z'))
      const first = yield* discovery.discoverModels()
      expect(first.models.map((entry) => entry.id)).toEqual(['first'])
      const firstModel = first.models[0]
      if (firstModel === undefined) return yield* Effect.die('Expected first discovery model')
      expect(firstModel.discoveryFreshness).toBe('fresh')

      yield* TestClock.setTime(Date.parse('2026-08-21T09:00:00.000Z'))
      const stale = yield* discovery.discoverModels()
      expect(stale.models.map((entry) => entry.id)).toEqual(['first'])
      const staleModel = stale.models[0]
      if (staleModel === undefined) return yield* Effect.die('Expected stale discovery model')
      expect(staleModel.discoveryFreshness).toBe('stale')
      expect(firstModel.discoveryFreshness).toBe('fresh')
      expect(stale.discoveredAt.epochMilliseconds).toBe(Date.parse('2026-08-21T09:00:00.000Z'))
      expect(yield* discovery.currentSnapshot()).toEqual(Option.some(stale))

      yield* TestClock.setTime(Date.parse('2026-08-21T10:00:00.000Z'))
      const recovered = yield* discovery.discoverModels()
      expect(recovered.models.map((entry) => entry.id)).toEqual(['second'])
      const recoveredModel = recovered.models[0]
      if (recoveredModel === undefined) return yield* Effect.die('Expected recovered model')
      expect(recoveredModel.discoveryFreshness).toBe('fresh')
      expect(yield* discovery.currentSnapshot()).toEqual(Option.some(recovered))
    }).pipe(Effect.provide(makeDiscoveryLayer(scripted.connection)))

    expect(yield* scripted.callCount()).toBe(3)
  }),
)

it.effect('returns the first discovery failure without inventing a default model', () =>
  Effect.gen(function* () {
    const scripted = yield* makeScriptedConnection([Effect.fail(transportError())])

    yield* Effect.gen(function* () {
      const discovery = yield* GeminiModelDiscovery.Service
      const failure = yield* discovery.discoverModels().pipe(Effect.flip)

      expect(failure._tag).toBe('AdapterTransportError')
      expect(Option.isNone(yield* discovery.currentSnapshot())).toBe(true)
    }).pipe(Effect.provide(makeDiscoveryLayer(scripted.connection)))

    expect(yield* scripted.callCount()).toBe(1)
  }),
)

it.effect('starts one background discovery when the runtime layer is acquired', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const callCount = yield* Ref.make(0)
    const listModels = <A>(
      accept: (listing: GeminiConnection.ModelListing) => Effect.Effect<A, AdapterInvocationError>,
    ): Effect.Effect<A, AdapterInvocationError> =>
      Effect.gen(function* () {
        yield* Ref.update(callCount, (count) => count + 1)
        yield* Deferred.succeed(started, undefined)
        return yield* accept({ models: [model('startup', 'Startup model')] })
      })
    const connection = GeminiConnection.Service.of({
      adapterId: ADAPTER_ID,
      discoveryRetry,
      listModels,
      generateContent: () => Effect.die('Unexpected generation request in startup discovery test'),
      close: Effect.fn('GeminiModelDiscoveryTest.StartupConnection.close')(() =>
        Effect.succeed(true),
      ),
    })

    yield* Effect.gen(function* () {
      yield* GeminiModelDiscovery.Service
      yield* Deferred.await(started)
      expect(yield* Ref.get(callCount)).toBe(1)
    }).pipe(Effect.provide(makeDiscoveryLayer(connection, true)))
  }),
)

it.effect('retries only retryable startup discovery failures with bounded exponential delays', () =>
  Effect.gen(function* () {
    const scripted = yield* makeScriptedConnection([
      Effect.fail(rateLimitError()),
      Effect.fail(providerUnavailableError()),
      Effect.succeed({ models: [model('recovered', 'Recovered model')] }),
    ])

    yield* Effect.gen(function* () {
      const discovery = yield* GeminiModelDiscovery.Service
      yield* Effect.yieldNow
      expect(yield* scripted.callCount()).toBe(1)

      yield* TestClock.adjust('999 millis')
      expect(yield* scripted.callCount()).toBe(1)
      yield* TestClock.adjust('1 millis')
      expect(yield* scripted.callCount()).toBe(2)

      yield* TestClock.adjust('1999 millis')
      expect(yield* scripted.callCount()).toBe(2)
      yield* TestClock.adjust('1 millis')
      expect(yield* scripted.callCount()).toBe(3)

      const snapshot = yield* discovery.currentSnapshot()
      expect(Option.isSome(snapshot)).toBe(true)
      if (Option.isSome(snapshot)) {
        expect(snapshot.value.models.map((entry) => entry.id)).toEqual(['recovered'])
      }
    }).pipe(Effect.provide(makeDiscoveryLayer(scripted.connection, true)))
  }),
)

it.effect('does not retry a non-retryable startup discovery failure', () =>
  Effect.gen(function* () {
    const scripted = yield* makeScriptedConnection([Effect.fail(transportError())])

    yield* Effect.gen(function* () {
      yield* GeminiModelDiscovery.Service
      yield* Effect.yieldNow
      yield* TestClock.adjust('1 minute')
      expect(yield* scripted.callCount()).toBe(1)
    }).pipe(Effect.provide(makeDiscoveryLayer(scripted.connection, true)))
  }),
)
