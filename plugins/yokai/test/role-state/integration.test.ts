import { SQLiteDriver } from '@minatojs/driver-sqlite'
import { expect, it } from '@effect/vitest'
import { Deferred, Effect } from 'effect'
import { Bot, Context, type Fragment, Universal } from 'koishi'
import { vi } from 'vitest'

vi.mock('koishi', () => import('@koishijs/core'))

import { apply, type Config } from '../../src/index'
import { YokaiRoleStateRowCodec } from '../../src/role-state/row'
import type { YokaiMessageRow } from '../../src/message-archive/model'

const CONFIG: Config = {
  instanceId: 'role-state-integration',
  feedbackToolsEnabled: false,
}

class TestBot extends Bot<Context, {}> {
  constructor(ctx: Context) {
    super(ctx, {}, 'test')
    this.user = { id: 'bot' }
  }

  override sendMessage(_channelId: string, _content: Fragment): Promise<string[]> {
    return Promise.resolve([])
  }

  override dispose(): Promise<void> {
    return Promise.resolve()
  }
}

const roleStateHarness = Effect.acquireRelease(
  Effect.sync(() => {
    const ctx = new Context()
    ctx.plugin(SQLiteDriver, { path: ':memory:' })
    apply(ctx, CONFIG)
    return { ctx, bot: new TestBot(ctx) }
  }).pipe(Effect.tap(({ ctx }) => Effect.promise(() => ctx.start()))),
  ({ ctx }) => Effect.promise(() => ctx.stop()),
)

const makeSession = (
  bot: TestBot,
  type: 'message-created' | 'message-updated',
  messageId: string,
  content: string,
  userId: string,
  timestamp: number,
  isBot = false,
) => {
  const session = bot.session({
    type,
    user: { id: userId, name: userId, isBot },
    channel: { id: 'channel', type: Universal.Channel.Type.TEXT },
    guild: { id: 'guild' },
    timestamp,
  })
  session.messageId = messageId
  session.content = content
  return session
}

const dispatchCreated = Effect.fn('RoleStateIntegrationTest.dispatchCreated')(function* (
  ctx: Context,
  bot: TestBot,
  session: ReturnType<typeof makeSession>,
) {
  const completed = yield* Deferred.make<void>()
  const removeListener = ctx.on('middleware', (observed) => {
    if (observed.messageId === session.messageId) {
      Effect.runSync(Deferred.succeed(completed, undefined))
    }
  })
  bot.dispatch(session)
  yield* Deferred.await(completed)
  yield* Effect.sync(() => removeListener())
})

const waitForArchiveRows: (
  ctx: Context,
  expected: number,
  attempts: number,
) => Effect.Effect<ReadonlyArray<YokaiMessageRow>> = Effect.fn(
  'RoleStateIntegrationTest.waitForArchiveRows',
)(function* (ctx: Context, expected: number, attempts: number) {
  const rows = yield* Effect.promise(() => ctx.database.get('yokai_message', {}))
  if (rows.length === expected) return rows
  if (attempts === 0) {
    return yield* Effect.die(`Expected ${expected} archived rows, received ${rows.length}`)
  }
  yield* Effect.yieldNow
  return yield* waitForArchiveRows(ctx, expected, attempts - 1)
})

const hardTriggerSession = (harness: { readonly bot: TestBot }, messageId: string) => {
  const session = makeSession(
    harness.bot,
    'message-created',
    messageId,
    'please answer',
    'user',
    8_000,
  )
  session.quote = { id: 'previous-yokai-message', user: { id: 'bot' }, content: 'previous reply' }
  return session
}

const expectFailClosed = Effect.fn('RoleStateIntegrationTest.expectFailClosed')(function* (
  harness: { readonly ctx: Context; readonly bot: TestBot },
  messageId: string,
) {
  const continued = yield* Deferred.make<void>()
  const removeMiddleware = harness.ctx.middleware((session, next) => {
    if (session.messageId === messageId) {
      Effect.runSync(Deferred.succeed(continued, undefined))
    }
    return next()
  })
  yield* dispatchCreated(harness.ctx, harness.bot, hardTriggerSession(harness, messageId))
  yield* Effect.sync(() => removeMiddleware())
  expect(yield* Deferred.isDone(continued)).toBe(true)
})

it.effect('fails closed before response mechanisms when the state snapshot cannot load', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* roleStateHarness
      yield* Effect.promise(() =>
        harness.ctx.database.create('yokai_channel_state', {
          instanceId: 'role-state-integration',
          platform: 'test',
          guildId: 'guild',
          channelId: 'channel',
          payload: '{not-json',
          updatedAt: new Date(1_000),
        }),
      )
      yield* expectFailClosed(harness, 'snapshot-failure')
      expect(
        yield* Effect.promise(() => harness.ctx.database.get('yokai_member_state', {})),
      ).toEqual([])
    }),
  ),
)

it.effect('fails closed before response mechanisms when the state observation cannot save', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* roleStateHarness
      vi.spyOn(harness.ctx.database, 'transact').mockRejectedValueOnce(
        new Error('expected state transaction failure'),
      )
      yield* expectFailClosed(harness, 'observe-failure')
      expect(
        yield* Effect.promise(() => harness.ctx.database.get('yokai_channel_state', {})),
      ).toEqual([])
    }),
  ),
)

