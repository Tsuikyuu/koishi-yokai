import { Effect, ManagedRuntime } from 'effect'
import type { Context } from 'koishi'

import { Config as ConfigSchema, type Config as GeminiPluginConfig } from './config/plugin-config'
import { GeminiConnection } from './connection/connection'
import { GeminiRuntime } from './runtime/layer'

export const name = 'yokai-adapter-gemini'
export const reusable = false

export const Config = ConfigSchema
export type Config = GeminiPluginConfig
export { makeLayer as makeGeminiLayer } from './runtime/layer'

export function apply(ctx: Context, config: Config): void {
  const runtime = ManagedRuntime.make(GeminiRuntime.makeLayer(config, ctx.http))

  ctx.on('dispose', runtime.dispose)
  runtime.runSync(GeminiConnection.Service.pipe(Effect.asVoid))
}
