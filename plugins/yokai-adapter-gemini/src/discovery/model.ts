import type { Model } from '@google/genai'
import {
  AdapterModelSnapshot,
  AdapterProtocolDecodeError,
  DiscoveredModel,
  GenerationMethodName,
  ModelAvailability,
  ModelDiscoveryFreshness,
  TokenLimit,
  type AdapterId,
  type AdapterModelSnapshot as AdapterModelSnapshotType,
  type DiscoveredModel as DiscoveredModelType,
} from '@yokai/protocol'
import { DateTime, Effect, Option, Schema } from 'effect'

const MODEL_RESOURCE_PREFIX = 'models/'

const ProviderModel = Schema.Struct({
  name: Schema.NonEmptyString,
  displayName: Schema.NonEmptyString,
  inputTokenLimit: Schema.optionalKey(TokenLimit),
  outputTokenLimit: Schema.optionalKey(TokenLimit),
  /** @google/genai maps REST supportedGenerationMethods to this SDK field. */
  supportedActions: Schema.optionalKey(Schema.Array(GenerationMethodName)),
  availability: Schema.optionalKey(ModelAvailability),
  discoveryFreshness: Schema.optionalKey(ModelDiscoveryFreshness),
})

interface ProviderModel extends Schema.Schema.Type<typeof ProviderModel> {}

const protocolDecodeError = (adapterId: AdapterId) =>
  new AdapterProtocolDecodeError({
    adapterId,
    operation: 'discoverModels',
    message: 'Gemini returned an invalid model discovery response',
  })

const normalizeModelId = (name: string): string =>
  name.startsWith(MODEL_RESOURCE_PREFIX) ? name.slice(MODEL_RESOURCE_PREFIX.length) : name

const uniqueSorted = <A extends string>(values: ReadonlyArray<A>): ReadonlyArray<A> =>
  [...new Set(values)].sort((left, right) => {
    if (left < right) return -1
    if (left > right) return 1
    return 0
  })

const normalizeProviderModel = Effect.fn('GeminiModelDiscovery.normalizeProviderModel')(function* (
  input: Model,
) {
  const model = yield* Schema.decodeUnknownEffect(ProviderModel)(input)
  const methods = model.supportedActions
  if (methods !== undefined && !methods.includes('generateContent')) return Option.none()

  const inputLimit =
    model.inputTokenLimit === undefined ? {} : { inputTokenLimit: model.inputTokenLimit }
  const outputLimit =
    model.outputTokenLimit === undefined ? {} : { outputTokenLimit: model.outputTokenLimit }
  const supportedGenerationMethods =
    methods === undefined ? {} : { supportedGenerationMethods: uniqueSorted(methods) }

  const normalized = yield* Schema.decodeUnknownEffect(DiscoveredModel)({
    id: normalizeModelId(model.name),
    displayName: model.displayName,
    availability: model.availability === undefined ? 'available' : model.availability,
    discoveryFreshness: model.discoveryFreshness === undefined ? 'fresh' : model.discoveryFreshness,
    ...supportedGenerationMethods,
    ...inputLimit,
    ...outputLimit,
  })
  return Option.some(normalized)
})

const deduplicateAndSort = (
  models: ReadonlyArray<DiscoveredModelType>,
): ReadonlyArray<DiscoveredModelType> => {
  const byId = new Map<string, DiscoveredModelType>()
  for (const model of models) {
    if (!byId.has(model.id)) byId.set(model.id, model)
  }
  return [...byId.values()].sort((left, right) => {
    if (left.id < right.id) return -1
    if (left.id > right.id) return 1
    return 0
  })
}

export const decodeListing = Effect.fn('GeminiModelDiscovery.decodeListing')(function* (
  adapterId: AdapterId,
  models: ReadonlyArray<Model>,
  discoveredAt: DateTime.Utc,
) {
  return yield* Effect.gen(function* () {
    const candidates = yield* Effect.forEach(models, normalizeProviderModel)
    const normalized = candidates.flatMap((candidate) =>
      Option.isSome(candidate) ? [candidate.value] : [],
    )
    return yield* AdapterModelSnapshot.makeEffect({
      discoveredAt,
      models: deduplicateAndSort(normalized),
    })
  }).pipe(Effect.mapError(() => protocolDecodeError(adapterId)))
})

export const markStale = (
  snapshot: AdapterModelSnapshotType,
  discoveredAt: DateTime.Utc,
): AdapterModelSnapshotType => ({
  discoveredAt,
  models: snapshot.models.map((model) => ({
    ...model,
    discoveryFreshness: 'stale' as const,
  })),
})

export * as GeminiDiscoveryModel from './model'
