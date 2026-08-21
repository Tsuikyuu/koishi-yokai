import {
  GenerateContentResponse,
  PagedItem,
  Pager,
  type GenerateContentParameters,
  type ListModelsParameters,
  type Model,
} from '@google/genai'
import { expect, it } from '@effect/vitest'
import { Effect, Layer, Redacted, Schema } from 'effect'
import { inspect } from 'node:util'

import { GeminiClientFactory } from '../../src/client/client-factory'
import { GeminiConfiguration } from '../../src/config/configuration'
import { GeminiHttpTransport } from '../../src/transport/http-transport'

const PRIMARY_API_KEY_CANARY = 'gemini-primary-api-key-canary'
const FALLBACK_API_KEY_CANARY = 'gemini-fallback-api-key-canary'
const SDK_ERROR_CANARY = 'sdk-error-secret-canary'
const PRIMARY_BASE_URL = 'https://generativelanguage.googleapis.com/'
const FALLBACK_BASE_URL = 'https://gemini-fallback.example.com/'
const unusedFetch: GeminiHttpTransport.FetchImplementation = () =>
  Promise.reject(new Error('Unexpected HTTP request'))
const unusedGenerateContent = () => Promise.reject(new Error('Unexpected generation request'))
const transportLayer = GeminiHttpTransport.layerWithFetch(unusedFetch)

const makeEndpoint = Schema.decodeUnknownEffect(GeminiConfiguration.Endpoint)

const primaryEndpointInput = {
  apiKey: PRIMARY_API_KEY_CANARY,
  baseUrl: PRIMARY_BASE_URL,
}

const fallbackEndpointInput = {
  apiKey: FALLBACK_API_KEY_CANARY,
  baseUrl: FALLBACK_BASE_URL,
}

const makeEmptyPager = () =>
  new Pager<Model>(
    PagedItem.PAGED_ITEM_MODELS,
    () => Promise.resolve({ models: [] }),
    { models: [] },
    { config: {} },
  )

it.effect('keeps GoogleGenAI and endpoint API keys inside closure-private ports', () =>
  Effect.gen(function* () {
    const endpoint = yield* makeEndpoint(primaryEndpointInput)
    const factory = yield* GeminiClientFactory.Service
    const first = yield* factory.create(endpoint)
    const second = yield* factory.create(endpoint)

    const json = JSON.stringify({ first, second })
    const inspected = inspect({ first, second })

    expect(Object.keys(first).sort()).toEqual(['generateContent', 'listModels'])
    expect(first).not.toBe(second)
    expect(first.listModels).not.toBe(second.listModels)
    expect(first.generateContent).not.toBe(second.generateContent)
    expect(json).not.toContain(PRIMARY_API_KEY_CANARY)
    expect(inspected).not.toContain(PRIMARY_API_KEY_CANARY)
    expect(json).not.toContain('GoogleGenAI')
    expect(inspected).not.toContain('GoogleGenAI')
    expect(json).not.toContain('apiClient')
    expect(inspected).not.toContain('apiClient')
  }).pipe(
    Effect.provide(GeminiClientFactory.layer.pipe(Layer.provide(transportLayer))),
    Effect.scoped,
  ),
)

it.effect(
  'injects the same instance-local fetch while endpoint SDK inputs differ by URL and key',
  () => {
    const captured: Array<{
      readonly endpoint: GeminiConfiguration.Endpoint
      readonly fetchImplementation: GeminiHttpTransport.FetchImplementation
    }> = []
    const testLayer = GeminiClientFactory.layerWithSdkClientFactory({
      create: (endpoint, fetchImplementation) => {
        captured.push({ endpoint, fetchImplementation })
        return {
          listModels: () => Promise.resolve(makeEmptyPager()),
          generateContent: unusedGenerateContent,
        }
      },
    }).pipe(Layer.provide(transportLayer))

    return Effect.gen(function* () {
      const primaryEndpoint = yield* makeEndpoint(primaryEndpointInput)
      const fallbackEndpoint = yield* makeEndpoint(fallbackEndpointInput)
      const factory = yield* GeminiClientFactory.Service

      yield* factory.create(primaryEndpoint)
      yield* factory.create(fallbackEndpoint)

      const primaryCapture = captured[0]
      const fallbackCapture = captured[1]
      if (primaryCapture === undefined || fallbackCapture === undefined) {
        return yield* Effect.die('Expected both endpoint SDK creations to be captured')
      }

      expect(captured).toHaveLength(2)
      expect(primaryCapture.fetchImplementation).toBe(unusedFetch)
      expect(fallbackCapture.fetchImplementation).toBe(unusedFetch)
      expect(Object.keys(primaryCapture.endpoint).sort()).toEqual(['apiKey', 'baseUrl'])
      expect(Object.keys(fallbackCapture.endpoint).sort()).toEqual(['apiKey', 'baseUrl'])
      expect(primaryCapture.endpoint.baseUrl).toEqual(new URL(PRIMARY_BASE_URL))
      expect(fallbackCapture.endpoint.baseUrl).toEqual(new URL(FALLBACK_BASE_URL))
      expect(Redacted.value(primaryCapture.endpoint.apiKey)).toBe(PRIMARY_API_KEY_CANARY)
      expect(Redacted.value(fallbackCapture.endpoint.apiKey)).toBe(FALLBACK_API_KEY_CANARY)
    }).pipe(Effect.provide(testLayer), Effect.scoped)
  },
)

