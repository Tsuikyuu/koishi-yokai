import { Layer } from 'effect'

import { GeminiClientFactory } from '../client/client-factory'
import { GeminiConfiguration } from '../config/configuration'
import type { Config } from '../config/plugin-config'
import { GeminiConnection } from '../connection/connection'

/**
 * Owns the single logical connection Scope for one Gemini plugin instance. The layer is
 * lazy: configuration is decoded and clients are created only when it is built.
 */
export const makeLayer = (config: Config) =>
  GeminiConnection.layer.pipe(
    Layer.provide(Layer.mergeAll(GeminiConfiguration.layer(config), GeminiClientFactory.layer)),
  )

export * as GeminiRuntime from './layer'
