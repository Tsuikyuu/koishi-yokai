import { Schema } from 'effect'

import { DiscoveredModel } from '../llm-adapter/model'
import { AdapterId, ModelReference } from '../llm-adapter/identity'

export const ModelCatalogRevision = Schema.Natural.pipe(
  Schema.brand('@yokai/protocol/ModelCatalogRevision'),
)

export type ModelCatalogRevision = typeof ModelCatalogRevision.Type

export const AdapterDiscoveryStatus = Schema.Literals([
  'discovering',
  'ready',
  'stale',
  'offline',
  'failed',
])

export type AdapterDiscoveryStatus = typeof AdapterDiscoveryStatus.Type

export const CatalogAdapter = Schema.Struct({
  id: AdapterId,
  status: AdapterDiscoveryStatus,
})

export interface CatalogAdapter extends Schema.Schema.Type<typeof CatalogAdapter> {}

const adapterId = (adapter: CatalogAdapter): string => adapter.id

export const CatalogAdapters = Schema.Array(CatalogAdapter).check(
  Schema.makeFilter((adapters: ReadonlyArray<CatalogAdapter>) => {
    const ids = adapters.map(adapterId)
    if (new Set(ids).size !== ids.length) return 'Expected unique catalog adapter IDs'
    return ids.every((id, index) => {
      if (index === 0) return true
      const previous = ids[index - 1]
      return previous !== undefined && previous < id
    })
      ? true
      : 'Expected catalog adapters sorted by adapter ID'
  }),
)

export type CatalogAdapters = typeof CatalogAdapters.Type

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
  adapters: CatalogAdapters,
  models: CatalogModels,
})

export interface ModelCatalogSnapshot extends Schema.Schema.Type<typeof ModelCatalogSnapshot> {}
