import {
  ApiError,
  FinishReason,
  GenerateContentResponse,
  type GenerateContentParameters,
} from '@google/genai'
import { expect, it } from '@effect/vitest'
import { AdapterId, AdapterModelId } from '@yokai/protocol'
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Ref } from 'effect'

import { GeminiClientFactory } from '../../src/client/client-factory'
import { GeminiConfiguration } from '../../src/config/configuration'
import { GeminiConnection } from '../../src/connection/connection'

const ADAPTER_ID = AdapterId.make('gemini-generation-connection-test')
const MODEL_ID = AdapterModelId.make('gemini-2.5-flash')
const PRIMARY_URL = 'https://primary.example.com/'
const SECONDARY_URL = 'https://secondary.example.com/'

const configuration = {
  adapterId: ADAPTER_ID,
  endpoints: [
    { apiKey: 'primary-key', baseUrl: PRIMARY_URL },
    { apiKey: 'secondary-key', baseUrl: SECONDARY_URL },
  ],
  requestTimeoutMs: 60_000,
  discoveryRetry: {
    maxAttempts: 3,
    initialDelayMs: 1_000,
    maxDelayMs: 10_000,
    backoffMultiplier: 2,
  },
}

const parameters: GenerateContentParameters = {
  model: MODEL_ID,
  contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
  config: { maxOutputTokens: 128 },
}

const response = Object.assign(new GenerateContentResponse(), {
  candidates: [
    {
      content: { parts: [{ text: 'Hello back' }] },
      finishReason: FinishReason.STOP,
    },
  ],
})

const makeLayer = (clientFactory: GeminiClientFactory.Interface) =>
  GeminiConnection.layer.pipe(
    Layer.provide(GeminiConfiguration.layer(configuration)),
    Layer.provide(Layer.succeed(GeminiClientFactory.Service, clientFactory)),
  )

it.effect('fails over with the same model and keeps the successful endpoint active', () =>
  Effect.gen(function* () {
    const invoked = yield* Ref.make<
      ReadonlyArray<{ readonly baseUrl: string; readonly model: string }>
    >([])
    const primaryCalls = yield* Ref.make(0)
    const clientFactory = GeminiClientFactory.Service.of({
      create: Effect.fn('GeminiGenerationConnectionTest.ClientFactory.create')(
        (endpoint: GeminiConfiguration.Endpoint) => {
          const baseUrl = endpoint.baseUrl.toString()
          return Effect.succeed({
            listModels: () => Promise.reject(new Error('Unexpected model discovery request')),
            generateContent: (params, _signal) => {
              Ref.update(invoked, (entries) => [...entries, { baseUrl, model: params.model }]).pipe(
                Effect.runSync,
              )
              if (baseUrl === PRIMARY_URL) {
                const count = Ref.getAndUpdate(primaryCalls, (current) => current + 1).pipe(
                  Effect.runSync,
                )
                if (count === 0) {
                  return Promise.reject(new ApiError({ status: 503, message: 'unavailable' }))
                }
              }
              return Promise.resolve(response)
            },
          })
        },
      ),
    })

    yield* Effect.gen(function* () {
      const connection = yield* GeminiConnection.Service
      yield* connection.generateContent('generate', MODEL_ID, parameters, Effect.succeed)
      yield* connection.generateContent('generate', MODEL_ID, parameters, Effect.succeed)
    }).pipe(Effect.provide(makeLayer(clientFactory)))

    expect(yield* Ref.get(invoked)).toEqual([
      { baseUrl: PRIMARY_URL, model: MODEL_ID },
      { baseUrl: SECONDARY_URL, model: MODEL_ID },
      { baseUrl: SECONDARY_URL, model: MODEL_ID },
    ])
  }),
)

it.effect('propagates caller interruption to the active SDK AbortSignal', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<AbortSignal>()
    const aborted = yield* Deferred.make<void>()
    const clientFactory = GeminiClientFactory.Service.of({
      create: Effect.fn('GeminiGenerationConnectionTest.BlockingClientFactory.create')(() =>
        Effect.succeed({
          listModels: () => Promise.reject(new Error('Unexpected model discovery request')),
          generateContent: (_params, signal) =>
            new Promise<GenerateContentResponse>((_resolve, reject) => {
              Deferred.succeed(started, signal).pipe(Effect.runSync)
              signal.addEventListener(
                'abort',
                () => {
                  Deferred.succeed(aborted, undefined).pipe(Effect.runSync)
                  const error = new Error('aborted')
                  error.name = 'AbortError'
                  reject(error)
                },
                { once: true },
              )
            }),
        }),
      ),
    })

    yield* Effect.gen(function* () {
      const connection = yield* GeminiConnection.Service
      const fiber = yield* Effect.forkChild(
        connection.generateContent('generate', MODEL_ID, parameters, Effect.succeed),
      )
      const signal = yield* Deferred.await(started)
      expect(signal.aborted).toBe(false)

      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      yield* Deferred.await(aborted)
      expect(signal.aborted).toBe(true)
    }).pipe(Effect.provide(makeLayer(clientFactory)))
  }),
)

it.effect('labels provider failures from the final request as continuation failures', () =>
  Effect.gen(function* () {
    const clientFactory = GeminiClientFactory.Service.of({
      create: Effect.fn('GeminiGenerationConnectionTest.FailingClientFactory.create')(() =>
        Effect.succeed({
          listModels: () => Promise.reject(new Error('Unexpected model discovery request')),
          generateContent: () =>
            Promise.reject(new ApiError({ status: 400, message: 'invalid continuation' })),
        }),
      ),
    })

    const failure = yield* Effect.gen(function* () {
      const connection = yield* GeminiConnection.Service
      return yield* connection
        .generateContent('continue', MODEL_ID, parameters, Effect.succeed)
        .pipe(Effect.flip)
    }).pipe(Effect.provide(makeLayer(clientFactory)))

    expect(failure._tag).toBe('AdapterProviderResponseError')
    expect(failure.operation).toBe('continue')
    if (failure._tag === 'AdapterProviderResponseError') {
      expect(failure.modelId).toBe(MODEL_ID)
    }
  }),
)
