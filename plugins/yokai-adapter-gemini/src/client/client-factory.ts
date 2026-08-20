import {
  GoogleGenAI,
  type ListModelsConfig,
  type ListModelsParameters,
  type Model,
  type Pager,
} from '@google/genai'
import { Context, Effect, Layer, Redacted, Schema, Scope } from 'effect'

import type { Connection, ConnectionId } from '../config/configuration.js'

export interface Client {
  readonly listModels: (params: ListModelsParameters, signal: AbortSignal) => Promise<Pager<Model>>
}

/** Narrow SDK seam. The GoogleGenAI object itself must remain closure-private. */
export interface SdkClient {
  readonly listModels: (params: ListModelsParameters) => Promise<Pager<Model>>
}

export interface SdkClientFactory {
  readonly create: (connection: Connection) => SdkClient
}

export class InitializationError extends Schema.TaggedError<InitializationError>(
  '@yokai/koishi-plugin-yokai-adapter-gemini/ClientInitializationError',
)('GeminiClientInitializationError', {
  connectionId: Schema.String,
  message: Schema.Literal('Unable to initialize Gemini client'),
}) {}

export interface Interface {
  readonly create: (
    connection: Connection,
  ) => Effect.Effect<Client, InitializationError, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/koishi-plugin-yokai-adapter-gemini/ClientFactory',
) {}

const withAbortSignal = (
  config: ListModelsConfig | undefined,
  signal: AbortSignal,
): ListModelsConfig => {
  if (config === undefined) return { abortSignal: signal }
  if (config.httpOptions === undefined) return { ...config, abortSignal: signal }

  const { retryOptions: _retryOptions, ...httpOptions } = config.httpOptions
  return {
    ...config,
    httpOptions,
    abortSignal: signal,
  }
}

const makeInitializationError = (connectionId: ConnectionId) =>
  new InitializationError({
    connectionId,
    message: 'Unable to initialize Gemini client',
  })

const liveSdkClientFactory: SdkClientFactory = {
  create: (connection) => {
    const client = new GoogleGenAI({
      vertexai: false,
      apiKey: Redacted.value(connection.apiKey),
      httpOptions: {
        baseUrl: connection.baseUrl.toString(),
        timeout: connection.requestTimeoutMs,
      },
    })

    return {
      listModels: (params) => client.models.list(params),
    }
  },
}

const makeCreate = (sdkClientFactory: SdkClientFactory) =>
  Effect.fn('GeminiClientFactory.create')(function* (connection: Connection) {
    yield* Scope.Scope

    return yield* Effect.try({
      try: () => {
        const sdkClient = sdkClientFactory.create(connection)

        return {
          listModels: (params, signal) =>
            sdkClient.listModels({
              ...params,
              config: withAbortSignal(params.config, signal),
            }),
        } satisfies Client
      },
      catch: () => makeInitializationError(connection.connectionId),
    })
  })

/** Internal injection seam for deterministic adapter tests. */
export const layerWithSdkClientFactory = (sdkClientFactory: SdkClientFactory) =>
  Layer.succeed(
    Service,
    Service.of({
      create: makeCreate(sdkClientFactory),
    }),
  )

export const layer = layerWithSdkClientFactory(liveSdkClientFactory)

export * as GeminiClientFactory from './client-factory.js'
