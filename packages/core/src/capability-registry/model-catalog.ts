import { Schema } from 'effect'

import { DiscoveredModel, ModelReference } from '@yokai/protocol'

export const ModelCatalogRevision = Schema.Natural.pipe(
  Schema.brand('@yokai/core/ModelCatalogRevision'),
)

export type ModelCatalogRevision = typeof ModelCatalogRevision.Type

export const CatalogModel = Schema.Struct({
  reference: ModelReference,
  displayName: DiscoveredModel.fields.displayName,
  availability: DiscoveredModel.fields.availability,
  discoveryFreshness: DiscoveredModel.fields.discoveryFreshness,
  inputTokenLimit: DiscoveredModel.fields.inputTokenLimit,
  outputTokenLimit: DiscoveredModel.fields.outputTokenLimit,
  supportedGenerationMethods: DiscoveredModel.fields.supportedGenerationMethods,
})

export interface CatalogModel extends Schema.Schema.Type<typeof CatalogModel> {}

const referenceKey = (model: CatalogModel): string =>
  model.reference.adapterId + '/' + model.reference.modelId

export const CatalogModels = Schema.Array(CatalogModel).check(
  Schema.makeFilter((models: ReadonlyArray<CatalogModel>) => {
    const keys = models.map(referenceKey)
    if (new Set(keys).size !== keys.length) return 'Expected unique model references'
    return keys.every((key, index) => {
      if (index === 0) return true
      const previous = keys[index - 1]
      return previous !== undefined && previous < key
    })
      ? true
      : 'Expected models sorted by model reference'
  }),
)

export type CatalogModels = typeof CatalogModels.Type

export const ModelCatalogSnapshot = Schema.Struct({
  revision: ModelCatalogRevision,
  models: CatalogModels,
})

export interface ModelCatalogSnapshot extends Schema.Schema.Type<typeof ModelCatalogSnapshot> {}

const optionalArrayEqual = (
  left: ReadonlyArray<string> | undefined,
  right: ReadonlyArray<string> | undefined,
): boolean => {
  if (left === undefined) return right === undefined
  if (right === undefined || left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

const modelEqual = (left: CatalogModel, right: CatalogModel): boolean =>
  left.reference.adapterId === right.reference.adapterId &&
  left.reference.modelId === right.reference.modelId &&
  left.displayName === right.displayName &&
  left.availability === right.availability &&
  left.discoveryFreshness === right.discoveryFreshness &&
  left.inputTokenLimit === right.inputTokenLimit &&
  left.outputTokenLimit === right.outputTokenLimit &&
  optionalArrayEqual(left.supportedGenerationMethods, right.supportedGenerationMethods)

/** Discovery timestamps are intentionally absent from the merged catalog. */
export const modelCatalogContentEqual = (
  left: ReadonlyArray<CatalogModel>,
  right: ReadonlyArray<CatalogModel>,
): boolean =>
  left.length === right.length &&
  left.every((model, index) => {
    const candidate = right[index]
    return candidate !== undefined && (model === candidate || modelEqual(model, candidate))
  })
