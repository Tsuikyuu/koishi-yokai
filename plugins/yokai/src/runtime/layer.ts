import { CapabilityRegistry, HostConfiguration } from '@yokai-internal/core'
import { MessageArchive, MessageArchiveEvent } from '@yokai-internal/memory'
import { ModelReference } from 'yokai-protocol'
import { Effect, Layer, Option, Schema } from 'effect'
import type { Context } from 'koishi'

import { DEFAULT_INSTANCE_ID, DEFAULT_MESSAGE_RETENTION_DAYS, type Config } from '../config'
import { KoishiMessageArchiveStorage } from '../message-archive/storage'
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

const decodeMessageArchiveOptions = Effect.fn('YokaiRuntime.decodeMessageArchiveOptions')(
  function* (config: Config) {
    const instanceId = yield* Schema.decodeUnknownEffect(MessageArchiveEvent.InstanceId)(
      config.instanceId === undefined ? DEFAULT_INSTANCE_ID : config.instanceId,
    )
    const retentionDays = yield* Schema.decodeUnknownEffect(MessageArchiveEvent.RetentionDays)(
      config.messageRetentionDays === undefined
        ? DEFAULT_MESSAGE_RETENTION_DAYS
        : config.messageRetentionDays,
    )
    return {
      instanceId,
      retentionDays,
      cleanupInterval: MessageArchive.DEFAULT_CLEANUP_INTERVAL,
    } satisfies MessageArchive.Options
  },
)

const messageArchiveLayer = (config: Config, ctx: Context) =>
  Layer.unwrap(
    decodeMessageArchiveOptions(config).pipe(
      Effect.map((options) => MessageArchive.layer(options)),
    ),
  ).pipe(Layer.provide(KoishiMessageArchiveStorage.layer(ctx)))

export const makeLayer = (config: Config, ctx: Context) => {
  const hostServices = Layer.merge(CapabilityRegistry.layer, configurationLayer(config))
  const services = Layer.merge(hostServices, messageArchiveLayer(config, ctx))
  return ModelCatalogSchemaProjection.layer(ctx, config).pipe(Layer.provideMerge(services))
}

export * as YokaiRuntimeLayer from './layer'
