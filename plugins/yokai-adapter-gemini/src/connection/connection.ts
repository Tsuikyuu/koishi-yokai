import {
  ApiError,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type ListModelsParameters,
  type Model,
} from '@google/genai'
import {
  AdapterAuthenticationError,
  AdapterCancelledError,
  AdapterConfigurationError,
  type AdapterId,
  AdapterInvocationError,
  type AdapterModelId,
  AdapterInternalError,
  AdapterProtocolDecodeError,
  AdapterProviderResponseError,
  AdapterRateLimitError,
  AdapterTimeoutError,
  AdapterTransportError,
  AdapterUnsupportedError,
} from 'yokai-protocol'
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
  Schema,
  Semaphore,
  Stream,
  SynchronizedRef,
} from 'effect'

import { GeminiClientFactory } from '../client/client-factory'
import { GeminiConfiguration } from '../config/configuration'
import type { Configuration, DiscoveryRetryPolicy } from '../config/configuration'
import { trackLogicalInvocation, trackPhysicalAttempt } from '../observability/observability'
import { GeminiHttpTransport } from '../transport/http-transport'

const DISCOVERY_OPERATION = 'discoverModels'
const MAX_DISCOVERY_PAGES = 100
const MAX_DISCOVERED_MODELS = 10_000

export interface ModelListing {
  readonly models: ReadonlyArray<Model>
}

export type GenerationOperation = 'continue' | 'generate'

