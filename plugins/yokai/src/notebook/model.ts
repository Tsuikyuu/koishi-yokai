import type { Context } from 'koishi'

export interface YokaiMemoryRow {
  instanceId: string
  platform: string
  guildId: string
  channelId: string
  noteId: string
  kind: 'episode' | 'fact' | 'relationship' | 'self'
  objectId: string | null
  content: string
  topicsJson: string
  sourceMessageIdsJson: string
  confidence: number
  importance: number
  createdAt: Date
  expiresAt: Date | null
  correctsNoteId: string | null
  supersededByNoteId: string | null
}

declare module 'koishi' {
  interface Tables {
    yokai_memory: YokaiMemoryRow
  }
}

export const define = (ctx: Context): void => {
  ctx.model.extend(
    'yokai_memory',
    {
      instanceId: 'string(128)',
      platform: 'string(512)',
      guildId: 'string(512)',
      channelId: 'string(512)',
      noteId: 'string(64)',
      kind: 'string(16)',
      objectId: { type: 'string', length: 512, nullable: true, initial: null },
      content: 'text',
      topicsJson: 'text',
      sourceMessageIdsJson: 'text',
      confidence: 'double',
      importance: 'double',
      createdAt: 'timestamp',
      expiresAt: { type: 'timestamp', nullable: true, initial: null },
      correctsNoteId: { type: 'string', length: 64, nullable: true, initial: null },
      supersededByNoteId: { type: 'string', length: 64, nullable: true, initial: null },
    },
    {
      primary: ['instanceId', 'platform', 'guildId', 'channelId', 'noteId'],
      indexes: [
        [
          'instanceId',
          'platform',
          'guildId',
          'channelId',
          'supersededByNoteId',
          'expiresAt',
          'confidence',
          'importance',
          'createdAt',
          'noteId',
        ],
        ['instanceId', 'platform', 'guildId', 'channelId', 'objectId', 'createdAt', 'noteId'],
      ],
    },
  )
}

export * as YokaiNotebookModel from './model'
