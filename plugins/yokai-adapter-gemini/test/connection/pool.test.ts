import { ApiError, type Model, type Pager } from '@google/genai'
import { expect, it } from '@effect/vitest'
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  HashMap,
  Layer,
  Option,
  Ref,
  Scope,
} from 'effect'
import { inspect } from 'node:util'

import { GeminiClientFactory } from '../../src/client/client-factory.js'
import { GeminiConfiguration } from '../../src/config/configuration.js'
import { GeminiConnectionPool } from '../../src/connection/pool.js'

const API_KEY_CANARY = 'gemini-pool-api-key-canary'
const SDK_ERROR_CANARY = 'gemini-pool-sdk-error-canary'

type PluginConfiguration = Parameters<typeof GeminiConfiguration.layer>[0]
type Counts = Ref.Ref<HashMap.HashMap<string, number>>

const makeConnectionInput = (connectionId: string) => ({
  connectionId,
  displayName: `${connectionId} display name`,
  apiKey: API_KEY_CANARY,
  baseUrl: 'https://generativelanguage.googleapis.com/',
  requestTimeoutMs: 60_000,
  discoveryRetry: {
    maxAttempts: 3,
    initialDelayMs: 1_000,
    maxDelayMs: 10_000,
    backoffMultiplier: 2,
  },
})

const makeConfiguration = (...connectionIds: ReadonlyArray<string>): PluginConfiguration => ({
  connections: connectionIds.map(makeConnectionInput),
})

const countAt = (counts: HashMap.HashMap<string, number>, key: string): number => {
  const count = HashMap.get(counts, key)
  return Option.isNone(count) ? 0 : count.value
}

const increment = (counts: Counts, key: string) =>
  Ref.update(counts, (current) => HashMap.set(current, key, countAt(current, key) + 1))

const makeTrackedClientFactory = (
  created: Counts,
  finalized: Counts,
  clientFor: (connection: GeminiConfiguration.Connection) => GeminiClientFactory.Client,
): GeminiClientFactory.Interface =>
  GeminiClientFactory.Service.of({
    create: Effect.fn('GeminiConnectionPoolTest.ClientFactory.create')(function* (
      connection: GeminiConfiguration.Connection,
    ) {
      yield* increment(created, connection.connectionId)
      yield* Effect.addFinalizer(() => increment(finalized, connection.connectionId))
      return clientFor(connection)
    }),
  })

const makePoolLayer = (
  configuration: PluginConfiguration,
  clientFactory: GeminiClientFactory.Interface,
) =>
  GeminiConnectionPool.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        GeminiConfiguration.layer(configuration),
        Layer.succeed(GeminiClientFactory.Service, clientFactory),
      ),
    ),
  )

const makeRejectedClient = (error: Error): GeminiClientFactory.Client => ({
  listModels: () => Promise.reject<Pager<Model>>(error),
})

const makePendingClient = (
  started: Deferred.Deferred<AbortSignal>,
): GeminiClientFactory.Client => ({
  listModels: (_params, signal) => {
    Deferred.doneUnsafe(started, Effect.succeed(signal))
    return new Promise<Pager<Model>>(() => undefined)
  },
})

const findConnectionId = (
  pool: GeminiConnectionPool.Interface,
  configuredId: string,
): Effect.Effect<GeminiConfiguration.ConnectionId> => {
  const summary = pool.summaries.find((candidate) => candidate.connectionId === configuredId)
  return summary === undefined
    ? Effect.die(`Expected connection ${configuredId}`)
    : Effect.succeed(summary.connectionId)
}

const expectInterrupted = <A, E>(exit: Exit.Exit<A, E>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isSuccess(exit)) return
  expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
}

const namedError = (name: string) => {
  const error = new Error(`${SDK_ERROR_CANARY}:${API_KEY_CANARY}`)
  error.name = name
  return error
}

