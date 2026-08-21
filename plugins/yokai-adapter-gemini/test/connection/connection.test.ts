import { ApiError, PagedItem, Pager, type ListModelsParameters, type Model } from '@google/genai'
import { expect, it } from '@effect/vitest'
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Scope,
} from 'effect'
import { TestClock } from 'effect/testing'
import { inspect } from 'node:util'

import { GeminiClientFactory } from '../../src/client/client-factory'
import { GeminiConfiguration } from '../../src/config/configuration'
import { GeminiConnection } from '../../src/connection/connection'
import { GeminiHttpTransport } from '../../src/transport/http-transport'

const API_KEY_CANARY = 'gemini-connection-api-key-canary'
const SECOND_API_KEY_CANARY = 'gemini-connection-second-api-key-canary'
const THIRD_API_KEY_CANARY = 'gemini-connection-third-api-key-canary'
const SDK_ERROR_CANARY = 'gemini-connection-sdk-error-canary'
const ADAPTER_ID = 'gemini-connection-test'
const REQUEST_TIMEOUT_MS = 12_345
const PRIMARY_URL = 'https://primary.example.com/'
const SECONDARY_URL = 'https://secondary.example.com/'
const TERTIARY_URL = 'https://tertiary.example.com/'

type PluginConfiguration = Parameters<typeof GeminiConfiguration.layer>[0]

interface EndpointInput {
  readonly apiKey: string
  readonly baseUrl: string
}

interface Creation {
  readonly baseUrl: string
}

interface SwitchScenario {
  readonly name: string
  readonly firstError: Error
  readonly secondError: Error
}

interface TerminalScenario {
  readonly name: string
  readonly error: Error
  readonly expectedTag: string
  readonly expectedStatusCode: number | undefined
}

interface PendingRequest {
  readonly baseUrl: string
  readonly resolve: (pager: Pager<Model>) => void
  readonly reject: (error: Error) => void
}

type CreationLog = Ref.Ref<ReadonlyArray<Creation>>
type FinalizationLog = Ref.Ref<ReadonlyArray<string>>

const discoveryRetry = {
  maxAttempts: 4,
  initialDelayMs: 2_000,
  maxDelayMs: 20_000,
  backoffMultiplier: 2,
}

const endpoints: ReadonlyArray<EndpointInput> = [
  { apiKey: API_KEY_CANARY, baseUrl: PRIMARY_URL },
  { apiKey: SECOND_API_KEY_CANARY, baseUrl: SECONDARY_URL },
  { apiKey: THIRD_API_KEY_CANARY, baseUrl: TERTIARY_URL },
]

const makeConfiguration = (
  configuredEndpoints: ReadonlyArray<EndpointInput>,
): PluginConfiguration => ({
  adapterId: ADAPTER_ID,
  endpoints: [...configuredEndpoints],
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  discoveryRetry,
})

const makePager = (pageToken: string | undefined, models: ReadonlyArray<Model> = []) => {
  const response =
    pageToken === undefined
      ? { models: [...models] }
      : { models: [...models], nextPageToken: pageToken }
  return new Pager<Model>(
    PagedItem.PAGED_ITEM_MODELS,
    () => Promise.resolve({ models: [] }),
    response,
    { config: {} },
  )
}

const makeTrackedClientFactory = (
  created: CreationLog,
  finalized: FinalizationLog,
  clientFor: (baseUrl: string) => GeminiClientFactory.Client,
): GeminiClientFactory.Interface =>
  GeminiClientFactory.Service.of({
    create: Effect.fn('GeminiConnectionTest.ClientFactory.create')(function* (
      endpoint: GeminiConfiguration.Endpoint,
    ) {
      const baseUrl = endpoint.baseUrl.toString()
      yield* Ref.update(created, (current) => [...current, { baseUrl }])
      yield* Effect.addFinalizer(() => Ref.update(finalized, (current) => [...current, baseUrl]))
      return clientFor(baseUrl)
    }),
  })

const makeConnectionLayer = (
  configuration: PluginConfiguration,
  clientFactory: GeminiClientFactory.Interface,
) =>
  GeminiConnection.layer.pipe(
    Layer.provide(GeminiConfiguration.layer(configuration)),
    Layer.provide(Layer.succeed(GeminiClientFactory.Service, clientFactory)),
  )

const namedError = (name: string, message: string): Error => {
  const error = new Error(message)
  error.name = name
  return error
}

