import type { Context } from 'koishi'

export interface YokaiScheduleRow {
  instanceId: string
  platform: string
  guildId: string
  channelId: string
  scheduleId: string
  dedupeKey: string
  creationFingerprint: string
  createdMessageId: string
  creatorId: string
  selfId: string
  reason: string
  dueAt: Date
  repeatEveryMs: number | null
  timeZone: string
  status: string
  occurrence: number
  revision: number
  createdAt: Date
  updatedAt: Date
  lastTriggeredAt: Date | null
}

declare module 'koishi' {
  interface Tables {
    yokai_schedule: YokaiScheduleRow
  }
}

export const define = (ctx: Context): void => {
  ctx.model.extend(
    'yokai_schedule',
    {
      instanceId: 'string(128)',
      platform: 'string(512)',
      guildId: 'string(512)',
      channelId: 'string(512)',
      scheduleId: 'string(64)',
      dedupeKey: 'string(256)',
      creationFingerprint: 'string(64)',
      createdMessageId: 'string(512)',
      creatorId: 'string(512)',
      selfId: 'string(512)',
      reason: 'text',
      dueAt: 'timestamp',
      repeatEveryMs: { type: 'unsigned', length: 8, nullable: true, initial: null },
      timeZone: 'string(128)',
      status: 'string(16)',
      occurrence: { type: 'unsigned', length: 8 },
      revision: { type: 'unsigned', length: 8 },
      createdAt: 'timestamp',
      updatedAt: 'timestamp',
      lastTriggeredAt: { type: 'timestamp', nullable: true, initial: null },
    },
    {
      primary: ['instanceId', 'platform', 'guildId', 'channelId', 'scheduleId'],
      indexes: [
        ['instanceId', 'status', 'dueAt', 'scheduleId'],
        ['instanceId', 'platform', 'guildId', 'channelId', 'status', 'dueAt', 'scheduleId'],
      ],
    },
  )
}

export * as YokaiScheduleModel from './model'
