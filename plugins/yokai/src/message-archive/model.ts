import type { Context } from 'koishi'

export interface YokaiMessageRow {
  instanceId: string
  platform: string
  guildId: string
  channelId: string
  messageId: string
  version: number
  sourceVersion: number | null
  previousVersion: number | null
  kind: 'created' | 'updated'
  authorId: string
  selfId: string
  timestamp: Date
  eventTimestamp: Date
  recordedAt: Date
  content: string
  isSelf: boolean
}

declare module 'koishi' {
  interface Tables {
    yokai_message: YokaiMessageRow
  }
}

export const define = (ctx: Context): void => {
  ctx.model.extend(
    'yokai_message',
    {
      instanceId: 'string(128)',
      platform: 'string(512)',
      guildId: 'string(512)',
      channelId: 'string(512)',
      messageId: 'string(512)',
      version: 'unsigned',
      sourceVersion: { type: 'unsigned', nullable: true, initial: null },
      previousVersion: { type: 'unsigned', nullable: true, initial: null },
      kind: 'string(16)',
      authorId: 'string(512)',
      selfId: 'string(512)',
      timestamp: 'timestamp',
      eventTimestamp: 'timestamp',
      recordedAt: 'timestamp',
      content: 'text',
      isSelf: 'boolean',
    },
    {
      primary: ['instanceId', 'platform', 'guildId', 'channelId', 'messageId', 'version'],
      indexes: [
        ['instanceId', 'platform', 'guildId', 'channelId', 'timestamp', 'messageId'],
        ['instanceId', 'platform', 'guildId', 'channelId', 'authorId'],
      ],
    },
  )
}

export * as YokaiMessageModel from './model'
