import type { Context } from 'koishi'

import { Config as ConfigSchema, type Config as YokaiConfig } from './config'
import { register as registerDirectMention } from './direct-mention/middleware'
import { Yokai } from './service'

export const name = 'yokai'

export const Config = ConfigSchema
export type Config = YokaiConfig
export { Yokai } from './service'

export function apply(ctx: Context, config: Config): void {
  const service = new Yokai(ctx, config)
  ctx.set('yokai', service)
  registerDirectMention(ctx, service)
}
