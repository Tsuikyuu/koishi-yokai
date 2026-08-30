import { MessageArchiveEvent } from '@yokai-internal/memory'
import { Effect, Option, Schema } from 'effect'

import type { YokaiMessageRow } from './model'

const decodeArchivedMessage = Schema.decodeUnknownEffect(MessageArchiveEvent.ArchivedMessage)

export const decode = Effect.fn('KoishiMessageArchiveRow.decode')(function* (row: YokaiMessageRow) {
  return yield* decodeArchivedMessage({
    instanceId: row.instanceId,
    platform: row.platform,
    guildId: row.guildId,
    channelId: row.channelId,
    messageId: row.messageId,
    version: row.version,
    sourceVersion: row.sourceVersion,
    previousVersion: row.previousVersion,
    kind: row.kind,
    authorId: row.authorId,
    selfId: row.selfId,
    replyToMessageId: row.replyToMessageId,
    timestamp: row.timestamp.getTime(),
    eventTimestamp: row.eventTimestamp.getTime(),
    recordedAt: row.recordedAt.getTime(),
    content: row.content,
    isSelf: row.isSelf,
  })
})

const nullableVersion = (version: Option.Option<MessageArchiveEvent.MessageVersion>) =>
  Option.match(version, {
    onNone: () => null,
    onSome: (value) => value,
  })

const nullableMessageId = (messageId: Option.Option<MessageArchiveEvent.MessageId>) =>
  Option.match(messageId, {
    onNone: () => null,
    onSome: (value) => value,
  })

export const encode = (message: MessageArchiveEvent.ArchivedMessage): YokaiMessageRow => ({
  instanceId: message.instanceId,
  platform: message.platform,
  guildId: message.guildId,
  channelId: message.channelId,
  messageId: message.messageId,
  version: message.version,
  sourceVersion: nullableVersion(message.sourceVersion),
  previousVersion: nullableVersion(message.previousVersion),
  kind: message.kind,
  authorId: message.authorId,
  selfId: message.selfId,
  replyToMessageId: nullableMessageId(message.replyToMessageId),
  timestamp: new Date(message.timestamp),
  eventTimestamp: new Date(message.eventTimestamp),
  recordedAt: new Date(message.recordedAt),
  content: message.content,
  isSelf: message.isSelf,
})

export * as YokaiMessageRowCodec from './row'
