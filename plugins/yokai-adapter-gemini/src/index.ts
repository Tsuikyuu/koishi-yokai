import { Effect, ManagedRuntime } from 'effect'
import type { Context } from 'koishi'
import type { YokaiCapabilityHost } from '@yokai/protocol'

import { Config as ConfigSchema, type Config as GeminiPluginConfig } from './config/plugin-config'
import { GeminiAdapter } from './adapter/adapter'
import { GeminiRuntime } from './runtime/layer'

export const name = 'yokai-adapter-gemini'
export const inject = ['http', 'yokai']

type YokaiContext = Context & {
  readonly yokai: YokaiCapabilityHost
}

export const Config = ConfigSchema
export type Config = GeminiPluginConfig
export { GeminiAdapter } from './adapter/adapter'
export { GeminiModelDiscovery } from './discovery/discovery'
export { GeminiTextGeneration } from './generation/generation'
export { makeLayer as makeGeminiLayer } from './runtime/layer'

export function apply(ctx: YokaiContext, config: Config): Promise<void> {
  const runtime = ManagedRuntime.make(GeminiRuntime.makeRegisteredLayer(config, ctx.http))

  ctx.on('dispose', runtime.dispose)
  const adapter = runtime.runSync(GeminiAdapter.Service)
  return runtime.runPromise(
    Effect.promise(() => ctx.yokai.registerAdapter(adapter)).pipe(Effect.asVoid),
  )
}
