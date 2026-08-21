import { ApiError, type ListModelsParameters, type Model } from '@google/genai'
import {
  AdapterAuthenticationError,
  AdapterCancelledError,
  AdapterConfigurationError,
  AdapterId,
  type AdapterInvocationError,
  AdapterInternalError,
  AdapterProtocolDecodeError,
  AdapterProviderResponseError,
  AdapterRateLimitError,
  AdapterTimeoutError,
  AdapterTransportError,
} from '@yokai/protocol'
import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  HashSet,
  Layer,
  Option,
  Redacted,
  Ref,
  Scope,
  Stream,
  SynchronizedRef,
} from 'effect'

import { GeminiClientFactory } from '../client/client-factory'
import { GeminiConfiguration } from '../config/configuration'
import type { Configuration, DiscoveryRetryPolicy } from '../config/configuration'
import { GeminiHttpTransport } from '../transport/http-transport'

const GEMINI_ADAPTER_ID = AdapterId.make('gemini')
const DISCOVERY_OPERATION = 'discoverModels'
const MAX_DISCOVERY_PAGES = 100
const MAX_DISCOVERED_MODELS = 10_000

export interface ModelListing {
  readonly models: ReadonlyArray<Model>
}

export interface Interface {
  readonly discoveryRetry: DiscoveryRetryPolicy
  readonly listModels: () => Effect.Effect<ModelListing, AdapterInvocationError>
  readonly close: () => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/koishi-plugin-yokai-adapter-gemini/Connection',
) {}

interface ClientEntry {
  readonly index: number
  readonly client: GeminiClientFactory.Client
}

interface PaginationState {
  readonly params: ListModelsParameters
  readonly seenPageTokens: HashSet.HashSet<string>
  readonly pageCount: number
  readonly modelCount: number
}

type Lifecycle = Data.TaggedEnum<{
  readonly Open: {}
  readonly Closing: {}
  readonly Closed: {}
}>

const Lifecycle = Data.taggedEnum<Lifecycle>()

const authenticationError = () =>
  new AdapterAuthenticationError({
    adapterId: GEMINI_ADAPTER_ID,
    operation: DISCOVERY_OPERATION,
    message: 'Gemini authentication failed',
  })

const rateLimitError = () =>
  new AdapterRateLimitError({
    adapterId: GEMINI_ADAPTER_ID,
    operation: DISCOVERY_OPERATION,
    message: 'Gemini model discovery was rate limited',
  })

const timeoutError = () =>
  new AdapterTimeoutError({
    adapterId: GEMINI_ADAPTER_ID,
    operation: DISCOVERY_OPERATION,
    message: 'Gemini model discovery timed out',
  })

const cancelledError = () =>
  new AdapterCancelledError({
    adapterId: GEMINI_ADAPTER_ID,
    operation: DISCOVERY_OPERATION,
    message: 'Gemini model discovery was cancelled',
  })

const transportError = () =>
  new AdapterTransportError({
    adapterId: GEMINI_ADAPTER_ID,
    operation: DISCOVERY_OPERATION,
    message: 'Unable to reach the Gemini model service',
  })

const providerResponseError = (statusCode: number) =>
  new AdapterProviderResponseError({
    adapterId: GEMINI_ADAPTER_ID,
    operation: DISCOVERY_OPERATION,
    message: 'Gemini rejected the model discovery request',
    statusCode,
  })

const internalError = () =>
  new AdapterInternalError({
    adapterId: GEMINI_ADAPTER_ID,
    operation: DISCOVERY_OPERATION,
    message: 'Gemini model discovery failed',
  })

const protocolDecodeError = () =>
  new AdapterProtocolDecodeError({
    adapterId: GEMINI_ADAPTER_ID,
    operation: DISCOVERY_OPERATION,
    message: 'Gemini returned an invalid model discovery response',
  })

const closedConnectionError = () =>
  new AdapterConfigurationError({
    adapterId: GEMINI_ADAPTER_ID,
    operation: DISCOVERY_OPERATION,
    message: 'Gemini connection is closed',
  })

const hasNetworkErrorCode = (cause: Error['cause']): boolean => {
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return false
  return typeof cause.code === 'string' && cause.code.length > 0
}

const isFetchTransportError = (cause: TypeError): boolean =>
  cause.message === 'fetch failed' && hasNetworkErrorCode(cause.cause)