it.effect('forwards safe list options and removes call-level SDK HTTP options', () => {
  const captured: Array<ListModelsParameters> = []
  const testLayer = GeminiClientFactory.layerWithSdkClientFactory({
    create: () => ({
      listModels: (params) => {
        captured.push(params)
        return Promise.resolve(makeEmptyPager())
      },
      generateContent: unusedGenerateContent,
    }),
  }).pipe(Layer.provide(transportLayer))

  return Effect.gen(function* () {
    const endpoint = yield* makeEndpoint(primaryEndpointInput)
    const factory = yield* GeminiClientFactory.Service
    const client = yield* factory.create(endpoint)
    const effectController = new AbortController()
    const ignoredController = new AbortController()

    yield* Effect.tryPromise(() =>
      client.listModels(
        {
          config: {
            abortSignal: ignoredController.signal,
            pageSize: 25,
            pageToken: 'next-page-token',
            filter: 'display_name:gemini',
            queryBase: true,
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
    if (request === undefined) {
      return yield* Effect.die('Expected the SDK list request to be captured')
    }
    const config = request.config
    if (config === undefined) {
      return yield* Effect.die('Expected the SDK list request config')
    }

    expect(config.abortSignal).toBe(effectController.signal)
    expect(config.pageSize).toBe(25)
    expect(config.pageToken).toBe('next-page-token')
    expect(config.filter).toBe('display_name:gemini')
    expect(config.queryBase).toBe(true)
    expect(config.httpOptions).toBeUndefined()
    expect(Object.keys(config).sort()).toEqual([
      'abortSignal',
      'filter',
      'pageSize',
      'pageToken',
      'queryBase',
    ])
  }).pipe(Effect.provide(testLayer), Effect.scoped)
})

it.effect('injects the Effect signal and removes call-level HTTP options for generation', () => {
  const captured: Array<GenerateContentParameters> = []
  const testLayer = GeminiClientFactory.layerWithSdkClientFactory({
    create: () => ({
      listModels: () => Promise.resolve(makeEmptyPager()),
      generateContent: (params) => {
        captured.push(params)
        return Promise.resolve(new GenerateContentResponse())
      },
    }),
  }).pipe(Layer.provide(transportLayer))

  return Effect.gen(function* () {
    const endpoint = yield* makeEndpoint(primaryEndpointInput)
    const factory = yield* GeminiClientFactory.Service
    const client = yield* factory.create(endpoint)
    const effectController = new AbortController()
    const ignoredController = new AbortController()

    yield* Effect.tryPromise(() =>
      client.generateContent(
        {
          model: 'gemini-test',
          contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
          config: {
            abortSignal: ignoredController.signal,
            maxOutputTokens: 256,
            candidateCount: 1,
            automaticFunctionCalling: { disable: true },
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
    if (request === undefined) {
      return yield* Effect.die('Expected the SDK generation request to be captured')
    }
    const config = request.config
    if (config === undefined) {
      return yield* Effect.die('Expected the SDK generation request config')
    }

    expect(config.abortSignal).toBe(effectController.signal)
    expect(config.maxOutputTokens).toBe(256)
    expect(config.candidateCount).toBe(1)
    expect(config.automaticFunctionCalling).toEqual({ disable: true })
    expect(config.httpOptions).toBeUndefined()
    expect(Object.keys(config).sort()).toEqual([
      'abortSignal',
      'automaticFunctionCalling',
      'candidateCount',
      'maxOutputTokens',
    ])
  }).pipe(Effect.provide(testLayer), Effect.scoped)
})

it.effect('maps initialization failures to a safe endpoint-agnostic public error', () => {
  const testLayer = GeminiClientFactory.layerWithSdkClientFactory({
    create: () => {
      throw new Error(SDK_ERROR_CANARY + PRIMARY_API_KEY_CANARY)
    },
  }).pipe(Layer.provide(transportLayer))

  return Effect.gen(function* () {
    const endpoint = yield* makeEndpoint(primaryEndpointInput)
    const factory = yield* GeminiClientFactory.Service
    const error = yield* factory.create(endpoint).pipe(Effect.flip)
    const surfaces = [String(error), JSON.stringify(error), inspect(error)]

    expect(error._tag).toBe('GeminiClientInitializationError')
    expect(error.message).toBe('Unable to initialize Gemini client')
    expect('connectionId' in error).toBe(false)
    expect('displayName' in error).toBe(false)
    expect('endpoint' in error).toBe(false)
    expect('cause' in error).toBe(false)
    expect(surfaces.every((surface) => !surface.includes(PRIMARY_API_KEY_CANARY))).toBe(true)
    expect(surfaces.every((surface) => !surface.includes(SDK_ERROR_CANARY))).toBe(true)
    expect(surfaces.every((surface) => !surface.includes('GoogleGenAI'))).toBe(true)
  }).pipe(Effect.provide(testLayer), Effect.scoped)
})
