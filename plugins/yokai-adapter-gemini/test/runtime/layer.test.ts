import { expect, it } from '@effect/vitest'
import { Effect, ManagedRuntime } from 'effect'
import { inspect } from 'node:util'

import { GeminiConnectionPool } from '../../src/connection/pool.js'
import { GeminiRuntime } from '../../src/runtime/layer.js'

const FIRST_API_KEY = 'first-runtime-api-key-canary'
const SECOND_API_KEY = 'second-runtime-api-key-canary'

const makeConnection = (connectionId: string, displayName: string, apiKey: string) => ({
  connectionId,
  displayName,
  apiKey,
  baseUrl: 'https://generativelanguage.googleapis.com/',
  requestTimeoutMs: 60_000,
  discoveryRetry: {
    maxAttempts: 3,
    initialDelayMs: 1_000,
    maxDelayMs: 10_000,
    backoffMultiplier: 2,
  },
})

it.effect('builds synchronously without exposing SDK clients or credentials', () => {
  const runtime = ManagedRuntime.make(
    GeminiRuntime.makeLayer({
      connections: [
        makeConnection('first', 'First connection', FIRST_API_KEY),
        makeConnection('second', 'Second connection', SECOND_API_KEY),
      ],
    }),
  )

  return Effect.acquireUseRelease(
    Effect.succeed(runtime),
    (currentRuntime) =>
      Effect.gen(function* () {
        const pool = yield* Effect.sync(() => currentRuntime.runSync(GeminiConnectionPool.Service))
        const surfaces = [JSON.stringify(pool), inspect(pool)]

        expect(pool.summaries).toEqual([
          {
            connectionId: 'first',
            displayName: 'First connection',
            discoveryRetry: {
              maxAttempts: 3,
              initialDelayMs: 1_000,
              maxDelayMs: 10_000,
              backoffMultiplier: 2,
            },
          },
          {
            connectionId: 'second',
            displayName: 'Second connection',
            discoveryRetry: {
              maxAttempts: 3,
              initialDelayMs: 1_000,
              maxDelayMs: 10_000,
              backoffMultiplier: 2,
            },
          },
        ])
        expect(surfaces.every((surface) => !surface.includes(FIRST_API_KEY))).toBe(true)
        expect(surfaces.every((surface) => !surface.includes(SECOND_API_KEY))).toBe(true)
        expect(surfaces.every((surface) => !surface.includes('GoogleGenAI'))).toBe(true)
        expect(surfaces.every((surface) => !surface.includes('apiClient'))).toBe(true)
      }),
    (currentRuntime) => currentRuntime.disposeEffect,
  )
})
