import { CapabilityRegistry, HostConfiguration } from '@yokai-internal/core'
import { ModelReference } from 'yokai-protocol'
import { Effect, Layer, Option, Schema } from 'effect'
import type { Context } from 'koishi'

import type { Config } from '../config'
import { ModelCatalogSchemaProjection } from '../model-catalog/schema-projection'

const decodeModelReference = Schema.decodeUnknownEffect(ModelReference)

const decodeConfiguration = Effect.fn('YokaiRuntime.decodeConfiguration')(function* (
  config: Config,
) {
  const model =
    config.model === undefined
      ? Option.none<ModelReference>()
      : Option.some(yield* decodeModelReference(config.model))

  return HostConfiguration.Service.of({
    model,
    feedbackToolsEnabled: config.feedbackToolsEnabled,
  })
})

const configurationLayer = (config: Config) =>
  Layer.effect(HostConfiguration.Service, decodeConfiguration(config))

export const makeLayer = (config: Config, ctx: Context) => {
  const services = Layer.merge(CapabilityRegistry.layer, configurationLayer(config))
  return ModelCatalogSchemaProjection.layer(ctx, config).pipe(Layer.provideMerge(services))
}

export * as YokaiRuntimeLayer from './layer'
