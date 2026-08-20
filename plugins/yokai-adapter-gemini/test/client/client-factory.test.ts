import { PagedItem, Pager, type ListModelsParameters, type Model } from '@google/genai'
import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { inspect } from 'node:util'

import { GeminiClientFactory } from '../../src/client/client-factory.js'
import { GeminiConfiguration } from '../../src/config/configuration.js'

const API_KEY_CANARY = 'gemini-api-key-canary'
const SDK_ERROR_CANARY = 'sdk-error-secret-canary'

const makeConnection = Schema.decodeUnknownEffect(GeminiConfiguration.Connection)

const connectionInput = {
  connectionId: 'connection-a',
  displayName: 'Connection A',
  apiKey: API_KEY_CANARY,
  baseUrl: 'https://generativelanguage.googleapis.com/',
  requestTimeoutMs: 60_000,
  discoveryRetry: {
    maxAttempts: 3,
    initialDelayMs: 1_000,
    maxDelayMs: 10_000,
    backoffMultiplier: 2,
  },
}

const makeEmptyPager = () =>
  new Pager<Model>(
    PagedItem.PAGED_ITEM_MODELS,
    () => Promise.resolve({ models: [] }),
    { models: [] },
    { config: {} },
  )

it.effect('keeps GoogleGenAI and its API key inside a closure-private port', () =>
  Effect.gen(function* () {
    const connection = yield* makeConnection(connectionInput)
    const factory = yield* GeminiClientFactory.Service
    const first = yield* factory.create(connection)
    const second = yield* factory.create(connection)

    const json = JSON.stringify({ first, second })
    const inspected = inspect({ first, second })

    expect(Object.keys(first)).toEqual(['listModels'])
    expect(first).not.toBe(second)
    expect(first.listModels).not.toBe(second.listModels)
    expect(json).not.toContain(API_KEY_CANARY)
    expect(inspected).not.toContain(API_KEY_CANARY)
    expect(json).not.toContain('GoogleGenAI')
    expect(inspected).not.toContain('GoogleGenAI')
    expect(json).not.toContain('apiClient')
    expect(inspected).not.toContain('apiClient')
  }).pipe(Effect.provide(GeminiClientFactory.layer), Effect.scoped),
)

it.effect('forwards the Effect abort signal and removes SDK retry options', () => {
  const captured: Array<ListModelsParameters> = []
  const testLayer = GeminiClientFactory.layerWithSdkClientFactory({
    create: () => ({
      listModels: (params) => {
        captured.push(params)
        return Promise.resolve(makeEmptyPager())
      },
    }),
  })

  return Effect.gen(function* () {
    const connection = yield* makeConnection(connectionInput)
    const factory = yield* GeminiClientFactory.Service
    const client = yield* factory.create(connection)
    const effectController = new AbortController()
    const ignoredController = new AbortController()

    yield* Effect.tryPromise(() =>
      client.listModels(
        {
          config: {
            abortSignal: ignoredController.signal,
            pageSize: 25,
            httpOptions: {
              timeout: 1_234,
              retryOptions: { attempts: 5 },
            },
          },
        },
        effectController.signal,
      ),
    )

    const request = captured[0]
    expect(request).toBeDefined()
    if (request === undefined) return
    const config = request.config
    expect(config).toBeDefined()
    if (config === undefined) return
    const httpOptions = config.httpOptions
    expect(httpOptions).toBeDefined()
    if (httpOptions === undefined) return

    expect(config.abortSignal).toBe(effectController.signal)
    expect(config.pageSize).toBe(25)
    expect(httpOptions.timeout).toBe(1_234)
    expect(httpOptions.retryOptions).toBeUndefined()
  }).pipe(Effect.provide(testLayer), Effect.scoped)
})

it.effect('maps initialization failures to a safe public error', () => {
  const testLayer = GeminiClientFactory.layerWithSdkClientFactory({
    create: () => {
      throw new Error(SDK_ERROR_CANARY + API_KEY_CANARY)
    },
  })

  return Effect.gen(function* () {
    const connection = yield* makeConnection(connectionInput)
    const factory = yield* GeminiClientFactory.Service
    const error = yield* factory.create(connection).pipe(Effect.flip)
    const surfaces = [String(error), JSON.stringify(error), inspect(error)]

    expect(error._tag).toBe('GeminiClientInitializationError')
    expect(error.connectionId).toBe('connection-a')
    expect(error.message).toBe('Unable to initialize Gemini client')
    expect('cause' in error).toBe(false)
    expect(surfaces.every((surface) => !surface.includes(API_KEY_CANARY))).toBe(true)
    expect(surfaces.every((surface) => !surface.includes(SDK_ERROR_CANARY))).toBe(true)
    expect(surfaces.every((surface) => !surface.includes('GoogleGenAI'))).toBe(true)
  }).pipe(Effect.provide(testLayer), Effect.scoped)
})
