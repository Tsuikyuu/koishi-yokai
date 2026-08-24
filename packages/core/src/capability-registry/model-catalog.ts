import type { CatalogAdapter, CatalogModel } from '@yokai/protocol'

export {
  AdapterDiscoveryStatus,
  CatalogAdapter,
  CatalogAdapters,
  CatalogModel,
  CatalogModels,
  ModelCatalogRevision,
  ModelCatalogSnapshot,
} from '@yokai/protocol'

const optionalArrayEqual = (
  left: ReadonlyArray<string> | undefined,
  right: ReadonlyArray<string> | undefined,
): boolean => {
  if (left === undefined) return right === undefined
  if (right === undefined || left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

const adapterEqual = (left: CatalogAdapter, right: CatalogAdapter): boolean =>
  left.id === right.id && left.status === right.status

const modelEqual = (left: CatalogModel, right: CatalogModel): boolean =>
  left.reference.adapterId === right.reference.adapterId &&
  left.reference.modelId === right.reference.modelId &&
  left.displayName === right.displayName &&
  left.availability === right.availability &&
  left.discoveryFreshness === right.discoveryFreshness &&
  left.inputTokenLimit === right.inputTokenLimit &&
  left.outputTokenLimit === right.outputTokenLimit &&
  optionalArrayEqual(left.supportedGenerationMethods, right.supportedGenerationMethods)

export const modelCatalogContentEqual = (
  leftAdapters: ReadonlyArray<CatalogAdapter>,
  leftModels: ReadonlyArray<CatalogModel>,
  rightAdapters: ReadonlyArray<CatalogAdapter>,
  rightModels: ReadonlyArray<CatalogModel>,
): boolean =>
  leftAdapters.length === rightAdapters.length &&
  leftAdapters.every((adapter, index) => {
    const candidate = rightAdapters[index]
    return candidate !== undefined && (adapter === candidate || adapterEqual(adapter, candidate))
  }) &&
  leftModels.length === rightModels.length &&
  leftModels.every((model, index) => {
    const candidate = rightModels[index]
    return candidate !== undefined && (model === candidate || modelEqual(model, candidate))
  })
