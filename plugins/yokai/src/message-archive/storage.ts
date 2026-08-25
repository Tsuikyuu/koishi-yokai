import { MessageArchiveEvent, MessageArchiveStorage } from '@yokai-internal/memory'
import { Effect, Layer, Option, Schema, Semaphore } from 'effect'
import type { Context } from 'koishi'

import type { YokaiMessageRow } from './model'

const decodeArchivedMessage = Schema.decodeUnknownEffect(MessageArchiveEvent.ArchivedMessage)

const scopeQuery = (scope: MessageArchiveEvent.ChannelScope) => ({
  instanceId: scope.instanceId,
  platform: scope.platform,
  guildId: scope.guildId,
  channelId: scope.channelId,
})

const messageQuery = (
  scope: MessageArchiveEvent.ChannelScope,
  messageId: MessageArchiveEvent.MessageId,
) => ({ ...scopeQuery(scope), messageId })

const toArchivedMessage = Effect.fn('KoishiMessageArchiveStorage.decodeRow')(function* (
  row: YokaiMessageRow,
) {
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

const toRow = (message: MessageArchiveEvent.ArchivedMessage): YokaiMessageRow => ({
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
  timestamp: new Date(message.timestamp),
  eventTimestamp: new Date(message.eventTimestamp),
  recordedAt: new Date(message.recordedAt),
  content: message.content,
  isSelf: message.isSelf,
})

const storageFailure = (operation: MessageArchiveStorage.StorageOperation) =>
  Effect.mapError((cause) => new MessageArchiveStorage.StorageError({ operation, cause }))

export const layer = (ctx: Context) =>
  Layer.effect(
    MessageArchiveStorage.Service,
    Effect.gen(function* () {
      const writeGate = yield* Semaphore.make(1)

      const latest = Effect.fn('KoishiMessageArchiveStorage.latest')(function* (
        scope: MessageArchiveEvent.ChannelScope,
        messageId: MessageArchiveEvent.MessageId,
      ) {
        const rows = yield* Effect.tryPromise(() =>
          ctx.database.get('yokai_message', messageQuery(scope, messageId), {
            limit: 1,
            sort: { version: 'desc' },
          }),
        ).pipe(storageFailure('latest'))
        const row = rows[0]
        if (row === undefined) return Option.none<MessageArchiveEvent.ArchivedMessage>()
        return Option.some(yield* toArchivedMessage(row).pipe(storageFailure('latest')))
      })

      const versions = Effect.fn('KoishiMessageArchiveStorage.versions')(function* (
        scope: MessageArchiveEvent.ChannelScope,
        messageId: MessageArchiveEvent.MessageId,
      ) {
        const rows = yield* Effect.tryPromise(() =>
          ctx.database.get('yokai_message', messageQuery(scope, messageId), {
            sort: { version: 'asc' },
          }),
        ).pipe(storageFailure('versions'))
        return yield* Effect.forEach(rows, (row) =>
          toArchivedMessage(row).pipe(storageFailure('versions')),
        )
      })

      const insert = Effect.fn('KoishiMessageArchiveStorage.insert')(function* (
        message: MessageArchiveEvent.ArchivedMessage,
      ) {
        yield* Effect.tryPromise(() => ctx.database.create('yokai_message', toRow(message))).pipe(
          storageFailure('store'),
        )
      })

      const store = Effect.fn('KoishiMessageArchiveStorage.store')(function* (
        event: MessageArchiveEvent.NormalizedEvent,
        recordedAt: MessageArchiveEvent.Timestamp,
      ) {
        return yield* writeGate.withPermits(1)(
          Effect.gen(function* () {
            const scope = MessageArchiveEvent.scopeOf(event)
            const current = yield* latest(scope, event.messageId)
            if (event._tag === 'MessageCreated') {
              if (Option.isSome(current)) {
                return MessageArchiveEvent.RecordResult.Replay({ message: current.value })
              }
              const message = MessageArchiveEvent.originalMessage(event, recordedAt)
              yield* insert(message)
              return MessageArchiveEvent.RecordResult.Stored({ message })
            }

            if (Option.isNone(current)) {
              return yield* Effect.fail(
                new MessageArchiveStorage.OriginalMessageNotFoundError({
                  instanceId: event.instanceId,
                  messageId: event.messageId,
                }),
              )
            }
            if (current.value.content === event.content) {
              return MessageArchiveEvent.RecordResult.Replay({ message: current.value })
            }
            const message = MessageArchiveEvent.editedVersion(event, current.value, recordedAt)
            yield* insert(message)
            return MessageArchiveEvent.RecordResult.Stored({ message })
          }),
        )
      })

      const removeExpired = Effect.fn('KoishiMessageArchiveStorage.removeExpired')(function* (
        instanceId: MessageArchiveEvent.InstanceId,
        cutoff: MessageArchiveEvent.Timestamp,
      ) {
        const result = yield* Effect.tryPromise(() =>
          ctx.database.remove('yokai_message', {
            instanceId,
            timestamp: { $lt: new Date(cutoff) },
          }),
        ).pipe(storageFailure('remove-expired'))
        return result.removed === undefined ? 0 : result.removed
      })

      return MessageArchiveStorage.Service.of({ store, latest, versions, removeExpired })
    }),
  )

export * as KoishiMessageArchiveStorage from './storage'