it.effect('does not invoke the client factory when the whole configuration is invalid', () =>
  Effect.gen(function* () {
    const created = yield* Ref.make(HashMap.empty<string, number>())
    const finalized = yield* Ref.make(HashMap.empty<string, number>())
    const clientFactory = makeTrackedClientFactory(created, finalized, () =>
      makeRejectedClient(new Error('Unexpected client invocation')),
    )

    const exit = yield* Effect.exit(
      GeminiConnectionPool.Service.pipe(
        Effect.provide(makePoolLayer({ connections: [] }, clientFactory)),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    const error = Cause.findErrorOption(exit.cause)
    expect(Option.isSome(error)).toBe(true)
    if (Option.isSome(error)) expect(error.value._tag).toBe('GeminiConfigurationError')
    expect(HashMap.size(yield* Ref.get(created))).toBe(0)
    expect(HashMap.size(yield* Ref.get(finalized))).toBe(0)
  }),
)

it.effect('constructs each configured connection exactly once', () =>
  Effect.gen(function* () {
    const created = yield* Ref.make(HashMap.empty<string, number>())
    const finalized = yield* Ref.make(HashMap.empty<string, number>())
    const clientFactory = makeTrackedClientFactory(created, finalized, () =>
      makeRejectedClient(new Error('Unexpected listModels invocation')),
    )

    const summaries = yield* Effect.gen(function* () {
      const first = yield* GeminiConnectionPool.Service
      const second = yield* GeminiConnectionPool.Service
      expect(first).toBe(second)
      return first.summaries
    }).pipe(
      Effect.provide(
        makePoolLayer(makeConfiguration('connection-a', 'connection-b'), clientFactory),
      ),
    )

    const snapshot = yield* Ref.get(created)
    expect(summaries.map((summary) => summary.connectionId)).toEqual([
      'connection-a',
      'connection-b',
    ])
    expect(HashMap.size(snapshot)).toBe(2)
    expect(countAt(snapshot, 'connection-a')).toBe(1)
    expect(countAt(snapshot, 'connection-b')).toBe(1)
  }),
)

it.effect('closing one connection interrupts only its pending requests', () =>
  Effect.gen(function* () {
    const created = yield* Ref.make(HashMap.empty<string, number>())
    const finalized = yield* Ref.make(HashMap.empty<string, number>())
    const startedA = yield* Deferred.make<AbortSignal>()
    const startedB = yield* Deferred.make<AbortSignal>()
    const finishedA = yield* Deferred.make<void>()
    const finishedB = yield* Deferred.make<void>()
    const clientFactory = makeTrackedClientFactory(created, finalized, (connection) =>
      connection.connectionId === 'connection-a'
        ? makePendingClient(startedA)
        : makePendingClient(startedB),
    )

    yield* Effect.gen(function* () {
      const pool = yield* GeminiConnectionPool.Service
      const connectionA = yield* findConnectionId(pool, 'connection-a')
      const connectionB = yield* findConnectionId(pool, 'connection-b')
      const fiberA = yield* Effect.forkChild(
        pool
          .listModels(connectionA, {})
          .pipe(Effect.onExit(() => Deferred.succeed(finishedA, undefined))),
      )
      const fiberB = yield* Effect.forkChild(
        pool
          .listModels(connectionB, {})
          .pipe(Effect.onExit(() => Deferred.succeed(finishedB, undefined))),
      )
      const signalA = yield* Deferred.await(startedA)
      const signalB = yield* Deferred.await(startedB)

      expect(signalA.aborted).toBe(false)
      expect(signalB.aborted).toBe(false)
      expect(yield* pool.close(connectionA)).toBe(true)

      const exitA = yield* Fiber.await(fiberA)
      expectInterrupted(exitA)
      expect(signalA.aborted).toBe(true)
      expect(yield* Deferred.isDone(finishedA)).toBe(true)
      expect(signalB.aborted).toBe(false)
      expect(yield* Deferred.isDone(finishedB)).toBe(false)
      expect(yield* pool.close(connectionA)).toBe(false)

      expect(yield* pool.close(connectionB)).toBe(true)
      const exitB = yield* Fiber.await(fiberB)
      expectInterrupted(exitB)
      expect(signalB.aborted).toBe(true)
      expect(yield* Deferred.isDone(finishedB)).toBe(true)
    }).pipe(
      Effect.provide(
        makePoolLayer(makeConfiguration('connection-a', 'connection-b'), clientFactory),
      ),
    )

    const finalizerSnapshot = yield* Ref.get(finalized)
    expect(countAt(finalizerSnapshot, 'connection-a')).toBe(1)
    expect(countAt(finalizerSnapshot, 'connection-b')).toBe(1)
  }),
)

it.effect('closing the parent layer scope interrupts every request and runs every finalizer', () =>
  Effect.gen(function* () {
    const created = yield* Ref.make(HashMap.empty<string, number>())
    const finalized = yield* Ref.make(HashMap.empty<string, number>())
    const startedA = yield* Deferred.make<AbortSignal>()
    const startedB = yield* Deferred.make<AbortSignal>()
    const clientFactory = makeTrackedClientFactory(created, finalized, (connection) =>
      connection.connectionId === 'connection-a'
        ? makePendingClient(startedA)
        : makePendingClient(startedB),
    )
    const parentScope = yield* Scope.make()
    const context = yield* Layer.buildWithScope(
      makePoolLayer(makeConfiguration('connection-a', 'connection-b'), clientFactory),
      parentScope,
    )
    const pool = Context.get(context, GeminiConnectionPool.Service)
    const connectionA = yield* findConnectionId(pool, 'connection-a')
    const connectionB = yield* findConnectionId(pool, 'connection-b')
    const fiberA = yield* Effect.forkChild(pool.listModels(connectionA, {}))
    const fiberB = yield* Effect.forkChild(pool.listModels(connectionB, {}))
    const signalA = yield* Deferred.await(startedA)
    const signalB = yield* Deferred.await(startedB)

    yield* Scope.close(parentScope, Exit.void)

    expectInterrupted(yield* Fiber.await(fiberA))
    expectInterrupted(yield* Fiber.await(fiberB))
    expect(signalA.aborted).toBe(true)
    expect(signalB.aborted).toBe(true)

    const createdSnapshot = yield* Ref.get(created)
    const finalizerSnapshot = yield* Ref.get(finalized)
    expect(countAt(createdSnapshot, 'connection-a')).toBe(1)
    expect(countAt(createdSnapshot, 'connection-b')).toBe(1)
    expect(countAt(finalizerSnapshot, 'connection-a')).toBe(1)
    expect(countAt(finalizerSnapshot, 'connection-b')).toBe(1)
  }),
)

it.effect('classifies SDK failures without exposing provider or API-key canaries', () => {
  const scenarios = [
    {
      error: new ApiError({
        status: 401,
        message: `${SDK_ERROR_CANARY}:${API_KEY_CANARY}`,
      }),
      expectedTag: 'AdapterAuthenticationError',
      expectedMessage: 'Gemini authentication failed',
    },
    {
      error: new ApiError({
        status: 429,
        message: `${SDK_ERROR_CANARY}:${API_KEY_CANARY}`,
      }),
      expectedTag: 'AdapterRateLimitError',
      expectedMessage: 'Gemini model discovery was rate limited',
    },
    {
      error: new ApiError({
        status: 500,
        message: `${SDK_ERROR_CANARY}:${API_KEY_CANARY}`,
      }),
      expectedTag: 'AdapterProviderResponseError',
      expectedMessage: 'Gemini rejected the model discovery request',
    },
    {
      error: new ApiError({
        status: 499,
        message: `${SDK_ERROR_CANARY}:${API_KEY_CANARY}`,
      }),
      expectedTag: 'AdapterCancelledError',
      expectedMessage: 'Gemini model discovery was cancelled',
    },
    {
      error: new TypeError(`${SDK_ERROR_CANARY}:${API_KEY_CANARY}`),
      expectedTag: 'AdapterTransportError',
      expectedMessage: 'Unable to reach the Gemini model service',
    },
    {
      error: namedError('AbortError'),
      expectedTag: 'AdapterTimeoutError',
      expectedMessage: 'Gemini model discovery timed out',
    },
  ]

  return Effect.forEach(scenarios, (scenario) =>
    Effect.gen(function* () {
      const created = yield* Ref.make(HashMap.empty<string, number>())
      const finalized = yield* Ref.make(HashMap.empty<string, number>())
      const clientFactory = makeTrackedClientFactory(created, finalized, () =>
        makeRejectedClient(scenario.error),
      )

      const exit = yield* Effect.gen(function* () {
        const pool = yield* GeminiConnectionPool.Service
        const connectionId = yield* findConnectionId(pool, 'connection-a')
        return yield* Effect.exit(pool.listModels(connectionId, {}))
      }).pipe(Effect.provide(makePoolLayer(makeConfiguration('connection-a'), clientFactory)))

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      const failure = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(failure)).toBe(true)
      if (Option.isNone(failure)) return
      const error = failure.value

      expect(error._tag).toBe(scenario.expectedTag)
      expect(error.message).toBe(scenario.expectedMessage)
      if (error._tag === 'AdapterProviderResponseError') expect(error.statusCode).toBe(500)

      const surfaces = [
        error.message,
        String(error),
        String(JSON.stringify(error)),
        inspect(error),
        String(JSON.stringify(exit)),
        inspect(exit),
        Cause.pretty(exit.cause),
        String(Cause.squash(exit.cause)),
      ]
      for (const surface of surfaces) {
        expect(surface).not.toContain(API_KEY_CANARY)
        expect(surface).not.toContain(SDK_ERROR_CANARY)
      }
    }),
  )
})