it.effect(
  'keeps replay idempotent and ignores edit, self, other bots, and ineffective messages',
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* roleStateHarness

        yield* dispatchCreated(
          harness.ctx,
          harness.bot,
          makeSession(harness.bot, 'message-created', 'message-user', 'hello', 'user', 1_000),
        )
        const initialChannelRows = yield* Effect.promise(() =>
          harness.ctx.database.get('yokai_channel_state', {}),
        )
        const initialMemberRows = yield* Effect.promise(() =>
          harness.ctx.database.get('yokai_member_state', {}),
        )
        const initialChannel = initialChannelRows[0]
        const initialMember = initialMemberRows[0]
        if (initialChannel === undefined || initialMember === undefined) {
          return yield* Effect.die('Expected the initial channel and member state rows')
        }

        yield* dispatchCreated(
          harness.ctx,
          harness.bot,
          makeSession(harness.bot, 'message-created', 'message-user', 'replayed', 'user', 2_000),
        )
        const replayedChannelRows = yield* Effect.promise(() =>
          harness.ctx.database.get('yokai_channel_state', {}),
        )
        const replayedMemberRows = yield* Effect.promise(() =>
          harness.ctx.database.get('yokai_member_state', {}),
        )
        expect(replayedChannelRows).toEqual(initialChannelRows)
        expect(replayedMemberRows).toEqual(initialMemberRows)
        harness.bot.dispatch(
          makeSession(harness.bot, 'message-updated', 'message-user', 'edited', 'user', 3_000),
        )
        yield* waitForArchiveRows(harness.ctx, 2, 100)
        harness.bot.dispatch(
          makeSession(harness.bot, 'message-created', 'message-self', 'own reply', 'bot', 4_000),
        )
        yield* waitForArchiveRows(harness.ctx, 3, 100)
        yield* dispatchCreated(
          harness.ctx,
          harness.bot,
          makeSession(
            harness.bot,
            'message-created',
            'message-other-bot',
            'automated reply',
            'other-bot',
            5_000,
            true,
          ),
        )
        yield* waitForArchiveRows(harness.ctx, 4, 100)
        yield* dispatchCreated(
          harness.ctx,
          harness.bot,
          makeSession(
            harness.bot,
            'message-created',
            'message-ineffective',
            '   ',
            'quiet-user',
            6_000,
          ),
        )
        yield* waitForArchiveRows(harness.ctx, 5, 100)

        const channelRows = yield* Effect.promise(() =>
          harness.ctx.database.get('yokai_channel_state', {}),
        )
        const memberRows = yield* Effect.promise(() =>
          harness.ctx.database.get('yokai_member_state', {}),
        )
        expect(channelRows).toHaveLength(1)
        expect(memberRows).toHaveLength(1)
        const channel = channelRows[0]
        const member = memberRows[0]
        if (channel === undefined || member === undefined) {
          return yield* Effect.die('Expected the final channel and member state rows')
        }
        expect(channel.payload).toBe(initialChannel.payload)
        expect(channel.updatedAt).toEqual(initialChannel.updatedAt)
        expect(member.payload).toBe(initialMember.payload)
        expect(member.updatedAt).toEqual(initialMember.updatedAt)

        const channelPayload = yield* YokaiRoleStateRowCodec.decodeChannel(channel)
        const relationship = yield* YokaiRoleStateRowCodec.decodeMember(member)
        expect(channelPayload.appliedInteractionIds).toEqual(['member:message-user'])
        expect(relationship.memberId).toBe('user')
      }),
    ),
)

it.effect('uses an effective human replay to recover state missing after archival', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* roleStateHarness
      const session = () =>
        makeSession(
          harness.bot,
          'message-created',
          'message-recovery',
          'recover this interaction',
          'recovering-user',
          7_000,
        )

      yield* dispatchCreated(harness.ctx, harness.bot, session())
      expect(
        yield* Effect.promise(() => harness.ctx.database.get('yokai_message', {})),
      ).toHaveLength(1)
      expect(
        yield* Effect.promise(() => harness.ctx.database.get('yokai_channel_state', {})),
      ).toHaveLength(1)
      expect(
        yield* Effect.promise(() => harness.ctx.database.get('yokai_member_state', {})),
      ).toHaveLength(1)

      yield* Effect.promise(() => harness.ctx.database.remove('yokai_member_state', {}))
      yield* Effect.promise(() => harness.ctx.database.remove('yokai_channel_state', {}))
      yield* dispatchCreated(harness.ctx, harness.bot, session())

      const channelRows = yield* Effect.promise(() =>
        harness.ctx.database.get('yokai_channel_state', {}),
      )
      const memberRows = yield* Effect.promise(() =>
        harness.ctx.database.get('yokai_member_state', {}),
      )
      expect(channelRows).toHaveLength(1)
      expect(memberRows).toHaveLength(1)
      const channel = channelRows[0]
      const member = memberRows[0]
      if (channel === undefined || member === undefined) {
        return yield* Effect.die('Expected replay to reconstruct role state')
      }
      const channelPayload = yield* YokaiRoleStateRowCodec.decodeChannel(channel)
      const relationship = yield* YokaiRoleStateRowCodec.decodeMember(member)
      expect(channelPayload.appliedInteractionIds).toEqual(['member:message-recovery'])
      expect(relationship.memberId).toBe('recovering-user')
      expect(
        yield* Effect.promise(() => harness.ctx.database.get('yokai_message', {})),
      ).toHaveLength(1)
    }),
  ),
)
