import { expect, it } from '@effect/vitest'
import { CURRENT_ADAPTER_PROTOCOL_VERSION } from '@yokai/protocol'
import { Effect, ManagedRuntime } from 'effect'
import { inspect } from 'node:util'

import { GeminiAdapter } from '../../src/adapter/adapter'
import { GeminiConnection } from '../../src/connection/connection'
import { GeminiModelDiscovery } from '../../src/discovery/discovery'
import { GeminiTextGeneration } from '../../src/generation/generation'
import { GeminiRuntime } from '../../src/runtime/layer'
import { GeminiHttpTransport } from '../../src/transport/http-transport'

const FIRST_API_KEY = 'first-runtime-api-key-canary'
const SECOND_API_KEY = 'second-runtime-api-key-canary'
const ADAPTER_ID = 'gemini-runtime-test'

const makeEndpoint = (apiKey: string, baseUrl: string) => ({
  apiKey,
  baseUrl,
})

const configuration = {
  adapterId: ADAPTER_ID,
  endpoints: [
    makeEndpoint(FIRST_API_KEY, 'https://primary.example.com/'),
    makeEndpoint(SECOND_API_KEY, 'https://secondary.example.com/'),
  ],
  requestTimeoutMs: 60_000,
  discoveryRetry: {
    maxAttempts: 3,
    initialDelayMs: 1_000,
    maxDelayMs: 10_000,
    backoffMultiplier: 2,
  },
}

it.effect('builds synchronously without exposing SDK clients or credentials', () => {
  const httpTransport = GeminiHttpTransport.layerWithFetch(() =>
    Promise.reject(new Error('Unexpected HTTP request')),
  )
  const runtime = ManagedRuntime.make(
    GeminiRuntime.makeLayerWithTransport(configuration, httpTransport),
  )

  return Effect.acquireUseRelease(
    Effect.succeed(runtime),
    (currentRuntime) =>
      Effect.gen(function* () {
        const connection = yield* Effect.sync(() =>
          currentRuntime.runSync(GeminiConnection.Service),
        )
        const discovery = yield* Effect.sync(() =>
          currentRuntime.runSync(GeminiModelDiscovery.Service),
        )
        const generation = yield* Effect.sync(() =>
          currentRuntime.runSync(GeminiTextGeneration.Service),
        )
        const adapter = yield* Effect.sync(() => currentRuntime.runSync(GeminiAdapter.Service))
        const surfaces = [
          JSON.stringify(connection),
          inspect(connection),
          JSON.stringify(discovery),
          inspect(discovery),
          JSON.stringify(generation),
          inspect(generation),
          JSON.stringify(adapter),
          inspect(adapter),
        ]

        expect(connection.discoveryRetry).toEqual({
          maxAttempts: 3,
          initialDelayMs: 1_000,
          maxDelayMs: 10_000,
          backoffMultiplier: 2,
        })
        expect(connection.adapterId).toBe(ADAPTER_ID)
        expect(discovery.adapterId).toBe(ADAPTER_ID)
        expect(generation.adapterId).toBe(ADAPTER_ID)
        expect(adapter.descriptor).toEqual({
          id: ADAPTER_ID,
          protocolVersion: CURRENT_ADAPTER_PROTOCOL_VERSION,
          capabilities: { feedbackTools: false },
        })
        expect(surfaces.every((surface) => !surface.includes(FIRST_API_KEY))).toBe(true)
        expect(surfaces.every((surface) => !surface.includes(SECOND_API_KEY))).toBe(true)
        expect(surfaces.every((surface) => !surface.includes('GoogleGenAI'))).toBe(true)
        expect(surfaces.every((surface) => !surface.includes('apiClient'))).toBe(true)
      }),
    (currentRuntime) => currentRuntime.disposeEffect,
  )
})
