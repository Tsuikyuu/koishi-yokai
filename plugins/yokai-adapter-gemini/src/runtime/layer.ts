import { Layer } from 'effect'
import type { HTTP } from 'koishi'

import { GeminiClientFactory } from '../client/client-factory'
import { GeminiConfiguration } from '../config/configuration'
import type { Config } from '../config/plugin-config'
import { GeminiConnection } from '../connection/connection'
import { GeminiHttpTransport } from '../transport/http-transport'

/**
 * Owns the single logical connection Scope for one Gemini plugin instance. The layer is
 * lazy: configuration is decoded and clients are created only when it is built.
 */
/** Internal transport injection seam for deterministic adapter tests. */
export const makeLayerWithTransport = (
  config: Config,
  httpTransportLayer: Layer.Layer<GeminiHttpTransport.Service>,
) =>
  GeminiConnection.layer.pipe(
    Layer.provide(GeminiConfiguration.layer(config)),
    Layer.provide(GeminiClientFactory.layer.pipe(Layer.provide(httpTransportLayer))),
  )

export const makeLayer = (config: Config, http: HTTP) =>
  makeLayerWithTransport(config, GeminiHttpTransport.layer(http))

export * as GeminiRuntime from './layer'
