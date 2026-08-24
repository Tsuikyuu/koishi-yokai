import { CapabilityRegistry } from '@yokai/core'
import type { CatalogModel, ModelCatalogSnapshot } from '@yokai/protocol'
import { Effect, Layer, Stream } from 'effect'
import { Schema, type Context } from 'koishi'

import type { Config } from '../config'

const modelReferenceKey = (model: CatalogModel): string =>
  model.reference.adapterId + '/' + model.reference.modelId

const modelReferenceLabel = (reference: string): string =>
  reference.toLowerCase().replace(/\s+/g, '-')

const modelOption = (model: CatalogModel) => {
  const key = modelReferenceKey(model)
  const option = Schema.const(key).description(modelReferenceLabel(key))
  return model.availability === 'available' ? option : option.disabled()
}

const noModelOption = Schema.never().description('未选择模型')

export const schemaForCatalog = (catalog: ModelCatalogSnapshot, config: Config) => {
  const modelOptions = catalog.models.map(modelOption)
  const catalogReferences = catalog.models.map(modelReferenceKey)
  const unavailableSelections =
    config.model !== undefined && !catalogReferences.includes(config.model)
      ? [Schema.const(config.model).description(modelReferenceLabel(config.model)).disabled()]
      : []
  return Schema.union([noModelOption, ...modelOptions, ...unavailableSelections])
}

export const layer = (ctx: Context, config: Config) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* CapabilityRegistry.Service
      yield* registry.modelCatalogChanges.pipe(
        Stream.runForEach((catalog) =>
          Effect.sync(() => ctx.schema.set('yokai-model', schemaForCatalog(catalog, config))),
        ),
        Effect.forkScoped,
      )
    }),
  )

export * as ModelCatalogSchemaProjection from './schema-projection'
