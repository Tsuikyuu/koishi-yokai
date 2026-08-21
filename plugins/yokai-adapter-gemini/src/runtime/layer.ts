import { Layer } from 'effect'
import type { HTTP } from 'koishi'

import { GeminiClientFactory } from '../client/client-factory'
import { GeminiConfiguration } from '../config/configuration'
import type { Config } from '../config/plugin-config'
import { GeminiConnection } from '../connection/connection'
import { GeminiModelDiscovery } from '../discovery/discovery'
import { GeminiHttpTransport } from '../transport/http-transport'

/**
 * Owns one logical connection and its model-discovery state for a Gemini plugin instance.
 * The layer is lazy: configuration is decoded and clients are created only when built.
 */
/** Internal transport injection seam for deterministic adapter tests. */
export const makeLayerWithTransport = (
  config: Config,
  httpTransportLayer: Layer.Layer<GeminiHttpTransport.Service>,
) => {
  const connectionLayer = GeminiConnection.layer.pipe(
    Layer.provide(GeminiConfiguration.layer(config)),
    Layer.provide(GeminiClientFactory.layer.pipe(Layer.provide(httpTransportLayer))),
  )
  return GeminiModelDiscovery.layer.pipe(Layer.provideMerge(connectionLayer))
}

export const makeLayer = (config: Config, http: HTTP) =>
  makeLayerWithTransport(config, GeminiHttpTransport.layer(http))

export * as GeminiRuntime from './layer'
