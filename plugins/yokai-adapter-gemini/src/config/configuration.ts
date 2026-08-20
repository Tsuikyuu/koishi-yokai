import { Context, Effect, Layer, Schema } from 'effect'

import type { Config } from './plugin-config.js'

const ConnectionId = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[^\p{C}/]+$/u),
)

export type ConnectionId = typeof ConnectionId.Type

const DisplayName = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256))

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

export const Connection = Schema.Struct({
  connectionId: ConnectionId,
  displayName: DisplayName,
  apiKey: ApiKey,
  baseUrl: ServiceUrl,
  requestTimeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 600_000 })),
  discoveryRetry: DiscoveryRetryPolicy,
}).check(
  Schema.makeFilter((connection) =>
    connection.discoveryRetry.initialDelayMs <= connection.discoveryRetry.maxDelayMs
      ? true
      : 'Expected discovery initial delay not to exceed its maximum delay',
  ),
)

export interface Connection extends Schema.Schema.Type<typeof Connection> {}

const Connections = Schema.NonEmptyArray(Connection).check(
  Schema.makeFilter((connections: ReadonlyArray<Connection>) => {
    const ids = connections.map((connection) => connection.connectionId)
    return new Set(ids).size === ids.length ? true : 'Expected unique Gemini connection IDs'
  }),
)

export const Configuration = Schema.Struct({
  connections: Connections,
})

export interface Configuration extends Schema.Schema.Type<typeof Configuration> {}

export class ConfigurationError extends Schema.TaggedError<ConfigurationError>(
  '@yokai/koishi-plugin-yokai-adapter-gemini/ConfigurationError',
)('GeminiConfigurationError', {
  message: Schema.Literal('Invalid Gemini adapter configuration'),
}) {}

export interface Interface {
  readonly connections: Configuration['connections']
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

export * as GeminiConfiguration from './configuration.js'
