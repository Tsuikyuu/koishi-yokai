import { Schema } from 'effect'

import { AdapterModelId } from './identity'
import { TokenLimit } from './token'

export const MAX_MODEL_DISPLAY_NAME_LENGTH = 256
export const MAX_GENERATION_METHOD_NAME_LENGTH = 128

export const ModelAvailability = Schema.Literals(['available', 'unavailable'])

export type ModelAvailability = typeof ModelAvailability.Type

/** Whether this descriptor was confirmed by the current discovery refresh. */
export const ModelDiscoveryFreshness = Schema.Literals(['fresh', 'stale'])

export type ModelDiscoveryFreshness = typeof ModelDiscoveryFreshness.Type

export const GenerationMethodName = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_GENERATION_METHOD_NAME_LENGTH),
)

export type GenerationMethodName = typeof GenerationMethodName.Type

const GenerationMethods = Schema.Array(GenerationMethodName).check(
  Schema.makeFilter((methods: ReadonlyArray<GenerationMethodName>) =>
    methods.every((method, index) => {
      if (index === 0) return true
      const previous = methods[index - 1]
      return previous !== undefined && previous < method
    })
      ? true
      : 'Expected unique generation methods in stable sorted order',
  ),
)

export const DiscoveredModel = Schema.Struct({
  id: AdapterModelId,
  displayName: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_MODEL_DISPLAY_NAME_LENGTH),
  ),
  availability: ModelAvailability,
  discoveryFreshness: ModelDiscoveryFreshness,
  inputTokenLimit: Schema.optionalKey(TokenLimit),
  outputTokenLimit: Schema.optionalKey(TokenLimit),
  supportedGenerationMethods: Schema.optionalKey(GenerationMethods),
})

export interface DiscoveredModel extends Schema.Schema.Type<typeof DiscoveredModel> {}

export const DiscoveredModels = Schema.Array(DiscoveredModel).check(
  Schema.makeFilter((models: ReadonlyArray<DiscoveredModel>) => {
    const ids = models.map((model) => model.id)
    if (new Set(ids).size !== ids.length) {
      return 'Expected unique adapter-local model IDs'
    }

    return ids.every((id, index) => {
      if (index === 0) return true
      const previous = ids[index - 1]
      return previous !== undefined && previous < id
    })
      ? true
      : 'Expected models sorted by adapter-local model ID'
  }),
)

export type DiscoveredModels = typeof DiscoveredModels.Type

/**
 * A successful, immutable discovery response. Per-model freshness lets a
 * multi-source adapter retain the last confirmed models for a failed source.
 * Registry revision and adapter offline state belong to the host catalog.
 */
export const AdapterModelSnapshot = Schema.Struct({
  discoveredAt: Schema.DateTimeUtcFromString,
  models: DiscoveredModels,
})

export interface AdapterModelSnapshot extends Schema.Schema.Type<typeof AdapterModelSnapshot> {}
