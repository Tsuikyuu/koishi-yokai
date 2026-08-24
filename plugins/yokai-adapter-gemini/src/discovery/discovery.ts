import {
  type AdapterId,
  type AdapterInvocationError,
  type AdapterModelSnapshot,
} from '@yokai/protocol'
import {
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Schedule,
  Semaphore,
} from 'effect'

import { GeminiConnection } from '../connection/connection'
import { decodeListing, markStale } from './model'

export interface Interface {
  readonly adapterId: AdapterId
  readonly discoverModels: () => Effect.Effect<AdapterModelSnapshot, AdapterInvocationError>
  readonly currentSnapshot: () => Effect.Effect<Option.Option<AdapterModelSnapshot>>
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/koishi-plugin-yokai-adapter-gemini/ModelDiscovery',
) {}

const isBackgroundRetryable = (error: AdapterInvocationError): boolean => {
  if (error._tag === 'AdapterRateLimitError') return true
  if (error._tag !== 'AdapterProviderResponseError') return false
  return error.statusCode === 500 || error.statusCode === 502 || error.statusCode === 503
}

const backgroundRetrySchedule = (connection: GeminiConnection.Interface) =>
  Schedule.exponential(
    Duration.millis(connection.discoveryRetry.initialDelayMs),
    connection.discoveryRetry.backoffMultiplier,
  ).pipe(
    Schedule.modifyDelay(({ duration }) =>
      Effect.succeed(Duration.min(duration, Duration.millis(connection.discoveryRetry.maxDelayMs))),
    ),
    Schedule.upTo({ times: connection.discoveryRetry.maxAttempts - 1 }),
  )

const make = Effect.fn('GeminiModelDiscovery.make')(function* () {
  const connection = yield* GeminiConnection.Service
  const current = yield* Ref.make(Option.none<AdapterModelSnapshot>())
  const refreshGate = yield* Semaphore.make(1)

  const refresh = Effect.fn('GeminiModelDiscovery.refresh')(function* () {
    const snapshot = yield* connection.listModels((listing) =>
      DateTime.now.pipe(
        Effect.flatMap((discoveredAt) =>
          decodeListing(connection.adapterId, listing.models, discoveredAt),
        ),
      ),
    )
    yield* Ref.set(current, Option.some(snapshot))
    return snapshot
  })

  const retainStale = Effect.fn('GeminiModelDiscovery.retainStale')(function* (
    error: AdapterInvocationError,
  ) {
    const previous = yield* Ref.get(current)
    if (Option.isNone(previous)) return yield* Effect.fail(error)

    const discoveredAt = yield* DateTime.now
    const stale = markStale(previous.value, discoveredAt)
    yield* Ref.set(current, Option.some(stale))
    return stale
  })

  const discoverModels = Effect.fn('GeminiModelDiscovery.discoverModels')(function* () {
    return yield* refreshGate.withPermits(1)(
      refresh().pipe(
        Effect.matchEffect({
          onFailure: retainStale,
          onSuccess: Effect.succeed,
        }),
      ),
    )
  })

  return Service.of({
    adapterId: connection.adapterId,
    discoverModels,
    currentSnapshot: Effect.fn('GeminiModelDiscovery.currentSnapshot')(function* () {
      return yield* Ref.get(current)
    }),
  })
})

const startBackgroundDiscovery = Effect.fn('GeminiModelDiscovery.startBackgroundDiscovery')(
  function* (service: Interface) {
    const connection = yield* GeminiConnection.Service
    yield* service.discoverModels().pipe(
      Effect.retry({
        schedule: backgroundRetrySchedule(connection),
        while: isBackgroundRetryable,
      }),
      Effect.ignore,
      Effect.forkScoped,
    )
  },
)

const makeHostManaged = Effect.fn('GeminiModelDiscovery.makeHostManaged')(function* () {
  const service = yield* make()
  const connection = yield* GeminiConnection.Service
  const initialRefresh = yield* Ref.make(true)

  return Service.of({
    ...service,
    discoverModels: Effect.fn('GeminiModelDiscovery.discoverHostManagedModels')(function* () {
      const initial = yield* Ref.getAndSet(initialRefresh, false)
      return yield* initial
        ? service.discoverModels().pipe(
            Effect.retry({
              schedule: backgroundRetrySchedule(connection),
              while: isBackgroundRetryable,
            }),
          )
        : service.discoverModels()
    }),
  })
})

/** Deterministic injection seam for tests that need to control the first refresh. */
export const layerWithoutStartup = Layer.effect(Service, make())

/** The host triggers the first refresh; only that initial background refresh receives retries. */
export const layerForHost = Layer.effect(Service, makeHostManaged())

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const service = yield* make()
    yield* startBackgroundDiscovery(service)
    return service
  }),
)

export * as GeminiModelDiscovery from './discovery'