const networkFailure = (code: string, message: string = SDK_ERROR_CANARY): TypeError =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error(message), { code }),
  })

const countOccurrences = (values: ReadonlyArray<string>, expected: string): number =>
  values.filter((value) => value === expected).length

const expectInterrupted = <A, E>(exit: Exit.Exit<A, E>): void => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isSuccess(exit)) return
  expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
}

it.effect('rejects empty endpoints before constructing clients', () =>
  Effect.gen(function* () {
    const created = yield* Ref.make<ReadonlyArray<Creation>>([])
    const finalized = yield* Ref.make<ReadonlyArray<string>>([])
    const clientFactory = makeTrackedClientFactory(created, finalized, () => ({
      listModels: () => Promise.reject(new Error('Unexpected Gemini client invocation')),
    }))
    const invalidConfiguration: PluginConfiguration = {
      adapterId: ADAPTER_ID,
      endpoints: [],
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      discoveryRetry,
    }

    const exit = yield* Effect.exit(
      GeminiConnection.Service.pipe(
        Effect.provide(makeConnectionLayer(invalidConfiguration, clientFactory)),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    const error = Cause.findErrorOption(exit.cause)
    expect(Option.isSome(error)).toBe(true)
    if (Option.isSome(error)) expect(error.value._tag).toBe('GeminiConfigurationError')
    expect(yield* Ref.get(created)).toEqual([])
    expect(yield* Ref.get(finalized)).toEqual([])
  }),
)

it.effect('builds one logical service and creates every endpoint once', () =>
  Effect.gen(function* () {
    const created = yield* Ref.make<ReadonlyArray<Creation>>([])
    const finalized = yield* Ref.make<ReadonlyArray<string>>([])
    const clientFactory = makeTrackedClientFactory(created, finalized, () => ({
      listModels: () => Promise.resolve(makePager(undefined)),
    }))

    yield* Effect.gen(function* () {
      const first = yield* GeminiConnection.Service
      const second = yield* GeminiConnection.Service
      const creations = yield* Ref.get(created)

      expect(first).toBe(second)
      expect(first.adapterId).toBe(ADAPTER_ID)
      expect(first.discoveryRetry).toEqual(discoveryRetry)
      expect(creations).toEqual([
        { baseUrl: PRIMARY_URL },
        { baseUrl: SECONDARY_URL },
        { baseUrl: TERTIARY_URL },
      ])
    }).pipe(Effect.provide(makeConnectionLayer(makeConfiguration(endpoints), clientFactory)))

    const finalizations = yield* Ref.get(finalized)
    expect(countOccurrences(finalizations, PRIMARY_URL)).toBe(1)
    expect(countOccurrences(finalizations, SECONDARY_URL)).toBe(1)
    expect(countOccurrences(finalizations, TERTIARY_URL)).toBe(1)
  }),
)

it.effect('uses the first successful endpoint without invoking a backup', () =>
  Effect.gen(function* () {
    const created = yield* Ref.make<ReadonlyArray<Creation>>([])
    const finalized = yield* Ref.make<ReadonlyArray<string>>([])
    const invoked: Array<string> = []
    const clientFactory = makeTrackedClientFactory(created, finalized, (baseUrl) => ({
      listModels: () => {
        invoked.push(baseUrl)
        return Promise.resolve(makePager(undefined, [{ name: 'models/gemini-primary' }]))
      },
    }))

    const listing = yield* Effect.gen(function* () {
      const connection = yield* GeminiConnection.Service
      return yield* connection.listModels()
    }).pipe(Effect.provide(makeConnectionLayer(makeConfiguration(endpoints), clientFactory)))

    expect(listing.models).toEqual([{ name: 'models/gemini-primary' }])
    expect(invoked).toEqual([PRIMARY_URL])
  }),
)

it.effect(
  'fails over in order for authentication, quota, timeout, transport, and 5xx errors',
  () => {
    const scenarios: ReadonlyArray<SwitchScenario> = [
      {
        name: '401 then 403',
        firstError: new ApiError({ status: 401, message: SDK_ERROR_CANARY }),
        secondError: new ApiError({ status: 403, message: SDK_ERROR_CANARY }),
      },
      {
        name: '402 then 429',
        firstError: new ApiError({ status: 402, message: SDK_ERROR_CANARY }),
        secondError: new ApiError({ status: 429, message: SDK_ERROR_CANARY }),
      },
      {
        name: 'timeout then transport',
        firstError: namedError('TimeoutError', SDK_ERROR_CANARY),
        secondError: networkFailure('ECONNRESET'),
      },
      {
        name: 'Koishi timeout then transport',
        firstError: new GeminiHttpTransport.TimeoutError(SDK_ERROR_CANARY),
        secondError: new GeminiHttpTransport.TransportError(SDK_ERROR_CANARY),
      },
      {
        name: '408 then 504',
        firstError: new ApiError({ status: 408, message: SDK_ERROR_CANARY }),
        secondError: new ApiError({ status: 504, message: SDK_ERROR_CANARY }),
      },
      {
        name: '500 then 503',
        firstError: new ApiError({ status: 500, message: SDK_ERROR_CANARY }),
        secondError: new ApiError({ status: 503, message: SDK_ERROR_CANARY }),
      },
    ]

    return Effect.forEach(
      scenarios,
      (scenario) =>
        Effect.gen(function* () {
          const created = yield* Ref.make<ReadonlyArray<Creation>>([])
          const finalized = yield* Ref.make<ReadonlyArray<string>>([])
          const invoked: Array<string> = []
          const failures = new Map<string, Error>([
            [PRIMARY_URL, scenario.firstError],
            [SECONDARY_URL, scenario.secondError],
          ])
          const clientFactory = makeTrackedClientFactory(created, finalized, (baseUrl) => ({
            listModels: () => {
              invoked.push(baseUrl)
              const failure = failures.get(baseUrl)
              return failure === undefined
                ? Promise.resolve(makePager(undefined))
                : Promise.reject(failure)
            },
          }))

          const listing = yield* Effect.gen(function* () {
            const connection = yield* GeminiConnection.Service
            return yield* connection.listModels()
          }).pipe(Effect.provide(makeConnectionLayer(makeConfiguration(endpoints), clientFactory)))

          expect(invoked).toEqual([PRIMARY_URL, SECONDARY_URL, TERTIARY_URL])
          expect(listing.models).toEqual([])
        }),
      { discard: true },
    )
  },
)

it.effect('applies one Effect timeout to each complete endpoint attempt', () =>
  Effect.gen(function* () {
    const created = yield* Ref.make<ReadonlyArray<Creation>>([])
    const finalized = yield* Ref.make<ReadonlyArray<string>>([])
    const started = yield* Queue.unbounded<AbortSignal>()
    const invoked: Array<string> = []
    const clientFactory = makeTrackedClientFactory(created, finalized, (baseUrl) => ({
      listModels: (_params, signal) => {
        invoked.push(baseUrl)
        if (baseUrl !== PRIMARY_URL) return Promise.resolve(makePager(undefined))
        Queue.offerUnsafe(started, signal)
        return new Promise<Pager<Model>>(() => undefined)
      },
    }))

    yield* Effect.gen(function* () {
      const connection = yield* GeminiConnection.Service
      const listingFiber = yield* Effect.forkChild(connection.listModels())
      const primarySignal = yield* Queue.take(started)

      expect(primarySignal.aborted).toBe(false)
      yield* TestClock.adjust(REQUEST_TIMEOUT_MS)
      const listing = yield* Fiber.join(listingFiber)

      expect(primarySignal.aborted).toBe(true)
      expect(invoked).toEqual([PRIMARY_URL, SECONDARY_URL])
      expect(listing.models).toEqual([])
    }).pipe(Effect.provide(makeConnectionLayer(makeConfiguration(endpoints), clientFactory)))
  }),
)

it.effect('does not fail over for ordinary 4xx, cancellation, or internal errors', () => {
  const scenarios: ReadonlyArray<TerminalScenario> = [
    {
      name: '400 response',
      error: new ApiError({ status: 400, message: SDK_ERROR_CANARY }),
      expectedTag: 'AdapterProviderResponseError',
      expectedStatusCode: 400,
    },
    {
      name: '404 response',
      error: new ApiError({ status: 404, message: SDK_ERROR_CANARY }),
      expectedTag: 'AdapterProviderResponseError',
      expectedStatusCode: 404,
    },
    {
      name: '499 cancellation',
      error: new ApiError({ status: 499, message: SDK_ERROR_CANARY }),
      expectedTag: 'AdapterCancelledError',
      expectedStatusCode: undefined,
    },
    {
      name: 'internal failure',
      error: new Error(SDK_ERROR_CANARY),
      expectedTag: 'AdapterInternalError',
      expectedStatusCode: undefined,
    },
    {
      name: 'SDK decode TypeError',
      error: new TypeError(SDK_ERROR_CANARY),
      expectedTag: 'AdapterProtocolDecodeError',
      expectedStatusCode: undefined,
    },
    {
      name: 'SDK JSON decode SyntaxError',
      error: new SyntaxError(SDK_ERROR_CANARY),
      expectedTag: 'AdapterProtocolDecodeError',
      expectedStatusCode: undefined,
    },
  ]

  return Effect.forEach(
    scenarios,
    (scenario) =>
      Effect.gen(function* () {
        const created = yield* Ref.make<ReadonlyArray<Creation>>([])
        const finalized = yield* Ref.make<ReadonlyArray<string>>([])
        const invoked: Array<string> = []
        const clientFactory = makeTrackedClientFactory(created, finalized, (baseUrl) => ({
          listModels: () => {
            invoked.push(baseUrl)
            return baseUrl === PRIMARY_URL
              ? Promise.reject(scenario.error)
              : Promise.resolve(makePager(undefined))
          },
        }))

        const failure = yield* Effect.gen(function* () {
          const connection = yield* GeminiConnection.Service
          return yield* connection.listModels().pipe(Effect.flip)
        }).pipe(Effect.provide(makeConnectionLayer(makeConfiguration(endpoints), clientFactory)))

        expect(failure._tag).toBe(scenario.expectedTag)
        if (failure._tag === 'AdapterProviderResponseError') {
          expect(failure.statusCode).toBe(scenario.expectedStatusCode)
        }
        expect(invoked).toEqual([PRIMARY_URL])
      }),
    { discard: true },
  )
})

it.effect('does not switch endpoints for malformed SDK pager data', () => {
  const invalidPagers: ReadonlyArray<() => Pager<Model>> = [
    () => {
      const pager = makePager(undefined)
      Object.defineProperty(pager, 'page', { value: { name: 'models/not-an-array' } })
      return pager
    },
    () => {
      const pager = makePager(undefined)
      const config = pager.params.config
      if (config !== undefined) Object.defineProperty(config, 'pageToken', { value: null })
      return pager
    },
  ]

  return Effect.forEach(
    invalidPagers,
    (makeInvalidPager) =>
      Effect.gen(function* () {
        const created = yield* Ref.make<ReadonlyArray<Creation>>([])
        const finalized = yield* Ref.make<ReadonlyArray<string>>([])
        const invoked: Array<string> = []
        const clientFactory = makeTrackedClientFactory(created, finalized, (baseUrl) => ({
          listModels: () => {
            invoked.push(baseUrl)
            return Promise.resolve(
              baseUrl === PRIMARY_URL ? makeInvalidPager() : makePager(undefined),
            )
          },
        }))

        const failure = yield* Effect.gen(function* () {
          const connection = yield* GeminiConnection.Service
          return yield* connection.listModels().pipe(Effect.flip)
        }).pipe(Effect.provide(makeConnectionLayer(makeConfiguration(endpoints), clientFactory)))

        expect(failure._tag).toBe('AdapterProtocolDecodeError')
        expect(failure.message).toBe('Gemini returned an invalid model discovery response')
        expect(invoked).toEqual([PRIMARY_URL])
      }),
    { discard: true },
  )
})

it.effect('discards partial pages and restarts pagination on the backup endpoint', () =>
  Effect.gen(function* () {
    const created = yield* Ref.make<ReadonlyArray<Creation>>([])
    const finalized = yield* Ref.make<ReadonlyArray<string>>([])
    const invoked: Array<{ readonly baseUrl: string; readonly pageToken: string | undefined }> = []
    const clientFactory = makeTrackedClientFactory(created, finalized, (baseUrl) => ({
      listModels: (params: ListModelsParameters) => {
        const config = params.config
        const currentPageToken = config === undefined ? undefined : config.pageToken
        invoked.push({ baseUrl, pageToken: currentPageToken })
        if (baseUrl === PRIMARY_URL && currentPageToken === undefined) {
          return Promise.resolve(
            makePager('primary-next-page', [{ name: 'models/primary-partial' }]),
          )
        }
        if (baseUrl === PRIMARY_URL) {
          return Promise.reject(new ApiError({ status: 503, message: SDK_ERROR_CANARY }))
        }
        if (baseUrl === SECONDARY_URL && currentPageToken === undefined) {
          return Promise.resolve(
            makePager('secondary-next-page', [{ name: 'models/secondary-first' }]),
          )
        }
        return Promise.resolve(makePager(undefined, [{ name: 'models/secondary-second' }]))
      },
    }))

    const listing = yield* Effect.gen(function* () {
      const connection = yield* GeminiConnection.Service
      return yield* connection.listModels()
    }).pipe(Effect.provide(makeConnectionLayer(makeConfiguration(endpoints), clientFactory)))

    expect(listing.models).toEqual([
      { name: 'models/secondary-first' },
      { name: 'models/secondary-second' },
    ])
    expect(invoked).toEqual([
      { baseUrl: PRIMARY_URL, pageToken: undefined },
      { baseUrl: PRIMARY_URL, pageToken: 'primary-next-page' },
      { baseUrl: SECONDARY_URL, pageToken: undefined },
      { baseUrl: SECONDARY_URL, pageToken: 'secondary-next-page' },
    ])
  }),
)

it.effect('rejects cyclic pagination without switching endpoints', () =>
  Effect.gen(function* () {
    const created = yield* Ref.make<ReadonlyArray<Creation>>([])
    const finalized = yield* Ref.make<ReadonlyArray<string>>([])
    const invoked: Array<string> = []
    const clientFactory = makeTrackedClientFactory(created, finalized, (baseUrl) => ({
      listModels: () => {
        invoked.push(baseUrl)
        return Promise.resolve(makePager('repeated-token'))
      },
    }))

    const failure = yield* Effect.gen(function* () {
      const connection = yield* GeminiConnection.Service
      return yield* connection.listModels().pipe(Effect.flip)
    }).pipe(Effect.provide(makeConnectionLayer(makeConfiguration(endpoints), clientFactory)))

    expect(failure._tag).toBe('AdapterProtocolDecodeError')
    expect(failure.message).toBe('Gemini returned an invalid model discovery response')
    expect(invoked).toEqual([PRIMARY_URL, PRIMARY_URL])
  }),
)

it.effect('rejects an unbounded model listing without switching endpoints', () =>
  Effect.gen(function* () {
    const created = yield* Ref.make<ReadonlyArray<Creation>>([])
    const finalized = yield* Ref.make<ReadonlyArray<string>>([])
    const invoked: Array<string> = []
    const excessiveModels = Array.from({ length: 10_001 }, () => ({
      name: 'models/excessive',
    }))
    const clientFactory = makeTrackedClientFactory(created, finalized, (baseUrl) => ({
      listModels: () => {
        invoked.push(baseUrl)
        return Promise.resolve(makePager(undefined, excessiveModels))
      },
    }))

    const failure = yield* Effect.gen(function* () {
      const connection = yield* GeminiConnection.Service
      return yield* connection.listModels().pipe(Effect.flip)
    }).pipe(Effect.provide(makeConnectionLayer(makeConfiguration(endpoints), clientFactory)))

    expect(failure._tag).toBe('AdapterProtocolDecodeError')
    expect(failure.message).toBe('Gemini returned an invalid model discovery response')
    expect(invoked).toEqual([PRIMARY_URL])
  }),
)

it.effect('keeps the last successful endpoint sticky for later requests', () =>
  Effect.gen(function* () {
    const created = yield* Ref.make<ReadonlyArray<Creation>>([])
    const finalized = yield* Ref.make<ReadonlyArray<string>>([])
    const invoked: Array<string> = []
    const clientFactory = makeTrackedClientFactory(created, finalized, (baseUrl) => ({
      listModels: () => {
        invoked.push(baseUrl)
        return baseUrl === PRIMARY_URL
          ? Promise.reject(new ApiError({ status: 429, message: SDK_ERROR_CANARY }))
          : Promise.resolve(makePager(undefined))
      },
    }))

    yield* Effect.gen(function* () {
      const connection = yield* GeminiConnection.Service
      yield* connection.listModels()
      yield* connection.listModels()
    }).pipe(Effect.provide(makeConnectionLayer(makeConfiguration(endpoints), clientFactory)))

    expect(invoked).toEqual([PRIMARY_URL, SECONDARY_URL, SECONDARY_URL])
  }),
)

it.effect('uses the endpoint from the last concurrently completed successful request', () =>
  Effect.gen(function* () {
    const created = yield* Ref.make<ReadonlyArray<Creation>>([])
    const finalized = yield* Ref.make<ReadonlyArray<string>>([])
    const pending = yield* Queue.unbounded<PendingRequest>()
    const clientFactory = makeTrackedClientFactory(created, finalized, (baseUrl) => ({
      listModels: () =>
        new Promise<Pager<Model>>((resolve, reject) => {
          Queue.offerUnsafe(pending, { baseUrl, resolve, reject })
        }),
    }))

    yield* Effect.gen(function* () {
      const connection = yield* GeminiConnection.Service
      const firstFiber = yield* Effect.forkChild(connection.listModels())
      const firstPrimary = yield* Queue.take(pending)
      expect(firstPrimary.baseUrl).toBe(PRIMARY_URL)
      firstPrimary.reject(new ApiError({ status: 429, message: SDK_ERROR_CANARY }))

      const firstSecondary = yield* Queue.take(pending)
      expect(firstSecondary.baseUrl).toBe(SECONDARY_URL)

      const secondFiber = yield* Effect.forkChild(connection.listModels())
      const secondPrimary = yield* Queue.take(pending)
      expect(secondPrimary.baseUrl).toBe(PRIMARY_URL)
      secondPrimary.reject(new ApiError({ status: 429, message: SDK_ERROR_CANARY }))

      const secondSecondary = yield* Queue.take(pending)
      expect(secondSecondary.baseUrl).toBe(SECONDARY_URL)

      firstSecondary.resolve(makePager(undefined))
      yield* Fiber.join(firstFiber)

      secondSecondary.reject(new ApiError({ status: 503, message: SDK_ERROR_CANARY }))
      const secondTertiary = yield* Queue.take(pending)
      expect(secondTertiary.baseUrl).toBe(TERTIARY_URL)
      secondTertiary.resolve(makePager(undefined))
      yield* Fiber.join(secondFiber)

      const laterFiber = yield* Effect.forkChild(connection.listModels())
      const laterRequest = yield* Queue.take(pending)
      expect(laterRequest.baseUrl).toBe(TERTIARY_URL)
      laterRequest.resolve(makePager(undefined))
      yield* Fiber.join(laterFiber)
    }).pipe(Effect.provide(makeConnectionLayer(makeConfiguration(endpoints), clientFactory)))
  }),
)

it.effect('tries every endpoint at most once and returns the last safe failure', () =>
  Effect.gen(function* () {
    const created = yield* Ref.make<ReadonlyArray<Creation>>([])
    const finalized = yield* Ref.make<ReadonlyArray<string>>([])
    const invoked: Array<string> = []
    const failures = new Map<string, Error>([
      [PRIMARY_URL, new ApiError({ status: 401, message: SDK_ERROR_CANARY + API_KEY_CANARY })],
      [SECONDARY_URL, networkFailure('ECONNRESET', SDK_ERROR_CANARY + SECOND_API_KEY_CANARY)],
      [
        TERTIARY_URL,
        new ApiError({ status: 503, message: SDK_ERROR_CANARY + THIRD_API_KEY_CANARY }),
      ],
    ])
    const clientFactory = makeTrackedClientFactory(created, finalized, (baseUrl) => ({
      listModels: () => {
        invoked.push(baseUrl)
        const failure = failures.get(baseUrl)
        return failure === undefined
          ? Promise.resolve(makePager(undefined))
          : Promise.reject(failure)
      },
    }))

    const failure = yield* Effect.gen(function* () {
      const connection = yield* GeminiConnection.Service
      return yield* connection.listModels().pipe(Effect.flip)
    }).pipe(Effect.provide(makeConnectionLayer(makeConfiguration(endpoints), clientFactory)))

    expect(invoked).toEqual([PRIMARY_URL, SECONDARY_URL, TERTIARY_URL])
    expect(countOccurrences(invoked, PRIMARY_URL)).toBe(1)
    expect(countOccurrences(invoked, SECONDARY_URL)).toBe(1)
    expect(countOccurrences(invoked, TERTIARY_URL)).toBe(1)
    expect(failure._tag).toBe('AdapterProviderResponseError')
    expect(failure.adapterId).toBe(ADAPTER_ID)
    if (failure._tag === 'AdapterProviderResponseError') {
      expect(failure.statusCode).toBe(503)
      expect(failure.message).toBe('Gemini rejected the model discovery request')
    }

    const surfaces = [String(failure), String(JSON.stringify(failure)), inspect(failure)]
    for (const surface of surfaces) {
      expect(surface).not.toContain(API_KEY_CANARY)
      expect(surface).not.toContain(SECOND_API_KEY_CANARY)
      expect(surface).not.toContain(THIRD_API_KEY_CANARY)
      expect(surface).not.toContain(SDK_ERROR_CANARY)
    }
  }),
)

it.effect('close takes no id, is idempotent, and interrupts all in-flight requests', () =>
  Effect.gen(function* () {
    const created = yield* Ref.make<ReadonlyArray<Creation>>([])
    const finalized = yield* Ref.make<ReadonlyArray<string>>([])
    const started = yield* Queue.unbounded<AbortSignal>()
    const clientFactory = makeTrackedClientFactory(created, finalized, () => ({
      listModels: (_params, signal) => {
        Queue.offerUnsafe(started, signal)
        return new Promise<Pager<Model>>(() => undefined)
      },
    }))

    yield* Effect.gen(function* () {
      const connection = yield* GeminiConnection.Service
      const firstFiber = yield* Effect.forkChild(connection.listModels())
      const secondFiber = yield* Effect.forkChild(connection.listModels())
      const firstSignal = yield* Queue.take(started)
      const secondSignal = yield* Queue.take(started)

      expect(firstSignal.aborted).toBe(false)
      expect(secondSignal.aborted).toBe(false)
      expect(yield* connection.close()).toBe(true)
      expectInterrupted(yield* Fiber.await(firstFiber))
      expectInterrupted(yield* Fiber.await(secondFiber))
      expect(firstSignal.aborted).toBe(true)
      expect(secondSignal.aborted).toBe(true)
      expect(yield* connection.close()).toBe(false)

      const closedFailure = yield* connection.listModels().pipe(Effect.flip)
      expect(closedFailure._tag).toBe('AdapterConfigurationError')
      expect(closedFailure.adapterId).toBe(ADAPTER_ID)
      expect(closedFailure.message).toBe('Gemini connection is closed')
    }).pipe(Effect.provide(makeConnectionLayer(makeConfiguration(endpoints), clientFactory)))

    const finalizations = yield* Ref.get(finalized)
    expect(countOccurrences(finalizations, PRIMARY_URL)).toBe(1)
    expect(countOccurrences(finalizations, SECONDARY_URL)).toBe(1)
    expect(countOccurrences(finalizations, TERTIARY_URL)).toBe(1)
  }),
)

it.effect('finishes one shared cleanup when the first concurrent closer is interrupted', () =>
  Effect.gen(function* () {
    const finalizerStarted = yield* Deferred.make<void>()
    const releaseFinalizer = yield* Deferred.make<void>()
    const finalized = yield* Ref.make(0)
    const secondCloseFinished = yield* Deferred.make<void>()
    const clientFactory: GeminiClientFactory.Interface = GeminiClientFactory.Service.of({
      create: Effect.fn('GeminiConnectionTest.BlockingClientFactory.create')(function* () {
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(finalizerStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFinalizer)),
            Effect.andThen(Ref.update(finalized, (count) => count + 1)),
          ),
        )
        return {
          listModels: () => Promise.resolve(makePager(undefined)),
        }
      }),
    })

    yield* Effect.gen(function* () {
      const connection = yield* GeminiConnection.Service
      const firstClose = yield* Effect.forkChild(connection.close())
      yield* Deferred.await(finalizerStarted)

      const interruptRequest = yield* Effect.forkChild(Fiber.interrupt(firstClose))
      const secondClose = yield* Effect.forkChild(
        connection
          .close()
          .pipe(
            Effect.ensuring(Deferred.succeed(secondCloseFinished, undefined).pipe(Effect.asVoid)),
          ),
      )
      yield* Effect.yieldNow

      expect(yield* Deferred.isDone(secondCloseFinished)).toBe(false)
      expect(yield* Ref.get(finalized)).toBe(0)

      yield* Deferred.succeed(releaseFinalizer, undefined)
      expectInterrupted(yield* Fiber.await(firstClose))
      expect(yield* Fiber.join(secondClose)).toBe(false)
      yield* Fiber.join(interruptRequest)
      expect(yield* Ref.get(finalized)).toBe(1)
    }).pipe(
      Effect.provide(
        makeConnectionLayer(
          makeConfiguration([{ apiKey: API_KEY_CANARY, baseUrl: PRIMARY_URL }]),
          clientFactory,
        ),
      ),
    )

    expect(yield* Ref.get(finalized)).toBe(1)
  }),
)

