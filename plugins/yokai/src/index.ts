import { Context, Schema } from 'koishi'

export const name = 'yokai'

export interface Config {}

export const Config: Schema<Config> = Schema.object({})

export function apply(_ctx: Context, _config: Config) {
  // write your plugin here
}
