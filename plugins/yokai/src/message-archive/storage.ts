import { MessageArchiveEvent, MessageArchiveStorage } from '@yokai-internal/memory'
import { Effect, Layer, Option, Semaphore } from 'effect'
import type { Context } from 'koishi'

import { YokaiMessageRowCodec } from './row'

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
        return Option.some(yield* YokaiMessageRowCodec.decode(row).pipe(storageFailure('latest')))
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
          YokaiMessageRowCodec.decode(row).pipe(storageFailure('versions')),
        )
      })

      const insert = Effect.fn('KoishiMessageArchiveStorage.insert')(function* (
        message: MessageArchiveEvent.ArchivedMessage,
      ) {
        yield* Effect.tryPromise(() =>
          ctx.database.create('yokai_message', YokaiMessageRowCodec.encode(message)),
        ).pipe(storageFailure('store'))
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
