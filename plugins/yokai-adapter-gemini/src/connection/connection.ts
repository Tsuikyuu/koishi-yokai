import { ApiError, type ListModelsParameters, type Model, type Pager } from '@google/genai'
import {
  AdapterAuthenticationError,
  AdapterCancelledError,
  AdapterConfigurationError,
  AdapterId,
  type AdapterInvocationError,
  AdapterInternalError,
  AdapterProviderResponseError,
  AdapterRateLimitError,
  AdapterTimeoutError,
  AdapterTransportError,
} from '@yokai/protocol'
import { Effect, Exit, Fiber, FiberSet, Option, Redacted, Ref, Scope } from 'effect'

import { GeminiClientFactory } from '../client/client-factory.js'
import type {
  Connection as ConnectionConfiguration,
  ConnectionId,
  DiscoveryRetryPolicy,
} from '../config/configuration.js'

const GEMINI_ADAPTER_ID = AdapterId.make('gemini')
const DISCOVERY_OPERATION = 'discoverModels'

export interface Summary {
  readonly connectionId: ConnectionId
  readonly displayName: string
  readonly discoveryRetry: DiscoveryRetryPolicy
}

export interface ModelPage {
  readonly models: ReadonlyArray<Model>
  readonly nextPageToken: Option.Option<string>
}

export interface Interface {
  readonly summary: Summary
  readonly listModels: (
    params: ListModelsParameters,
  ) => Effect.Effect<ModelPage, AdapterInvocationError>
  readonly close: () => Effect.Effect<void>
}

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

const closedConnectionError = () =>
  new AdapterConfigurationError({
    adapterId: GEMINI_ADAPTER_ID,
    operation: DISCOVERY_OPERATION,
    message: 'Gemini connection is closed',
  })

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

const pageToken = (pager: Pager<Model>): Option.Option<string> => {
  const config = pager.params.config
  return config === undefined ? Option.none() : Option.fromUndefinedOr(config.pageToken)
}

export const make = Effect.fn('GeminiConnection.make')(function* (
  configuration: ConnectionConfiguration,
  owningScope: Scope.Closeable,
) {
  const clientFactory = yield* GeminiClientFactory.Service
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      Redacted.wipeUnsafe(configuration.apiKey)
    }),
  )
  const client = yield* clientFactory.create(configuration)
  const clientRef = yield* Ref.make(Option.some(client))
  yield* Effect.addFinalizer(() => Ref.set(clientRef, Option.none()))
  const requests = yield* FiberSet.make()

  const listModels = Effect.fn('GeminiConnection.listModels')(function* (
    params: ListModelsParameters,
  ) {
    const currentClient = yield* Ref.get(clientRef)
    if (Option.isNone(currentClient)) return yield* Effect.fail(closedConnectionError())

    const request = Effect.tryPromise({
      try: (signal) => currentClient.value.listModels(params, signal),
      catch: (cause) => {
        if (cause instanceof ApiError) return classifyApiError(cause)
        if (cause instanceof Error && cause.name === 'AbortError') return timeoutError()
        if (cause instanceof Error && cause.name === 'TimeoutError') return timeoutError()
        if (cause instanceof TypeError) return transportError()
        return internalError()
      },
    })

    const pager = yield* Effect.acquireUseRelease(
      FiberSet.run(requests, request),
      Fiber.join,
      Fiber.interrupt,
    )

    return {
      models: [...pager.page],
      nextPageToken: pageToken(pager),
    }
  })

  return {
    summary: {
      connectionId: configuration.connectionId,
      displayName: configuration.displayName,
      discoveryRetry: configuration.discoveryRetry,
    },
    listModels,
    close: Effect.fn('GeminiConnection.close')(function* () {
      yield* Scope.close(owningScope, Exit.void)
    }),
  } satisfies Interface
})

export * as GeminiConnection from './connection.js'
