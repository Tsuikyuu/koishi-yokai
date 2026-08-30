import { SQLiteDriver } from '@minatojs/driver-sqlite'
import { expect, it } from '@effect/vitest'
import { MessageArchiveEvent, MessageArchiveStorage } from '@yokai-internal/memory'
import { Effect, Option } from 'effect'
import { Context } from 'koishi'
import { vi } from 'vitest'

vi.mock('koishi', () => import('@koishijs/core'))

import { YokaiMessageModel } from '../../src/message-archive/model'
import { KoishiMessageArchiveStorage } from '../../src/message-archive/storage'

const PRIMARY_INSTANCE = MessageArchiveEvent.InstanceId.make('primary')
const SECONDARY_INSTANCE = MessageArchiveEvent.InstanceId.make('secondary')
const MESSAGE_ID = MessageArchiveEvent.MessageId.make('same-message')
const AUTHOR_ID = MessageArchiveEvent.ActorId.make('author')
const SELF_ID = MessageArchiveEvent.ActorId.make('bot')

const scope = (
  instanceId: MessageArchiveEvent.InstanceId,
  channelId: string,
): MessageArchiveEvent.ChannelScope =>
  MessageArchiveEvent.ChannelScope.make({
    instanceId,
    platform: MessageArchiveEvent.PlatformId.make('test'),
    guildId: MessageArchiveEvent.GuildId.make('guild'),
    channelId: MessageArchiveEvent.ChannelId.make(channelId),
  })

const created = (
  channelScope: MessageArchiveEvent.ChannelScope,
  content: string,
  timestamp: number,
  replyToMessageId: Option.Option<MessageArchiveEvent.MessageId> = Option.none(),
): MessageArchiveEvent.NormalizedEvent =>
  MessageArchiveEvent.NormalizedEvent.cases.MessageCreated.make({
    ...channelScope,
    messageId: MESSAGE_ID,
    authorId: AUTHOR_ID,
    selfId: SELF_ID,
    replyToMessageId,
    timestamp: MessageArchiveEvent.Timestamp.make(timestamp),
    content,
    isSelf: false,
  })

const updated = (
  channelScope: MessageArchiveEvent.ChannelScope,
  content: string,
  timestamp: number,
): MessageArchiveEvent.NormalizedEvent =>
  MessageArchiveEvent.NormalizedEvent.cases.MessageUpdated.make({
    ...channelScope,
    messageId: MESSAGE_ID,
    authorId: AUTHOR_ID,
    selfId: SELF_ID,
    replyToMessageId: Option.none(),
    timestamp: MessageArchiveEvent.Timestamp.make(timestamp),
    content,
    isSelf: false,
  })

const databaseContext = Effect.acquireRelease(
  Effect.gen(function* () {
    const ctx = yield* Effect.sync(() => {
      const context = new Context()
      YokaiMessageModel.define(context)
      context.plugin(SQLiteDriver, { path: ':memory:' })
      return context
    })
    yield* Effect.promise(() => ctx.start())
    return ctx
  }),
  (ctx) => Effect.promise(() => ctx.stop()),
)

it.effect('defines stable message indexes and persists idempotent linked versions', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* databaseContext
      const model = ctx.model.tables.yokai_message
      if (model === undefined) return yield* Effect.die('Expected the Yokai message model')
      expect(model.primary).toEqual([
        'instanceId',
        'platform',
        'guildId',
        'channelId',
        'messageId',
        'version',
      ])
      expect(model.indexes.map((index) => Object.keys(index.keys))).toEqual([
        ['instanceId', 'platform', 'guildId', 'channelId', 'timestamp', 'messageId'],
        ['instanceId', 'platform', 'guildId', 'channelId', 'authorId'],
      ])

      const program = Effect.gen(function* () {
        const storage = yield* MessageArchiveStorage.Service
        const channelScope = scope(PRIMARY_INSTANCE, 'channel')
        const first = yield* storage.store(
          created(
            channelScope,
            'original',
            1_000,
            Option.some(MessageArchiveEvent.MessageId.make('parent-message')),
          ),
          MessageArchiveEvent.Timestamp.make(1_100),
        )
        const replay = yield* storage.store(
          created(channelScope, 'ignored replay', 1_200),
          MessageArchiveEvent.Timestamp.make(1_300),
        )
        const edit = yield* storage.store(
          updated(channelScope, 'edited', 2_000),
          MessageArchiveEvent.Timestamp.make(2_100),
        )

        const versions = yield* storage.versions(channelScope, MESSAGE_ID)
        const latest = yield* storage.latest(channelScope, MESSAGE_ID)
        expect(first._tag).toBe('Stored')
        expect(Option.getOrUndefined(first.message.replyToMessageId)).toBe('parent-message')
        expect(replay._tag).toBe('Replay')
        expect(edit._tag).toBe('Stored')
        expect(versions).toHaveLength(2)
        expect(versions.map((message) => message.content)).toEqual(['original', 'edited'])
        const edited = versions[1]
        if (edited === undefined) return yield* Effect.die('Expected an edited version')
        expect(Option.getOrUndefined(edited.sourceVersion)).toBe(1)
        expect(Option.getOrUndefined(edited.previousVersion)).toBe(1)
        expect(Option.getOrUndefined(edited.replyToMessageId)).toBe('parent-message')
        if (Option.isNone(latest)) return yield* Effect.die('Expected a latest version')
        expect(latest.value.content).toBe('edited')
      }).pipe(Effect.provide(KoishiMessageArchiveStorage.layer(ctx)))

      yield* program
      expect(yield* Effect.promise(() => ctx.database.get('yokai_message', {}))).toHaveLength(2)
    }),
  ),
)

it.effect('keeps cleanup and reads isolated by instance and channel', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* databaseContext
      const program = Effect.gen(function* () {
        const storage = yield* MessageArchiveStorage.Service
        const primary = scope(PRIMARY_INSTANCE, 'shared-channel')
        const secondary = scope(SECONDARY_INSTANCE, 'shared-channel')
        yield* storage.store(
          created(primary, 'primary', 1_000),
          MessageArchiveEvent.Timestamp.make(1_000),
        )
        yield* storage.store(
          created(secondary, 'secondary', 1_000),
          MessageArchiveEvent.Timestamp.make(1_000),
        )

        const primaryLatest = yield* storage.latest(primary, MESSAGE_ID)
        if (Option.isNone(primaryLatest)) return yield* Effect.die('Expected the primary message')
        expect(primaryLatest.value.content).toBe('primary')
        expect(
          Option.isNone(yield* storage.latest(scope(PRIMARY_INSTANCE, 'missing'), MESSAGE_ID)),
        ).toBe(true)

        expect(
          yield* storage.removeExpired(PRIMARY_INSTANCE, MessageArchiveEvent.Timestamp.make(1_000)),
        ).toBe(0)
        expect(
          yield* storage.removeExpired(PRIMARY_INSTANCE, MessageArchiveEvent.Timestamp.make(1_001)),
        ).toBe(1)
        expect(Option.isNone(yield* storage.latest(primary, MESSAGE_ID))).toBe(true)
        expect(Option.isSome(yield* storage.latest(secondary, MESSAGE_ID))).toBe(true)
      }).pipe(Effect.provide(KoishiMessageArchiveStorage.layer(ctx)))

      yield* program
    }),
  ),
)