export interface Interface {
  readonly adapterId: AdapterId
  readonly discoveryRetry: DiscoveryRetryPolicy
  readonly listModels: <A>(
    accept: (listing: ModelListing) => Effect.Effect<A, AdapterInvocationError>,
  ) => Effect.Effect<A, AdapterInvocationError>
  readonly generateContent: <A, R>(
    operation: GenerationOperation,
    modelId: AdapterModelId,
    params: GenerateContentParameters,
    accept: (response: GenerateContentResponse) => Effect.Effect<A, AdapterInvocationError, R>,
  ) => Effect.Effect<A, AdapterInvocationError, R>
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

const authenticationError = (adapterId: AdapterId) =>
  new AdapterAuthenticationError({
    adapterId,
    operation: DISCOVERY_OPERATION,
    message: 'Gemini authentication failed',
  })

const rateLimitError = (adapterId: AdapterId) =>
  new AdapterRateLimitError({
    adapterId,
    operation: DISCOVERY_OPERATION,
    message: 'Gemini model discovery was rate limited',
  })

const timeoutError = (adapterId: AdapterId) =>
  new AdapterTimeoutError({
    adapterId,
    operation: DISCOVERY_OPERATION,
    message: 'Gemini model discovery timed out',
  })

const cancelledError = (adapterId: AdapterId) =>
  new AdapterCancelledError({
    adapterId,
    operation: DISCOVERY_OPERATION,
    message: 'Gemini model discovery was cancelled',
  })

const transportError = (adapterId: AdapterId) =>
  new AdapterTransportError({
    adapterId,
    operation: DISCOVERY_OPERATION,
    message: 'Unable to reach the Gemini model service',
  })

const providerResponseError = (adapterId: AdapterId, statusCode: number) =>
  new AdapterProviderResponseError({
    adapterId,
    operation: DISCOVERY_OPERATION,
    message: 'Gemini rejected the model discovery request',
    statusCode,
  })

const internalError = (adapterId: AdapterId) =>
  new AdapterInternalError({
    adapterId,
    operation: DISCOVERY_OPERATION,
    message: 'Gemini model discovery failed',
  })

const protocolDecodeError = (adapterId: AdapterId) =>
  new AdapterProtocolDecodeError({
    adapterId,
    operation: DISCOVERY_OPERATION,
    message: 'Gemini returned an invalid model discovery response',
  })

const closedConnectionError = (adapterId: AdapterId) =>
  new AdapterConfigurationError({
    adapterId,
    operation: DISCOVERY_OPERATION,
    message: 'Gemini connection is closed',
  })

const generationAuthenticationError = (
  adapterId: AdapterId,
  modelId: AdapterModelId,
  operation: GenerationOperation,
) =>
  new AdapterAuthenticationError({
    adapterId,
    modelId,
    operation,
    message: 'Gemini authentication failed',
  })

const generationRateLimitError = (
  adapterId: AdapterId,
  modelId: AdapterModelId,
  operation: GenerationOperation,
  retryAfterMs?: number,
) =>
  new AdapterRateLimitError({
    adapterId,
    modelId,
    operation,
    message: 'Gemini text generation was rate limited',
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  })

const generationTimeoutError = (
  adapterId: AdapterId,
  modelId: AdapterModelId,
  operation: GenerationOperation,
) =>
  new AdapterTimeoutError({
    adapterId,
    modelId,
    operation,
    message: 'Gemini text generation timed out',
  })

const generationCancelledError = (
  adapterId: AdapterId,
  modelId: AdapterModelId,
  operation: GenerationOperation,
) =>
  new AdapterCancelledError({
    adapterId,
    modelId,
    operation,
    message: 'Gemini text generation was cancelled',
  })

const generationTransportError = (
  adapterId: AdapterId,
  modelId: AdapterModelId,
  operation: GenerationOperation,
) =>
  new AdapterTransportError({
    adapterId,
    modelId,
    operation,
    message: 'Unable to reach the Gemini generation service',
  })

const generationProviderResponseError = (
  adapterId: AdapterId,
  modelId: AdapterModelId,
  operation: GenerationOperation,
  statusCode: number,
) =>
  new AdapterProviderResponseError({
    adapterId,
    modelId,
    operation,
    message: 'Gemini rejected the generation request',
    statusCode,
  })

const generationInternalError = (
  adapterId: AdapterId,
  modelId: AdapterModelId,
  operation: GenerationOperation,
) =>
  new AdapterInternalError({
    adapterId,
    modelId,
    operation,
    message: 'Gemini text generation failed',
  })

const generationProtocolDecodeError = (
  adapterId: AdapterId,
  modelId: AdapterModelId,
  operation: GenerationOperation,
) =>
  new AdapterProtocolDecodeError({
    adapterId,
    modelId,
    operation,
    message: 'Gemini returned an invalid generation response',
  })

const generationClosedConnectionError = (
  adapterId: AdapterId,
  modelId: AdapterModelId,
  operation: GenerationOperation,
) =>
  new AdapterConfigurationError({
    adapterId,
    modelId,
    operation,
    message: 'Gemini connection is closed',
  })

const generationConfigurationError = (
  adapterId: AdapterId,
  modelId: AdapterModelId,
  operation: GenerationOperation,
) =>
  new AdapterConfigurationError({
    adapterId,
    modelId,
    operation,
    message: 'Gemini generation is not configured',
  })

const generationUnsupportedError = (
  adapterId: AdapterId,
  modelId: AdapterModelId,
  operation: GenerationOperation,
) =>
  new AdapterUnsupportedError({
    adapterId,
    modelId,
    operation,
    message: 'Gemini does not support the requested generation feature',
    feature: 'feedback-tools',
  })

const sanitizeInjectedGenerationError = (
  adapterId: AdapterId,
  modelId: AdapterModelId,
  operation: GenerationOperation,
  error: AdapterInvocationError,
): AdapterInvocationError => {
  switch (error._tag) {
    case 'AdapterConfigurationError':
      return generationConfigurationError(adapterId, modelId, operation)
    case 'AdapterAuthenticationError':
      return generationAuthenticationError(adapterId, modelId, operation)
    case 'AdapterRateLimitError':
      return generationRateLimitError(adapterId, modelId, operation, error.retryAfterMs)
    case 'AdapterTimeoutError':
      return generationTimeoutError(adapterId, modelId, operation)
    case 'AdapterCancelledError':
      return generationCancelledError(adapterId, modelId, operation)
    case 'AdapterTransportError':
      return generationTransportError(adapterId, modelId, operation)
    case 'AdapterProviderResponseError':
      return generationProviderResponseError(
        adapterId,
        modelId,
        operation,
        error.statusCode === undefined ? 500 : error.statusCode,
      )
    case 'AdapterProtocolDecodeError':
      return generationProtocolDecodeError(adapterId, modelId, operation)
    case 'AdapterInternalError':
    case 'AdapterContinuationError':
    case 'AdapterProtocolViolationError':
      return generationInternalError(adapterId, modelId, operation)
    case 'AdapterUnsupportedError':
      return generationUnsupportedError(adapterId, modelId, operation)
  }
}

const hasNetworkErrorCode = (cause: Error['cause']): boolean => {
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return false
  return typeof cause.code === 'string' && cause.code.length > 0
}

const isFetchTransportError = (cause: TypeError): boolean =>
  cause.message === 'fetch failed' && hasNetworkErrorCode(cause.cause)

const classifyApiError = (adapterId: AdapterId, error: ApiError): AdapterInvocationError => {
  if (error.status === 401 || error.status === 403) return authenticationError(adapterId)
  if (error.status === 408 || error.status === 504) return timeoutError(adapterId)
  if (error.status === 499) return cancelledError(adapterId)
  if (error.status === 429) return rateLimitError(adapterId)
  if (Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) {
    return providerResponseError(adapterId, error.status)
  }
  return internalError(adapterId)
}

const classifyGenerationApiError = (
  adapterId: AdapterId,
  modelId: AdapterModelId,
  operation: GenerationOperation,
  error: ApiError,
): AdapterInvocationError => {
  if (error.status === 401 || error.status === 403) {
    return generationAuthenticationError(adapterId, modelId, operation)
  }
  if (error.status === 408 || error.status === 504) {
    return generationTimeoutError(adapterId, modelId, operation)
  }
  if (error.status === 499) return generationCancelledError(adapterId, modelId, operation)
  if (error.status === 429) return generationRateLimitError(adapterId, modelId, operation)
  if (Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) {
    return generationProviderResponseError(adapterId, modelId, operation, error.status)
  }
  return generationInternalError(adapterId, modelId, operation)
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
  const invocationGate = yield* Semaphore.make(configuration.maxConcurrency)

  const invokePage = Effect.fn('GeminiConnection.invokePage')(function* (
    client: GeminiClientFactory.Client,
    params: ListModelsParameters,
  ) {
    const request = Effect.tryPromise({
      try: (signal) => client.listModels(params, signal),
      catch: (cause) => {
        if (cause instanceof ApiError) return classifyApiError(configuration.adapterId, cause)
        if (cause instanceof GeminiHttpTransport.TimeoutError) {
          return timeoutError(configuration.adapterId)
        }
        if (cause instanceof GeminiHttpTransport.TransportError) {
          return transportError(configuration.adapterId)
        }
        if (cause instanceof Error && cause.name === 'AbortError') {
          return timeoutError(configuration.adapterId)
        }
        if (cause instanceof Error && cause.name === 'TimeoutError') {
          return timeoutError(configuration.adapterId)
        }
        if (cause instanceof SyntaxError) return protocolDecodeError(configuration.adapterId)
        if (cause instanceof TypeError) {
          return isFetchTransportError(cause)
            ? transportError(configuration.adapterId)
            : protocolDecodeError(configuration.adapterId)
        }
        return internalError(configuration.adapterId)
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
      catch: () => protocolDecodeError(configuration.adapterId),
    })
    if (!Array.isArray(decoded.models)) {
      return yield* Effect.fail(protocolDecodeError(configuration.adapterId))
    }
    const nextPageToken = decoded.nextPageToken
    if (
      nextPageToken !== undefined &&
      (typeof nextPageToken !== 'string' || nextPageToken.length === 0)
    ) {
      return yield* Effect.fail(protocolDecodeError(configuration.adapterId))
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
    const models = yield* Stream.paginate<PaginationState, Model, AdapterInvocationError>(
      initialState,
      (state: PaginationState) =>
        Effect.gen(function* () {
          const page = yield* invokePage(client, state.params)
          const pageCount = state.pageCount + 1
          const modelCount = state.modelCount + page.models.length
          if (modelCount > MAX_DISCOVERED_MODELS) {
            return yield* Effect.fail(protocolDecodeError(configuration.adapterId))
          }
          if (Option.isNone(page.nextPageToken)) {
            return [page.models, Option.none<PaginationState>()] as const
          }

          const token = page.nextPageToken.value
          if (pageCount >= MAX_DISCOVERY_PAGES || HashSet.has(state.seenPageTokens, token)) {
            return yield* Effect.fail(protocolDecodeError(configuration.adapterId))
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

  const invokeGeneration = Effect.fn('GeminiConnection.invokeGeneration')(function* (
    client: GeminiClientFactory.Client,
    operation: GenerationOperation,
    modelId: AdapterModelId,
    params: GenerateContentParameters,
  ) {
    const request = Effect.tryPromise({
      try: (signal) => client.generateContent(params, signal),
      catch: (cause) => {
        if (Schema.is(AdapterInvocationError)(cause)) {
          return sanitizeInjectedGenerationError(configuration.adapterId, modelId, operation, cause)
        }
        if (cause instanceof ApiError) {
          return classifyGenerationApiError(configuration.adapterId, modelId, operation, cause)
        }
        if (cause instanceof GeminiHttpTransport.TimeoutError) {
          return generationTimeoutError(configuration.adapterId, modelId, operation)
        }
        if (cause instanceof GeminiHttpTransport.TransportError) {
          return generationTransportError(configuration.adapterId, modelId, operation)
        }
        if (cause instanceof Error && cause.name === 'AbortError') {
          return generationTimeoutError(configuration.adapterId, modelId, operation)
        }
        if (cause instanceof Error && cause.name === 'TimeoutError') {
          return generationTimeoutError(configuration.adapterId, modelId, operation)
        }
        if (cause instanceof SyntaxError) {
          return generationProtocolDecodeError(configuration.adapterId, modelId, operation)
        }
        if (cause instanceof TypeError) {
          return isFetchTransportError(cause)
            ? generationTransportError(configuration.adapterId, modelId, operation)
            : generationProtocolDecodeError(configuration.adapterId, modelId, operation)
        }
        return generationInternalError(configuration.adapterId, modelId, operation)
      },
    })

    const response = yield* Effect.acquireUseRelease(
      FiberSet.run(requests, request),
      Fiber.join,
      Fiber.interrupt,
    )
    return response
  })

  const activateIfOpen = (selectedIndex: number): Effect.Effect<void> =>
    SynchronizedRef.update(activeEndpoint, (current) => {
      if (Option.isNone(current)) return current
      return Option.some(selectedIndex)
    })

  const listModels = Effect.fn('GeminiConnection.listModels')(function* <A>(
    accept: (listing: ModelListing) => Effect.Effect<A, AdapterInvocationError>,
  ) {
    const attempt: (
      remaining: ReadonlyArray<ClientEntry>,
    ) => Effect.Effect<A, AdapterInvocationError> = Effect.fn('GeminiConnection.attempt')(
      function* (remaining: ReadonlyArray<ClientEntry>) {
        const entry = remaining[0]
        if (entry === undefined) return yield* Effect.die('Expected at least one Gemini endpoint')

        const invocation = listAllModels(entry.client).pipe(
          Effect.flatMap(accept),
          Effect.timeout(configuration.requestTimeoutMs),
          Effect.mapError((error) =>
            Cause.isTimeoutError(error) ? timeoutError(configuration.adapterId) : error,
          ),
        )
        return yield* trackPhysicalAttempt(
          {
            adapterId: configuration.adapterId,
            operation: DISCOVERY_OPERATION,
            modelId: Option.none(),
          },
          invocation,
        ).pipe(
          Effect.matchEffect({
            onFailure: (error) => {
              const rest = remaining.slice(1)
              return isSwitchableError(error) && rest.length > 0
                ? attempt(rest)
                : Effect.fail(error)
            },
            onSuccess: (value) => activateIfOpen(entry.index).pipe(Effect.as(value)),
          }),
        )
      },
    )

    const invocation = invocationGate.withPermits(1)(
      Effect.gen(function* () {
        const currentClients = yield* Ref.get(clientsRef)
        const current = yield* SynchronizedRef.get(activeEndpoint)
        if (Option.isNone(currentClients) || Option.isNone(current)) {
          return yield* Effect.fail(closedConnectionError(configuration.adapterId))
        }
        return yield* attempt(orderedClients(currentClients.value, current.value))
      }),
    )
    return yield* trackLogicalInvocation(
      {
        adapterId: configuration.adapterId,
        operation: DISCOVERY_OPERATION,
        modelId: Option.none(),
      },
      invocation,
    )
  })

  const generateContent = Effect.fn('GeminiConnection.generateContent')(function* <A, R>(
    operation: GenerationOperation,
    modelId: AdapterModelId,
    params: GenerateContentParameters,
    accept: (response: GenerateContentResponse) => Effect.Effect<A, AdapterInvocationError, R>,
  ) {
    const attempt: (
      remaining: ReadonlyArray<ClientEntry>,
    ) => Effect.Effect<A, AdapterInvocationError, R> = Effect.fn(
      'GeminiConnection.generateAttempt',
    )(function* (remaining: ReadonlyArray<ClientEntry>) {
      const entry = remaining[0]
      if (entry === undefined) return yield* Effect.die('Expected at least one Gemini endpoint')

      const invocation = invokeGeneration(entry.client, operation, modelId, params).pipe(
        Effect.flatMap(accept),
        Effect.timeout(configuration.requestTimeoutMs),
        Effect.mapError((error) =>
          Cause.isTimeoutError(error)
            ? generationTimeoutError(configuration.adapterId, modelId, operation)
            : error,
        ),
      )
      return yield* trackPhysicalAttempt(
        {
          adapterId: configuration.adapterId,
          operation,
          modelId: Option.some(modelId),
        },
        invocation,
      ).pipe(
        Effect.matchEffect({
          onFailure: (error) => {
            const rest = remaining.slice(1)
            return isSwitchableError(error) && rest.length > 0
              ? Effect.logWarning(
                  'Gemini generation endpoint failover may duplicate generation or billing',
                ).pipe(
                  Effect.annotateLogs({
                    adapterId: configuration.adapterId,
                    modelId,
                    operation,
                    status: 'endpoint-failover',
                  }),
                  Effect.andThen(attempt(rest)),
                )
              : Effect.fail(error)
          },
          onSuccess: (value) => activateIfOpen(entry.index).pipe(Effect.as(value)),
        }),
      )
    })

    const invocation = invocationGate.withPermits(1)(
      Effect.gen(function* () {
        const currentClients = yield* Ref.get(clientsRef)
        const current = yield* SynchronizedRef.get(activeEndpoint)
        if (Option.isNone(currentClients) || Option.isNone(current)) {
          return yield* Effect.fail(
            generationClosedConnectionError(configuration.adapterId, modelId, operation),
          )
        }
        return yield* attempt(orderedClients(currentClients.value, current.value))
      }),
    )
    return yield* trackLogicalInvocation(
      {
        adapterId: configuration.adapterId,
        operation,
        modelId: Option.some(modelId),
      },
      invocation,
    )
  })

  return Service.of({
    adapterId: configuration.adapterId,
    discoveryRetry: configuration.discoveryRetry,
    listModels,
    generateContent,
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