const classifyApiError = (error: ApiError): AdapterInvocationError => {
  if (error.status === 401 || error.status === 403) return authenticationError()
  if (error.status === 408 || error.status === 504) return timeoutError()
  if (error.status === 499) return cancelledError()
  if (error.status === 429) return rateLimitError()
  if (Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) {
    return providerResponseError(error.status)
  }
  return internalError()
}

const isSwitchableError = (error: AdapterInvocationError): boolean => {
  switch (error._tag) {
    case 'AdapterAuthenticationError':
    case 'AdapterRateLimitError':
    case 'AdapterTimeoutError':
    case 'AdapterTransportError':
      return true
    case 'AdapterProviderResponseError': {
      const statusCode = error.statusCode
      return statusCode === 402 || (statusCode !== undefined && statusCode >= 500)
    }
    case 'AdapterConfigurationError':
    case 'AdapterCancelledError':
    case 'AdapterProtocolDecodeError':
    case 'AdapterInternalError':
    case 'AdapterUnsupportedError':
    case 'AdapterContinuationError':
    case 'AdapterProtocolViolationError':
      return false
  }
}

const orderedClients = (
  clients: ReadonlyArray<ClientEntry>,
  activeIndex: number,
): ReadonlyArray<ClientEntry> => [...clients.slice(activeIndex), ...clients.slice(0, activeIndex)]

const withPageToken = (
  params: ListModelsParameters,
  nextPageToken: string,
): ListModelsParameters => {
  const config = params.config
  return {
    ...params,
    config:
      config === undefined ? { pageToken: nextPageToken } : { ...config, pageToken: nextPageToken },
  }
}

