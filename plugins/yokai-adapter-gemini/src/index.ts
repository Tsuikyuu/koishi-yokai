import { Effect, ManagedRuntime } from 'effect'
import type { Context } from 'koishi'

import { Config as ConfigSchema, type Config as GeminiPluginConfig } from './config/plugin-config'
import { GeminiAdapter } from './adapter/adapter'
import { GeminiRuntime } from './runtime/layer'

export const name = 'yokai-adapter-gemini'
export const inject = ['http']

export const Config = ConfigSchema
export type Config = GeminiPluginConfig
export { GeminiAdapter } from './adapter/adapter'
export { GeminiModelDiscovery } from './discovery/discovery'
export { GeminiTextGeneration } from './generation/generation'
export { makeLayer as makeGeminiLayer } from './runtime/layer'

export function apply(ctx: Context, config: Config): void {
  const runtime = ManagedRuntime.make(GeminiRuntime.makeLayer(config, ctx.http))

  ctx.on('dispose', runtime.dispose)
  runtime.runSync(GeminiAdapter.Service.pipe(Effect.asVoid))
}
