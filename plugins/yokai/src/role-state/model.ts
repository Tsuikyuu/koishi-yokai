import type { Context } from 'koishi'

export interface YokaiChannelStateRow {
  instanceId: string
  platform: string
  guildId: string
  channelId: string
  payload: string
  updatedAt: Date
}

export interface YokaiMemberStateRow {
  instanceId: string
  platform: string
  guildId: string
  channelId: string
  memberId: string
  payload: string
  updatedAt: Date
}

declare module 'koishi' {
  interface Tables {
    yokai_channel_state: YokaiChannelStateRow
    yokai_member_state: YokaiMemberStateRow
  }
}

export const define = (ctx: Context): void => {
  ctx.model.extend(
    'yokai_channel_state',
    {
      instanceId: 'string(128)',
      platform: 'string(512)',
      guildId: 'string(512)',
      channelId: 'string(512)',
      payload: 'text',
      updatedAt: 'timestamp',
    },
    {
      primary: ['instanceId', 'platform', 'guildId', 'channelId'],
    },
  )

  ctx.model.extend(
    'yokai_member_state',
    {
      instanceId: 'string(128)',
      platform: 'string(512)',
      guildId: 'string(512)',
      channelId: 'string(512)',
      memberId: 'string(512)',
      payload: 'text',
      updatedAt: 'timestamp',
    },
    {
      primary: ['instanceId', 'platform', 'guildId', 'channelId', 'memberId'],
    },
  )
}

export * as YokaiRoleStateModel from './model'
