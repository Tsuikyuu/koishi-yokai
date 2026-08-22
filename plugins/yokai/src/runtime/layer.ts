import { CapabilityRegistry, HostConfiguration } from '@yokai/core'
import { ModelReference } from '@yokai/protocol'
import { Effect, Layer, Option, Schema } from 'effect'

import type { Config } from '../config'

const decodeModelReference = Schema.decodeUnknownEffect(ModelReference)

const decodeConfiguration = Effect.fn('YokaiRuntime.decodeConfiguration')(function* (
  config: Config,
) {
  const primary =
    config.primary === undefined
      ? Option.none<ModelReference>()
      : Option.some(yield* decodeModelReference(config.primary))
  const fallback = yield* Effect.forEach(config.fallback, (reference) =>
    decodeModelReference(reference),
  )

  return HostConfiguration.Service.of({
    primary,
    fallback,
    feedbackToolsEnabled: config.feedbackToolsEnabled,
  })
})

const configurationLayer = (config: Config) =>
  Layer.effect(HostConfiguration.Service, decodeConfiguration(config))

export const makeLayer = (config: Config) =>
  Layer.merge(CapabilityRegistry.layer, configurationLayer(config))

export * as YokaiRuntimeLayer from './layer'
