import {
  GoogleGenAI,
  type ListModelsConfig,
  type ListModelsParameters,
  type Model,
  type Pager,
} from '@google/genai'
import { Context, Effect, Layer, Redacted, Schema, Scope } from 'effect'

import type { Configuration, Endpoint } from '../config/configuration'

export interface Client {
  readonly listModels: (params: ListModelsParameters, signal: AbortSignal) => Promise<Pager<Model>>
}

/** Narrow SDK seam. The GoogleGenAI object itself must remain closure-private. */
export interface SdkClient {
  readonly listModels: (params: ListModelsParameters) => Promise<Pager<Model>>
}

export interface SdkClientFactory {
  readonly create: (endpoint: Endpoint, requestTimeoutMs: number) => SdkClient
}

export class InitializationError extends Schema.TaggedError<InitializationError>(
  '@yokai/koishi-plugin-yokai-adapter-gemini/ClientInitializationError',
)('GeminiClientInitializationError', {
  message: Schema.Literal('Unable to initialize Gemini client'),
}) {}

export interface Interface {
  readonly create: (
    endpoint: Endpoint,
    requestTimeoutMs: Configuration['requestTimeoutMs'],
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
  const { abortSignal: _abortSignal, httpOptions: _httpOptions, ...safeConfig } = config
  return {
    ...safeConfig,
    abortSignal: signal,
  }
}

const makeInitializationError = () =>
  new InitializationError({
    message: 'Unable to initialize Gemini client',
  })

const liveSdkClientFactory: SdkClientFactory = {
  create: (endpoint, requestTimeoutMs) => {
    const client = new GoogleGenAI({
      vertexai: false,
      apiKey: Redacted.value(endpoint.apiKey),
      httpOptions: {
        baseUrl: endpoint.baseUrl.toString(),
        timeout: requestTimeoutMs,
      },
    })

    return {
      listModels: (params) => client.models.list(params),
    }
  },
}

const makeCreate = (sdkClientFactory: SdkClientFactory) =>
  Effect.fn('GeminiClientFactory.create')(function* (
    endpoint: Endpoint,
    requestTimeoutMs: Configuration['requestTimeoutMs'],
  ) {
    yield* Scope.Scope

    return yield* Effect.try({
      try: () => {
        const sdkClient = sdkClientFactory.create(endpoint, requestTimeoutMs)

        return {
          listModels: (params, signal) =>
            sdkClient.listModels({
              ...params,
              config: withAbortSignal(params.config, signal),
            }),
        } satisfies Client
      },
      catch: makeInitializationError,
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

export * as GeminiClientFactory from './client-factory'
