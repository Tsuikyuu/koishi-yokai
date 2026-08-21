import { Context, Effect, Layer, Schema } from 'effect'

import type { Config } from './plugin-config'

const ApiKey = Schema.RedactedFromValue(Schema.Trimmed.check(Schema.isNonEmpty()), {
  label: 'GeminiApiKey',
  disallowEncode: true,
})

const ServiceUrl = Schema.URLFromString.check(
  Schema.makeFilter((url: URL) => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'Expected an HTTP or HTTPS Gemini service URL'
    }
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
      return 'Expected a Gemini service URL without credentials, query, or fragment'
    }
    return true
  }),
)

export const DiscoveryRetryPolicy = Schema.Struct({
  maxAttempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  initialDelayMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 300_000 })),
  maxDelayMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 300_000 })),
  backoffMultiplier: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
})

export interface DiscoveryRetryPolicy extends Schema.Schema.Type<typeof DiscoveryRetryPolicy> {}

export const Endpoint = Schema.Struct({
  apiKey: ApiKey,
  baseUrl: ServiceUrl,
})

export interface Endpoint extends Schema.Schema.Type<typeof Endpoint> {}

const Endpoints = Schema.NonEmptyArray(Endpoint)

export const Configuration = Schema.Struct({
  endpoints: Endpoints,
  requestTimeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 600_000 })),
  discoveryRetry: DiscoveryRetryPolicy,
}).check(
  Schema.makeFilter((configuration) =>
    configuration.discoveryRetry.initialDelayMs <= configuration.discoveryRetry.maxDelayMs
      ? true
      : 'Expected discovery initial delay not to exceed its maximum delay',
  ),
)

export interface Configuration extends Schema.Schema.Type<typeof Configuration> {}

export class ConfigurationError extends Schema.TaggedError<ConfigurationError>(
  '@yokai/koishi-plugin-yokai-adapter-gemini/ConfigurationError',
)('GeminiConfigurationError', {
  message: Schema.Literal('Invalid Gemini adapter configuration'),
}) {}

export interface Interface {
  readonly endpoints: Configuration['endpoints']
  readonly requestTimeoutMs: Configuration['requestTimeoutMs']
  readonly discoveryRetry: Configuration['discoveryRetry']
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/koishi-plugin-yokai-adapter-gemini/Configuration',
) {}

export const decode = Effect.fn('GeminiConfiguration.decode')(function* (input: object) {
  return yield* Schema.decodeUnknownEffect(Configuration, {
    onExcessProperty: 'error',
  })(input).pipe(
    Effect.mapError(
      () =>
        new ConfigurationError({
          message: 'Invalid Gemini adapter configuration',
        }),
    ),
  )
})

export const layer = (config: Config) =>
  Layer.effect(
    Service,
    decode(config).pipe(Effect.map((configuration) => Service.of(configuration))),
  )

export * as GeminiConfiguration from './configuration'
