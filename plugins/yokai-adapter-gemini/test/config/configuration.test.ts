import { expect, it } from '@effect/vitest'
import { MAX_ADAPTER_ID_LENGTH } from '@yokai/protocol'
import { Cause, Effect, Exit, Redacted, Schema } from 'effect'
import { vi } from 'vitest'

vi.mock('koishi', async () => {
  const { Schema } = await import('@satorijs/core')
  return { Schema }
})

import { GeminiConfiguration } from '../../src/config/configuration'
import {
  Config,
  DEFAULT_ADAPTER_ID,
  DEFAULT_DISCOVERY_BACKOFF_MULTIPLIER,
  DEFAULT_DISCOVERY_INITIAL_DELAY_MS,
  DEFAULT_DISCOVERY_MAX_ATTEMPTS,
  DEFAULT_DISCOVERY_MAX_DELAY_MS,
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from '../../src/config/plugin-config'

const PRIMARY_API_KEY_CANARY = 'gemini-primary-api-key-must-not-leak'
const FALLBACK_API_KEY_CANARY = 'gemini-fallback-api-key-must-not-leak'
const FALLBACK_BASE_URL = 'https://gemini-fallback.example.com/'
const CUSTOM_ADAPTER_ID = 'gemini-work'

const makeEndpoint = (apiKey = PRIMARY_API_KEY_CANARY, baseUrl = DEFAULT_GEMINI_BASE_URL) => ({
  apiKey,
  baseUrl,
})

const makeConfiguration = () => ({
  adapterId: DEFAULT_ADAPTER_ID,
  endpoints: [makeEndpoint()],
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  maxConcurrency: DEFAULT_MAX_CONCURRENCY,
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

it.effect('applies shared Koishi defaults and decodes endpoint API keys as redacted values', () =>
  Effect.gen(function* () {
    const pluginConfig = Config({
      endpoints: [
        { apiKey: PRIMARY_API_KEY_CANARY },
        { apiKey: FALLBACK_API_KEY_CANARY, baseUrl: FALLBACK_BASE_URL },
      ],
    })
    const primaryPluginEndpoint = pluginConfig.endpoints[0]
    const fallbackPluginEndpoint = pluginConfig.endpoints[1]
    if (primaryPluginEndpoint === undefined || fallbackPluginEndpoint === undefined) {
      return yield* Effect.die('Expected Koishi to retain both configured endpoints')
    }

    expect(primaryPluginEndpoint.baseUrl).toBe(DEFAULT_GEMINI_BASE_URL)
    expect(fallbackPluginEndpoint.baseUrl).toBe(FALLBACK_BASE_URL)
    expect(pluginConfig.adapterId).toBe(DEFAULT_ADAPTER_ID)
    expect(pluginConfig.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS)
    expect(pluginConfig.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY)
    expect(pluginConfig.discoveryRetry).toEqual({
      maxAttempts: DEFAULT_DISCOVERY_MAX_ATTEMPTS,
      initialDelayMs: DEFAULT_DISCOVERY_INITIAL_DELAY_MS,
      maxDelayMs: DEFAULT_DISCOVERY_MAX_DELAY_MS,
      backoffMultiplier: DEFAULT_DISCOVERY_BACKOFF_MULTIPLIER,
    })
    expect(primaryPluginEndpoint).not.toHaveProperty('requestTimeoutMs')
    expect(primaryPluginEndpoint).not.toHaveProperty('discoveryRetry')
    expect(fallbackPluginEndpoint).not.toHaveProperty('requestTimeoutMs')
    expect(fallbackPluginEndpoint).not.toHaveProperty('discoveryRetry')

    const configuration = yield* GeminiConfiguration.decode(pluginConfig)
    const primaryEndpoint = configuration.endpoints[0]
    const fallbackEndpoint = configuration.endpoints[1]
    if (fallbackEndpoint === undefined) {
      return yield* Effect.die('Expected the decoded fallback endpoint')
    }

    expect(Object.keys(primaryEndpoint).sort()).toEqual(['apiKey', 'baseUrl'])
    expect(Object.keys(fallbackEndpoint).sort()).toEqual(['apiKey', 'baseUrl'])
    expect(primaryEndpoint.baseUrl).toEqual(new URL(DEFAULT_GEMINI_BASE_URL))
    expect(fallbackEndpoint.baseUrl).toEqual(new URL(FALLBACK_BASE_URL))
    expect(Redacted.isRedacted(primaryEndpoint.apiKey)).toBe(true)
    expect(Redacted.isRedacted(fallbackEndpoint.apiKey)).toBe(true)
    expect(String(primaryEndpoint.apiKey)).toBe('<redacted:GeminiApiKey>')
    expect(String(fallbackEndpoint.apiKey)).toBe('<redacted:GeminiApiKey>')
    expect(Redacted.value(primaryEndpoint.apiKey)).toBe(PRIMARY_API_KEY_CANARY)
    expect(Redacted.value(fallbackEndpoint.apiKey)).toBe(FALLBACK_API_KEY_CANARY)
    expect(configuration.adapterId).toBe(DEFAULT_ADAPTER_ID)
    expect(configuration.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS)
    expect(configuration.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY)
    expect(configuration.discoveryRetry).toEqual(pluginConfig.discoveryRetry)
  }),
)

it.effect('marks endpoint, secret, URL, and shared timeout fields with Koishi UI roles', () =>
  Effect.gen(function* () {
    const rootFields = Config.dict
    if (rootFields === undefined) {
      return yield* Effect.die('Expected the Koishi config schema to expose object fields')
    }
    const endpointsSchema = rootFields.endpoints
    const adapterIdSchema = rootFields.adapterId
    const requestTimeoutSchema = rootFields.requestTimeoutMs
    const maxConcurrencySchema = rootFields.maxConcurrency
    const discoveryRetrySchema = rootFields.discoveryRetry
    if (
      adapterIdSchema === undefined ||
      endpointsSchema === undefined ||
      requestTimeoutSchema === undefined ||
      maxConcurrencySchema === undefined ||
      discoveryRetrySchema === undefined
    ) {
      return yield* Effect.die('Expected endpoint and shared configuration schemas')
    }
    const endpointSchema = endpointsSchema.inner
    const retryFields = discoveryRetrySchema.dict
    if (endpointSchema === undefined || retryFields === undefined) {
      return yield* Effect.die('Expected endpoint item and discovery retry object schemas')
    }
    const endpointFields = endpointSchema.dict
    if (endpointFields === undefined) {
      return yield* Effect.die('Expected the endpoint item to expose object fields')
    }
    const apiKeySchema = endpointFields.apiKey
    const baseUrlSchema = endpointFields.baseUrl
    const initialDelaySchema = retryFields.initialDelayMs
    const maxDelaySchema = retryFields.maxDelayMs
    if (
      apiKeySchema === undefined ||
      baseUrlSchema === undefined ||
      initialDelaySchema === undefined ||
      maxDelaySchema === undefined
    ) {
      return yield* Effect.die('Expected endpoint and retry field schemas')
    }

    expect(endpointsSchema.meta.role).toBe('table')
    expect(endpointsSchema.meta.default).toEqual([])
    expect(adapterIdSchema.meta.default).toBe(DEFAULT_ADAPTER_ID)
    expect(apiKeySchema.meta.role).toBe('secret')
    expect(apiKeySchema.meta.default).toBeUndefined()
    expect(baseUrlSchema.meta.role).toBe('link')
    expect(baseUrlSchema.meta.default).toBe(DEFAULT_GEMINI_BASE_URL)
    expect(requestTimeoutSchema.meta.role).toBe('ms')
    expect(requestTimeoutSchema.meta.default).toBe(DEFAULT_REQUEST_TIMEOUT_MS)
    expect(maxConcurrencySchema.meta.default).toBe(DEFAULT_MAX_CONCURRENCY)
    expect(initialDelaySchema.meta.role).toBe('ms')
    expect(maxDelaySchema.meta.role).toBe('ms')
  }),
)

it.effect(
  'strictly rejects empty endpoints, unsafe keys, legacy fields, and invalid shared values',
  () =>
    Effect.gen(function* () {
      const valid = makeConfiguration()

      yield* Effect.all([
        expectInvalid({ ...valid, endpoints: [] }),
        expectInvalid({ ...valid, endpoints: [{ ...makeEndpoint(), apiKey: '' }] }),
        expectInvalid({ ...valid, endpoints: [{ ...makeEndpoint(), apiKey: '   ' }] }),
        expectInvalid({
          ...valid,
          endpoints: [
            {
              ...makeEndpoint(),
              connectionId: 'legacy-connection',
              displayName: 'Legacy connection',
            },
          ],
        }),
        expectInvalid({
          ...valid,
          endpoints: [
            {
              ...makeEndpoint(),
              requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
              discoveryRetry: valid.discoveryRetry,
            },
          ],
        }),
        expectInvalid({ ...valid, requestTimeoutMs: 999 }),
        expectInvalid({ ...valid, maxConcurrency: 0 }),
        expectInvalid({ ...valid, maxConcurrency: 65 }),
        expectInvalid({
          ...valid,
          endpoints: [
            {
              ...makeEndpoint(),
              maxConcurrency: valid.maxConcurrency,
            },
          ],
        }),
        expectInvalid({
          ...valid,
          discoveryRetry: {
            ...valid.discoveryRetry,
            initialDelayMs: 2_000,
            maxDelayMs: 1_000,
          },
        }),
        expectInvalid({
          adapterId: valid.adapterId,
          connections: [makeEndpoint()],
          requestTimeoutMs: valid.requestTimeoutMs,
          maxConcurrency: valid.maxConcurrency,
          discoveryRetry: valid.discoveryRetry,
        }),
      ])
    }),
)

it.effect('preserves a valid custom adapter ID and rejects invalid IDs', () =>
  Effect.gen(function* () {
    const customPluginConfig = Config({
      adapterId: CUSTOM_ADAPTER_ID,
      endpoints: [{ apiKey: PRIMARY_API_KEY_CANARY }],
    })
    const custom = yield* GeminiConfiguration.decode(customPluginConfig)

    expect(customPluginConfig.adapterId).toBe(CUSTOM_ADAPTER_ID)
    expect(custom.adapterId).toBe(CUSTOM_ADAPTER_ID)

    const invalidAdapterIds = ['', '1gemini', 'gemini/work', 'a'.repeat(MAX_ADAPTER_ID_LENGTH + 1)]
    for (const adapterId of invalidAdapterIds) {
      expect(() => Config({ adapterId, endpoints: [{ apiKey: PRIMARY_API_KEY_CANARY }] })).toThrow()
      yield* expectInvalid({ ...makeConfiguration(), adapterId })
    }
  }),
)

it.effect('rejects malformed URLs and URLs containing credentials, queries, or fragments', () =>
  Effect.gen(function* () {
    const invalidUrls = [
      'not a URL',
      'ftp://example.com/',
      'https://user:password@example.com/',
      `https://example.com/?key=${PRIMARY_API_KEY_CANARY}`,
      'https://example.com/#fragment',
    ]

    yield* Effect.all(
      invalidUrls.map((baseUrl) =>
        expectInvalid({
          ...makeConfiguration(),
          endpoints: [makeEndpoint(PRIMARY_API_KEY_CANARY, baseUrl)],
        }),
      ),
    )
  }),
)

it.effect('rejects model-selection fields outside the adapter configuration contract', () =>
  Effect.gen(function* () {
    const valid = makeConfiguration()

    yield* Effect.all([
      expectInvalid({ ...valid, primary: 'gemini/model' }),
      expectInvalid({ ...valid, fallback: ['gemini/model'] }),
      expectInvalid({ ...valid, currentModel: 'gemini/model' }),
    ])
  }),
)

it.effect('does not expose canary API keys through configuration failures', () =>
  Effect.gen(function* () {
    const valid = makeConfiguration()
    const exit = yield* Effect.exit(
      GeminiConfiguration.decode({
        ...valid,
        endpoints: [
          makeEndpoint(
            PRIMARY_API_KEY_CANARY,
            `https://example.com/?key=${FALLBACK_API_KEY_CANARY}`,
          ),
        ],
      }),
    )
    if (Exit.isSuccess(exit)) {
      return yield* Effect.die('Expected a URL containing secret material to fail decoding')
    }

    const squashed = Cause.squash(exit.cause)
    const surfaces = [String(squashed), String(JSON.stringify(squashed)), Cause.pretty(exit.cause)]
    const serializedExit = String(JSON.stringify(exit))

    expect(surfaces.every((surface) => !surface.includes(PRIMARY_API_KEY_CANARY))).toBe(true)
    expect(surfaces.every((surface) => !surface.includes(FALLBACK_API_KEY_CANARY))).toBe(true)
    expect(serializedExit).not.toContain(PRIMARY_API_KEY_CANARY)
    expect(serializedExit).not.toContain(FALLBACK_API_KEY_CANARY)
  }),
)

it.effect('refuses to encode redacted endpoint API keys back into configuration data', () =>
  Effect.gen(function* () {
    const configuration = yield* GeminiConfiguration.decode(makeConfiguration())
    const exit = yield* Effect.exit(
      Schema.encodeEffect(GeminiConfiguration.Configuration)(configuration),
    )
    if (Exit.isSuccess(exit)) {
      return yield* Effect.die('Expected redacted API key encoding to be forbidden')
    }

    const squashed = Cause.squash(exit.cause)
    expect(Schema.isSchemaError(squashed)).toBe(true)
    expect(String(squashed)).toContain('Cannot encode Redacted with label: "GeminiApiKey"')
    expect(String(squashed)).not.toContain(PRIMARY_API_KEY_CANARY)
    expect(Cause.pretty(exit.cause)).not.toContain(PRIMARY_API_KEY_CANARY)
  }),
)
