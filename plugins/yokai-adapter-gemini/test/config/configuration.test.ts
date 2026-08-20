import { expect, it } from '@effect/vitest'
import { Cause, Effect, Exit, Redacted, Schema } from 'effect'
import { vi } from 'vitest'

vi.mock('koishi', async () => {
  const { Schema } = await import('@satorijs/core')
  return { Schema }
})

import { GeminiConfiguration } from '../../src/config/configuration.js'
import {
  Config,
  DEFAULT_DISCOVERY_BACKOFF_MULTIPLIER,
  DEFAULT_DISCOVERY_INITIAL_DELAY_MS,
  DEFAULT_DISCOVERY_MAX_ATTEMPTS,
  DEFAULT_DISCOVERY_MAX_DELAY_MS,
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from '../../src/config/plugin-config.js'

const CANARY_API_KEY = 'gemini-canary-api-key-must-not-leak'

const makeConnection = (
  connectionId = 'primary',
  apiKey = CANARY_API_KEY,
  baseUrl = DEFAULT_GEMINI_BASE_URL,
) => ({
  connectionId,
  displayName: `${connectionId} connection`,
  apiKey,
  baseUrl,
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  discoveryRetry: {
    maxAttempts: DEFAULT_DISCOVERY_MAX_ATTEMPTS,
    initialDelayMs: DEFAULT_DISCOVERY_INITIAL_DELAY_MS,
    maxDelayMs: DEFAULT_DISCOVERY_MAX_DELAY_MS,
    backoffMultiplier: DEFAULT_DISCOVERY_BACKOFF_MULTIPLIER,
  },
})

const expectInvalid = Effect.fn('GeminiConfigurationTest.expectInvalid')(function* (input: object) {
  const error = yield* GeminiConfiguration.decode(input).pipe(Effect.flip)

  expect(error).toBeInstanceOf(GeminiConfiguration.ConfigurationError)
  expect(error._tag).toBe('GeminiConfigurationError')
  expect(error.message).toBe('Invalid Gemini adapter configuration')

  return error
})

it.effect('applies Koishi defaults and decodes API keys as redacted values', () =>
  Effect.gen(function* () {
    const pluginConfig = Config({
      connections: [
        {
          connectionId: 'primary',
          displayName: 'Primary connection',
          apiKey: CANARY_API_KEY,
        },
      ],
    })
    const pluginConnection = pluginConfig.connections[0]
    if (pluginConnection === undefined) {
      return yield* Effect.die('Expected Koishi to retain the configured connection')
    }

    expect(pluginConnection.baseUrl).toBe(DEFAULT_GEMINI_BASE_URL)
    expect(pluginConnection.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS)
    expect(pluginConnection.discoveryRetry).toEqual({
      maxAttempts: DEFAULT_DISCOVERY_MAX_ATTEMPTS,
      initialDelayMs: DEFAULT_DISCOVERY_INITIAL_DELAY_MS,
      maxDelayMs: DEFAULT_DISCOVERY_MAX_DELAY_MS,
      backoffMultiplier: DEFAULT_DISCOVERY_BACKOFF_MULTIPLIER,
    })

    const configuration = yield* GeminiConfiguration.decode(pluginConfig)
    const connection = configuration.connections[0]

    expect(connection.connectionId).toBe('primary')
    expect(connection.displayName).toBe('Primary connection')
    expect(connection.baseUrl).toEqual(new URL(DEFAULT_GEMINI_BASE_URL))
    expect(Redacted.isRedacted(connection.apiKey)).toBe(true)
    expect(String(connection.apiKey)).toBe('<redacted:GeminiApiKey>')
    expect(Redacted.value(connection.apiKey)).toBe(CANARY_API_KEY)
  }),
)

it.effect('marks the connection table and API key field with Koishi UI roles', () =>
  Effect.gen(function* () {
    const rootFields = Config.dict
    if (rootFields === undefined) {
      return yield* Effect.die('Expected the Koishi config schema to expose object fields')
    }
    const connectionsSchema = rootFields.connections
    if (connectionsSchema === undefined) {
      return yield* Effect.die('Expected a Koishi connections schema')
    }
    const connectionSchema = connectionsSchema.inner
    if (connectionSchema === undefined) {
      return yield* Effect.die('Expected a Koishi connection item schema')
    }
    const connectionFields = connectionSchema.dict
    if (connectionFields === undefined) {
      return yield* Effect.die('Expected the connection item to expose object fields')
    }
    const apiKeySchema = connectionFields.apiKey
    if (apiKeySchema === undefined) {
      return yield* Effect.die('Expected a Koishi API key schema')
    }

    expect(connectionsSchema.meta.role).toBe('table')
    expect(connectionsSchema.meta.default).toEqual([])
    expect(apiKeySchema.meta.role).toBe('secret')
    expect(apiKeySchema.meta.default).toBeUndefined()
  }),
)

it.effect(
  'rejects empty connections, unsafe keys, slash IDs, duplicates, and inverted backoff',
  () =>
    Effect.gen(function* () {
      const invertedBackoff = makeConnection()

      yield* Effect.all([
        expectInvalid({ connections: [] }),
        expectInvalid({ connections: [{ ...makeConnection(), apiKey: '' }] }),
        expectInvalid({ connections: [{ ...makeConnection(), apiKey: '   ' }] }),
        expectInvalid({ connections: [makeConnection('team/primary')] }),
        expectInvalid({
          connections: [makeConnection('duplicate'), makeConnection('duplicate')],
        }),
        expectInvalid({
          connections: [
            {
              ...invertedBackoff,
              discoveryRetry: {
                ...invertedBackoff.discoveryRetry,
                initialDelayMs: 2_000,
                maxDelayMs: 1_000,
              },
            },
          ],
        }),
      ])
    }),
)

it.effect('rejects malformed URLs and URLs containing credentials, queries, or fragments', () =>
  Effect.gen(function* () {
    const invalidUrls = [
      'not a URL',
      'ftp://example.com/',
      'https://user:password@example.com/',
      `https://example.com/?key=${CANARY_API_KEY}`,
      'https://example.com/#fragment',
    ]

    yield* Effect.all(
      invalidUrls.map((baseUrl) =>
        expectInvalid({ connections: [makeConnection('primary', CANARY_API_KEY, baseUrl)] }),
      ),
    )
  }),
)

it.effect('rejects model-selection fields outside the adapter configuration contract', () =>
  Effect.gen(function* () {
    yield* Effect.all([
      expectInvalid({ connections: [makeConnection()], primary: 'gemini/model' }),
      expectInvalid({ connections: [makeConnection()], fallback: ['gemini/model'] }),
      expectInvalid({ connections: [makeConnection()], currentModel: 'gemini/model' }),
    ])
  }),
)

it.effect('does not expose a canary API key through configuration failures', () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      GeminiConfiguration.decode({
        connections: [makeConnection('duplicate'), makeConnection('duplicate')],
      }),
    )
    if (Exit.isSuccess(exit)) {
      return yield* Effect.die('Expected duplicate connection IDs to fail decoding')
    }

    const squashed = Cause.squash(exit.cause)
    expect(String(squashed)).not.toContain(CANARY_API_KEY)
    expect(String(JSON.stringify(squashed))).not.toContain(CANARY_API_KEY)
    expect(String(JSON.stringify(exit))).not.toContain(CANARY_API_KEY)
    expect(Cause.pretty(exit.cause)).not.toContain(CANARY_API_KEY)
  }),
)

it.effect('refuses to encode redacted API keys back into configuration data', () =>
  Effect.gen(function* () {
    const configuration = yield* GeminiConfiguration.decode({
      connections: [makeConnection()],
    })
    const exit = yield* Effect.exit(
      Schema.encodeEffect(GeminiConfiguration.Configuration)(configuration),
    )
    if (Exit.isSuccess(exit)) {
      return yield* Effect.die('Expected redacted API key encoding to be forbidden')
    }

    const squashed = Cause.squash(exit.cause)
    expect(Schema.isSchemaError(squashed)).toBe(true)
    expect(String(squashed)).toContain('Cannot encode Redacted with label: "GeminiApiKey"')
    expect(String(squashed)).not.toContain(CANARY_API_KEY)
    expect(Cause.pretty(exit.cause)).not.toContain(CANARY_API_KEY)
  }),
)
