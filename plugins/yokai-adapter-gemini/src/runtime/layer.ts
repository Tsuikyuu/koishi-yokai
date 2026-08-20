import { Layer } from 'effect'

import { GeminiClientFactory } from '../client/client-factory.js'
import { GeminiConfiguration } from '../config/configuration.js'
import type { Config } from '../config/plugin-config.js'
import { GeminiConnectionPool } from '../connection/pool.js'

/**
 * Owns every connection Scope for one Gemini plugin instance. The layer is
 * lazy: configuration is decoded and clients are created only when it is built.
 */
export const makeLayer = (config: Config) =>
  GeminiConnectionPool.layer.pipe(
    Layer.provide(Layer.mergeAll(GeminiConfiguration.layer(config), GeminiClientFactory.layer)),
  )

export * as GeminiRuntime from './layer.js'
