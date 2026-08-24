import { Layer } from 'effect'
import type { HTTP } from 'koishi'

import { GeminiAdapter } from '../adapter/adapter'
import { GeminiClientFactory } from '../client/client-factory'
import { GeminiConfiguration } from '../config/configuration'
import type { Config } from '../config/plugin-config'
import { GeminiConnection } from '../connection/connection'
import { GeminiContinuationStore } from '../continuation/store'
import { GeminiContinuationTokenGenerator } from '../continuation/token-generator'
import { GeminiModelDiscovery } from '../discovery/discovery'
import { GeminiTextGeneration } from '../generation/generation'
import { GeminiHttpTransport } from '../transport/http-transport'

/**
 * Owns one logical connection and its adapter capabilities for a Gemini plugin instance.
 * The layer is lazy: configuration is decoded and clients are created only when built.
 */
/** Internal transport injection seam for deterministic adapter tests. */
export const makeLayerWithTransport = (
  config: Config,
  httpTransportLayer: Layer.Layer<GeminiHttpTransport.Service>,
) => makeLayerWithDiscovery(config, httpTransportLayer, GeminiModelDiscovery.layer)

const makeLayerWithDiscovery = (
  config: Config,
  httpTransportLayer: Layer.Layer<GeminiHttpTransport.Service>,
  modelDiscoveryLayer: Layer.Layer<GeminiModelDiscovery.Service, never, GeminiConnection.Service>,
) => {
  const connectionLayer = GeminiConnection.layer.pipe(
    Layer.provide(GeminiConfiguration.layer(config)),
    Layer.provide(GeminiClientFactory.layer.pipe(Layer.provide(httpTransportLayer))),
  )
  const continuationLayer = GeminiContinuationStore.layer.pipe(
    Layer.provide(GeminiContinuationTokenGenerator.layer),
    Layer.provideMerge(connectionLayer),
  )
  const capabilityLayer = Layer.merge(modelDiscoveryLayer, GeminiTextGeneration.layer).pipe(
    Layer.provideMerge(continuationLayer),
  )
  return GeminiAdapter.layer.pipe(Layer.provideMerge(capabilityLayer))
}

/** The Yokai host owns initial discovery and refresh when this adapter is registered. */
export const makeRegisteredLayerWithTransport = (
  config: Config,
  httpTransportLayer: Layer.Layer<GeminiHttpTransport.Service>,
) => makeLayerWithDiscovery(config, httpTransportLayer, GeminiModelDiscovery.layerForHost)

export const makeLayer = (config: Config, http: HTTP) =>
  makeLayerWithTransport(config, GeminiHttpTransport.layer(http))

export const makeRegisteredLayer = (config: Config, http: HTTP) =>
  makeRegisteredLayerWithTransport(config, GeminiHttpTransport.layer(http))

export * as GeminiRuntime from './layer'