it.effect('closing the parent scope interrupts requests and releases every endpoint resource', () =>
  Effect.gen(function* () {
    const created = yield* Ref.make<ReadonlyArray<Creation>>([])
    const finalized = yield* Ref.make<ReadonlyArray<string>>([])
    const started = yield* Queue.unbounded<AbortSignal>()
    const clientFactory = makeTrackedClientFactory(created, finalized, () => ({
      listModels: (_params, signal) => {
        Queue.offerUnsafe(started, signal)
        return new Promise<Pager<Model>>(() => undefined)
      },
    }))

    yield* Effect.acquireUseRelease(
      Scope.make(),
      (parentScope) =>
        Effect.gen(function* () {
          const context = yield* Layer.buildWithScope(
            makeConnectionLayer(makeConfiguration(endpoints), clientFactory),
            parentScope,
          )
          const connection = Context.get(context, GeminiConnection.Service)
          const firstFiber = yield* Effect.forkChild(connection.listModels())
          const secondFiber = yield* Effect.forkChild(connection.listModels())
          const firstSignal = yield* Queue.take(started)
          const secondSignal = yield* Queue.take(started)

          yield* Scope.close(parentScope, Exit.void)

          expectInterrupted(yield* Fiber.await(firstFiber))
          expectInterrupted(yield* Fiber.await(secondFiber))
          expect(firstSignal.aborted).toBe(true)
          expect(secondSignal.aborted).toBe(true)
          expect(yield* connection.close()).toBe(false)

          const creations = yield* Ref.get(created)
          const finalizations = yield* Ref.get(finalized)
          expect(creations.map((creation) => creation.baseUrl)).toEqual([
            PRIMARY_URL,
            SECONDARY_URL,
            TERTIARY_URL,
          ])
          expect(countOccurrences(finalizations, PRIMARY_URL)).toBe(1)
          expect(countOccurrences(finalizations, SECONDARY_URL)).toBe(1)
          expect(countOccurrences(finalizations, TERTIARY_URL)).toBe(1)
        }),
      (parentScope) => Scope.close(parentScope, Exit.void),
    )
  }),
)

