import type { PresetSnapshot, YokaiCapabilityHost } from 'yokai-protocol'
import type { Context } from 'koishi'

import { Config as ConfigSchema, type Config as YokaiConfig } from './config'
import { register as registerMessageArchive } from './message-archive/integration'
import { define as defineMessageArchiveModel } from './message-archive/model'
import { YokaiRoleStateModel } from './role-state/index'
import { Yokai } from './service'

export const name = 'yokai'
export const inject = ['database']

export const Config = ConfigSchema
export type Config = YokaiConfig

declare module 'koishi' {
  interface Context {
    yokai: YokaiCapabilityHost
  }

  interface Events {
    'yokai/preset-updated'(snapshot: PresetSnapshot): void
  }
}

export function apply(ctx: Context, config: Config): void {
  defineMessageArchiveModel(ctx)
  YokaiRoleStateModel.define(ctx)
  const service = new Yokai(ctx, config)
  ctx.set('yokai', service)
  registerMessageArchive(ctx, service)
}
