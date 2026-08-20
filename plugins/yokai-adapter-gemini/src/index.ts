import { Context, Schema } from 'koishi'

export const name = 'yokai-adapter-gemini'

export interface Config {}

export const Config: Schema<Config> = Schema.object({})

export function apply(_ctx: Context, _config: Config) {
  // Gemini adapter registration is introduced in YK-004.
}