it.effect('does not expose API keys or provider error details on public surfaces', () =>
  Effect.gen(function* () {
    const created = yield* Ref.make<ReadonlyArray<Creation>>([])
    const finalized = yield* Ref.make<ReadonlyArray<string>>([])
    const clientFactory = makeTrackedClientFactory(created, finalized, () => ({
      listModels: () =>
        Promise.reject(
          new Error(
            SDK_ERROR_CANARY + API_KEY_CANARY + SECOND_API_KEY_CANARY + THIRD_API_KEY_CANARY,
          ),
        ),
    }))

    const observed = yield* Effect.gen(function* () {
      const connection = yield* GeminiConnection.Service
      const exit = yield* Effect.exit(connection.listModels())
      return { connection, exit }
    }).pipe(Effect.provide(makeConnectionLayer(makeConfiguration(endpoints), clientFactory)))

    expect(Exit.isFailure(observed.exit)).toBe(true)
    if (Exit.isSuccess(observed.exit)) return
    const failure = Cause.findErrorOption(observed.exit.cause)
    expect(Option.isSome(failure)).toBe(true)
    if (Option.isNone(failure)) return
    expect(failure.value._tag).toBe('AdapterInternalError')
    expect(failure.value.message).toBe('Gemini model discovery failed')

    const surfaces = [
      String(JSON.stringify(observed.connection)),
      inspect(observed.connection),
      String(failure.value),
      String(JSON.stringify(failure.value)),
      inspect(failure.value),
      String(JSON.stringify(observed.exit)),
      inspect(observed.exit),
      Cause.pretty(observed.exit.cause),
      String(Cause.squash(observed.exit.cause)),
    ]
    for (const surface of surfaces) {
      expect(surface).not.toContain(API_KEY_CANARY)
      expect(surface).not.toContain(SECOND_API_KEY_CANARY)
      expect(surface).not.toContain(THIRD_API_KEY_CANARY)
      expect(surface).not.toContain(SDK_ERROR_CANARY)
    }
  }),
)
