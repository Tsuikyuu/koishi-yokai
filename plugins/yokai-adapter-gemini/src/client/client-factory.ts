import {
  GoogleGenAI,
  type ListModelsConfig,
  type ListModelsParameters,
  type Model,
  type Pager,
} from '@google/genai'
import { Context, Effect, Layer, Redacted, Schema, Scope } from 'effect'

import type { Endpoint } from '../config/configuration'
import { GeminiHttpTransport } from '../transport/http-transport'

export interface Client {
  readonly listModels: (params: ListModelsParameters, signal: AbortSignal) => Promise<Pager<Model>>
}

/** Narrow SDK seam. The GoogleGenAI object itself must remain closure-private. */
export interface SdkClient {
  readonly listModels: (params: ListModelsParameters) => Promise<Pager<Model>>
}

export interface SdkClientFactory {
  readonly create: (
    endpoint: Endpoint,
    fetchImplementation: GeminiHttpTransport.FetchImplementation,
  ) => SdkClient
}

export class InitializationError extends Schema.TaggedError<InitializationError>(
  '@yokai/koishi-plugin-yokai-adapter-gemini/ClientInitializationError',
)('GeminiClientInitializationError', {
  message: Schema.Literal('Unable to initialize Gemini client'),
}) {}

export interface Interface {
  readonly create: (endpoint: Endpoint) => Effect.Effect<Client, InitializationError, Scope.Scope>
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
  create: (endpoint, fetchImplementation) => {
    let fetchImplementationRead = false
    const client = new GoogleGenAI({
      vertexai: false,
      apiKey: Redacted.value(endpoint.apiKey),
      httpOptions: {
        baseUrl: endpoint.baseUrl.toString(),
      },
      get fetchImplementation() {
        fetchImplementationRead = true
        return fetchImplementation
      },
    })
    if (!fetchImplementationRead) {
      throw new Error('Installed @google/genai does not support instance-local fetch injection')
    }

    return {
      listModels: (params) => client.models.list(params),
    }
  },
}

const makeCreate = (
  sdkClientFactory: SdkClientFactory,
  fetchImplementation: GeminiHttpTransport.FetchImplementation,
) =>
  Effect.fn('GeminiClientFactory.create')(function* (endpoint: Endpoint) {
    yield* Scope.Scope

    return yield* Effect.try({
      try: () => {
        const sdkClient = sdkClientFactory.create(endpoint, fetchImplementation)

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
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const transport = yield* GeminiHttpTransport.Service
      return Service.of({
        create: makeCreate(sdkClientFactory, transport.fetch),
      })
    }),
  )

export const layer = layerWithSdkClientFactory(liveSdkClientFactory)

export * as GeminiClientFactory from './client-factory'
