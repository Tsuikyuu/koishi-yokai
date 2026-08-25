import { SQLiteDriver } from '@minatojs/driver-sqlite'
import { expect, it } from '@effect/vitest'
import { Deferred, Effect } from 'effect'
import { Bot, Context, type Fragment, Universal } from 'koishi'
import { vi } from 'vitest'

vi.mock('koishi', () => import('@koishijs/core'))

import { apply, type Config } from '../../src/index'
import type { YokaiMessageRow } from '../../src/message-archive/model'

const CONFIG: Config = {
  instanceId: 'integration',
  feedbackToolsEnabled: false,
  messageRetentionDays: 90,
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

const makeSession = (
  bot: TestBot,
  type: 'message-created' | 'message-updated',
  messageId: string,
  content: string,
  userId: string,
  timestamp: number,
) => {
  const session = bot.session({
    type,
    user: { id: userId, name: userId },
    channel: { id: 'channel', type: Universal.Channel.Type.TEXT },
    guild: { id: 'guild' },
    timestamp,
  })
  session.messageId = messageId
  session.content = content
  return session
}

const waitForRowCount: (
  ctx: Context,
  expected: number,
  attempts: number,
) => Effect.Effect<ReadonlyArray<YokaiMessageRow>> = Effect.fn(
  'MessageArchiveIntegrationTest.waitForRowCount',
)(function* (ctx: Context, expected: number, attempts: number) {
  const rows = yield* Effect.promise(() => ctx.database.get('yokai_message', {}))
  if (rows.length === expected) return rows
  if (attempts === 0) {
    return yield* Effect.die(`Expected ${expected} archived rows, received ${rows.length}`)
  }
  yield* Effect.yieldNow
  return yield* waitForRowCount(ctx, expected, attempts - 1)
})

it.effect('archives created, edited, and self messages without a delete listener', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const context = new Context()
          context.plugin(SQLiteDriver, { path: ':memory:' })
          apply(context, CONFIG)
          return context
        }).pipe(Effect.tap((context) => Effect.promise(() => context.start()))),
        (context) => Effect.promise(() => context.stop()),
      )
      const bot = new TestBot(ctx)

      const createdDone = yield* Deferred.make<void>()
      const removeMiddlewareListener = ctx.on('middleware', (session) => {
        if (session.messageId === 'message-1') {
          Effect.runSync(Deferred.succeed(createdDone, undefined))
        }
      })
      bot.dispatch(makeSession(bot, 'message-created', 'message-1', 'original', 'user', 1_000))
      yield* Deferred.await(createdDone)
      yield* Effect.sync(() => removeMiddlewareListener())

      bot.dispatch(makeSession(bot, 'message-updated', 'message-1', 'edited', 'user', 2_000))
      const editedRows = yield* waitForRowCount(ctx, 2, 100)
      expect(editedRows.map((row) => row.content)).toEqual(['original', 'edited'])

      bot.dispatch(makeSession(bot, 'message-created', 'message-self', 'own reply', 'bot', 3_000))
      const rows = yield* waitForRowCount(ctx, 3, 100)
      const selfMessage = rows.find((row) => row.messageId === 'message-self')
      if (selfMessage === undefined) return yield* Effect.die('Expected an archived self message')
      expect(selfMessage.isSelf).toBe(true)

      const replayDone = yield* Deferred.make<void>()
      const removeReplayListener = ctx.on('middleware', (session) => {
        if (session.messageId === 'message-1') {
          Effect.runSync(Deferred.succeed(replayDone, undefined))
        }
      })
      bot.dispatch(makeSession(bot, 'message-created', 'message-1', 'replayed', 'user', 4_000))
      yield* Deferred.await(replayDone)
      yield* Effect.sync(() => removeReplayListener())
      expect(yield* Effect.promise(() => ctx.database.get('yokai_message', {}))).toHaveLength(3)

      ctx.emit(
        'message-deleted',
        makeSession(bot, 'message-created', 'message-1', '', 'user', 5_000),
      )
      expect(yield* Effect.promise(() => ctx.database.get('yokai_message', {}))).toHaveLength(3)
    }),
  ),
)
