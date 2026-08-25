import { SQLiteDriver } from '@minatojs/driver-sqlite'
import { expect, it } from '@effect/vitest'
import {
  MessageArchiveEvent,
  MessageArchiveStorage,
  MessageHistoryQuery,
  MessageHistoryStorage,
} from '@yokai-internal/memory'
import { Effect, Layer, Option } from 'effect'
import { Context } from 'koishi'
import { vi } from 'vitest'

vi.mock('koishi', () => import('@koishijs/core'))

import { KoishiMessageHistoryStorage } from '../../src/history/storage'
import { YokaiMessageModel } from '../../src/message-archive/model'
import { KoishiMessageArchiveStorage } from '../../src/message-archive/storage'

const INSTANCE_ID = MessageArchiveEvent.InstanceId.make('history-storage')
const SELF_ID = MessageArchiveEvent.ActorId.make('bot')

const scope = (channelId = 'channel') =>
  MessageArchiveEvent.ChannelScope.make({
    instanceId: INSTANCE_ID,
    platform: MessageArchiveEvent.PlatformId.make('test'),
    guildId: MessageArchiveEvent.GuildId.make('guild'),
    channelId: MessageArchiveEvent.ChannelId.make(channelId),
  })

const event = (
  kind: 'created' | 'updated',
  messageId: string,
  content: string,
  timestamp: number,
  authorId = 'author',
) => {
  const fields = {
    ...scope(),
    messageId: MessageArchiveEvent.MessageId.make(messageId),
    authorId: MessageArchiveEvent.ActorId.make(authorId),
    selfId: SELF_ID,
    timestamp: MessageArchiveEvent.Timestamp.make(timestamp),
    content,
    isSelf: false,
  }
  return kind === 'created'
    ? MessageArchiveEvent.NormalizedEvent.cases.MessageCreated.make(fields)
    : MessageArchiveEvent.NormalizedEvent.cases.MessageUpdated.make(fields)
}

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

it.effect('returns only latest versions in stable timestamp and message ID order', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* databaseContext
      const program = Effect.gen(function* () {
        const archive = yield* MessageArchiveStorage.Service
        const history = yield* MessageHistoryStorage.Service
        yield* archive.store(
          event('created', 'a', 'alpha', 1_000),
          MessageArchiveEvent.Timestamp.make(1_001),
        )
        yield* archive.store(
          event('created', 'b', 'beta', 1_000),
          MessageArchiveEvent.Timestamp.make(1_002),
        )
        yield* archive.store(
          event('created', 'c', 'gamma', 1_000),
          MessageArchiveEvent.Timestamp.make(1_003),
        )
        yield* archive.store(
          event('updated', 'b', 'beta edited', 2_000),
          MessageArchiveEvent.Timestamp.make(2_001),
        )

        const rows = yield* history.search({
          scope: scope(),
          direction: 'before',
          anchor: Option.none(),
          filters: MessageHistoryQuery.emptyFilters(),
          fetchLimit: 10,
        })
        expect(rows.map((row) => row.messageId)).toEqual(['c', 'b', 'a'])
        expect(rows.map((row) => row.content)).toEqual(['gamma', 'beta edited', 'alpha'])
        expect(rows.find((row) => row.messageId === 'b')).toMatchObject({ version: 2 })
      }).pipe(
        Effect.provide(
          Layer.merge(
            KoishiMessageArchiveStorage.layer(ctx),
            KoishiMessageHistoryStorage.layer(ctx),
          ),
        ),
      )

      yield* program
    }),
  ),
)

it.effect('locks storage reads to scope and applies author, keyword, and time filters', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* databaseContext
      const program = Effect.gen(function* () {
        const archive = yield* MessageArchiveStorage.Service
        const history = yield* MessageHistoryStorage.Service
        yield* archive.store(
          event('created', 'one', 'Project Yokai', 1_000, 'alice'),
          MessageArchiveEvent.Timestamp.make(1_000),
        )
        yield* archive.store(
          event('created', 'two', 'unrelated', 2_000, 'alice'),
          MessageArchiveEvent.Timestamp.make(2_000),
        )

        const otherScopeEvent = MessageArchiveEvent.NormalizedEvent.cases.MessageCreated.make({
          ...scope('other-channel'),
          messageId: MessageArchiveEvent.MessageId.make('leak'),
          authorId: MessageArchiveEvent.ActorId.make('alice'),
          selfId: SELF_ID,
          timestamp: MessageArchiveEvent.Timestamp.make(1_500),
          content: 'Project Yokai secret',
          isSelf: false,
        })
        yield* archive.store(otherScopeEvent, MessageArchiveEvent.Timestamp.make(1_500))

        const rows = yield* history.search({
          scope: scope(),
          direction: 'after',
          anchor: Option.none(),
          filters: MessageHistoryQuery.HistoryFilters.make({
            authorId: Option.some(MessageArchiveEvent.ActorId.make('alice')),
            keyword: Option.some(MessageHistoryQuery.HistoryKeyword.make('yokai')),
            fromTimestamp: Option.some(MessageArchiveEvent.Timestamp.make(900)),
            toTimestamp: Option.some(MessageArchiveEvent.Timestamp.make(1_100)),
          }),
          fetchLimit: 10,
        })
        expect(rows.map((row) => row.messageId)).toEqual(['one'])
      }).pipe(
        Effect.provide(
          Layer.merge(
            KoishiMessageArchiveStorage.layer(ctx),
            KoishiMessageHistoryStorage.layer(ctx),
          ),
        ),
      )

      yield* program
    }),
  ),
)