const makeConnection = Effect.fn('GeminiConnection.makeConnection')(function* (
  configuration: Configuration,
  closeConnection: () => Effect.Effect<boolean>,
) {
  const clientFactory = yield* GeminiClientFactory.Service
  yield* Effect.forEach(
    configuration.endpoints,
    (endpoint) =>
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          Redacted.wipeUnsafe(endpoint.apiKey)
        }),
      ),
    { discard: true },
  )
  const clientsRef = yield* Effect.forEach(configuration.endpoints, (endpoint, index) =>
    clientFactory
      .create(endpoint)
      .pipe(Effect.map((client) => ({ index, client }) satisfies ClientEntry)),
  ).pipe(Effect.flatMap((clients) => Ref.make(Option.some<ReadonlyArray<ClientEntry>>(clients))))
  yield* Effect.addFinalizer(() => Ref.set(clientsRef, Option.none()))
  const activeEndpoint = yield* SynchronizedRef.make(Option.some(0))
  yield* Effect.addFinalizer(() => SynchronizedRef.set(activeEndpoint, Option.none()))
  const requests = yield* FiberSet.make()

  const invokePage = Effect.fn('GeminiConnection.invokePage')(function* (
    client: GeminiClientFactory.Client,
    params: ListModelsParameters,
  ) {
    const request = Effect.tryPromise({
      try: (signal) => client.listModels(params, signal),
      catch: (cause) => {
        if (cause instanceof ApiError) return classifyApiError(cause)
        if (cause instanceof GeminiHttpTransport.TimeoutError) return timeoutError()
        if (cause instanceof GeminiHttpTransport.TransportError) return transportError()
        if (cause instanceof Error && cause.name === 'AbortError') return timeoutError()
        if (cause instanceof Error && cause.name === 'TimeoutError') return timeoutError()
        if (cause instanceof SyntaxError) return protocolDecodeError()
        if (cause instanceof TypeError) {
          return isFetchTransportError(cause) ? transportError() : protocolDecodeError()
        }
        return internalError()
      },
    })

    const pager = yield* Effect.acquireUseRelease(
      FiberSet.run(requests, request),
      Fiber.join,
      Fiber.interrupt,
    )

    const decoded = yield* Effect.try({
      try: () => {
        const config = pager.params.config
        return {
          models: pager.page,
          nextPageToken: config === undefined ? undefined : config.pageToken,
        }
      },
      catch: protocolDecodeError,
    })
    if (!Array.isArray(decoded.models)) return yield* Effect.fail(protocolDecodeError())
    const nextPageToken = decoded.nextPageToken
    if (
      nextPageToken !== undefined &&
      (typeof nextPageToken !== 'string' || nextPageToken.length === 0)
    ) {
      return yield* Effect.fail(protocolDecodeError())
    }

    return {
      models: [...decoded.models],
      nextPageToken: Option.fromUndefinedOr(nextPageToken),
    }
  })

  const listAllModels = Effect.fn('GeminiConnection.listAllModels')(function* (
    client: GeminiClientFactory.Client,
  ) {
    const initialState: PaginationState = {
      params: { config: {} },
      seenPageTokens: HashSet.empty(),
      pageCount: 0,
      modelCount: 0,
    }
    const models = yield* Stream.paginate(initialState, (state: PaginationState) =>
      Effect.gen(function* () {
        const page = yield* invokePage(client, state.params)
        const pageCount = state.pageCount + 1
        const modelCount = state.modelCount + page.models.length
        if (modelCount > MAX_DISCOVERED_MODELS) {
          return yield* Effect.fail(protocolDecodeError())
        }
        if (Option.isNone(page.nextPageToken)) {
          return [page.models, Option.none<PaginationState>()] as const
        }

        const token = page.nextPageToken.value
        if (pageCount >= MAX_DISCOVERY_PAGES || HashSet.has(state.seenPageTokens, token)) {
          return yield* Effect.fail(protocolDecodeError())
        }
        return [
          page.models,
          Option.some({
            params: withPageToken(state.params, token),
            seenPageTokens: HashSet.add(state.seenPageTokens, token),
            pageCount,
            modelCount,
          }),
        ] as const
      }),
    ).pipe(Stream.runCollect)
    return { models } satisfies ModelListing
  })

  const activateIfOpen = (selectedIndex: number): Effect.Effect<void> =>
    SynchronizedRef.update(activeEndpoint, (current) => {
      if (Option.isNone(current)) return current
      return Option.some(selectedIndex)
    })

  const attempt: (
    remaining: ReadonlyArray<ClientEntry>,
  ) => Effect.Effect<ModelListing, AdapterInvocationError> = Effect.fn('GeminiConnection.attempt')(
    function* (remaining) {
      const entry = remaining[0]
      if (entry === undefined) return yield* Effect.die('Expected at least one Gemini endpoint')

      return yield* listAllModels(entry.client).pipe(
        Effect.timeout(configuration.requestTimeoutMs),
        Effect.mapError((error) => (Cause.isTimeoutError(error) ? timeoutError() : error)),
        Effect.matchEffect({
          onFailure: (error) => {
            const rest = remaining.slice(1)
            return isSwitchableError(error) && rest.length > 0 ? attempt(rest) : Effect.fail(error)
          },
          onSuccess: (listing) => activateIfOpen(entry.index).pipe(Effect.as(listing)),
        }),
      )
    },
  )

  const listModels = Effect.fn('GeminiConnection.listModels')(function* () {
    const currentClients = yield* Ref.get(clientsRef)
    const current = yield* SynchronizedRef.get(activeEndpoint)
    if (Option.isNone(currentClients) || Option.isNone(current)) {
      return yield* Effect.fail(closedConnectionError())
    }
    return yield* attempt(orderedClients(currentClients.value, current.value))
  })

  return Service.of({
    discoveryRetry: configuration.discoveryRetry,
    listModels,
    close: closeConnection,
  })
})

const make = Effect.fn('GeminiConnection.make')(function* () {
  const configuration = yield* GeminiConfiguration.Service
  const connectionScope = yield* Scope.make()
  const lifecycle = yield* SynchronizedRef.make<Lifecycle>(Lifecycle.Open())
  const closed = yield* Deferred.make<void>()

  const closeConnection = Effect.fn('GeminiConnection.close')(function* () {
    return yield* Effect.gen(function* () {
      const startsClosing = yield* SynchronizedRef.modify(lifecycle, (current) => {
        if (current._tag !== 'Open') return [false, current] as const
        return [true, Lifecycle.Closing()] as const
      })

      if (startsClosing) {
        const finishClosing = SynchronizedRef.set(lifecycle, Lifecycle.Closed()).pipe(
          Effect.andThen(Deferred.succeed(closed, undefined)),
          Effect.asVoid,
        )
        yield* Scope.close(connectionScope, Exit.void).pipe(Effect.ensuring(finishClosing))
        return true
      }

      const current = yield* SynchronizedRef.get(lifecycle)
      if (current._tag === 'Closing') yield* Deferred.await(closed)
      return false
    }).pipe(Effect.uninterruptible)
  })

  yield* Effect.addFinalizer(() => closeConnection().pipe(Effect.asVoid))
  return yield* Scope.provide(makeConnection(configuration, closeConnection), connectionScope)
})

export const layer = Layer.effect(Service, make())

export * as GeminiConnection from './connection'
