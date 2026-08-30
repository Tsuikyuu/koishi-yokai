import { RoleResponseEnvelope } from '@yokai-internal/mind'
import { expect, it } from '@effect/vitest'
import { Deferred, Duration, Effect, Fiber, Option, Ref } from 'effect'
import { TestClock } from 'effect/testing'

import { HostSession, MessageSending } from '../../src/index'

const message = (content: string): RoleResponseEnvelope.ResponseMessage =>
  RoleResponseEnvelope.ResponseMessage.make({ content, quote: Option.none() })

it.effect('waits for pacing and the previous send before starting the next segment', () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const calls = yield* Ref.make<ReadonlyArray<string>>([])
      const sendText: HostSession.SendText = (content) =>
        Effect.gen(function* () {
          yield* Ref.update(calls, (current) => [...current, content])
          if (content === 'a') {
            yield* Deferred.succeed(firstStarted, undefined)
            yield* Deferred.await(releaseFirst)
          }
          if (content === 'bb') {
            yield* Deferred.succeed(secondStarted, undefined)
          }
          return [content]
        })

      const fiber = yield* MessageSending.send({
        kind: 'direct',
        messages: [message('a'), message('bb')],
        sendText,
      }).pipe(Effect.forkScoped)
      yield* Effect.yieldNow

      yield* TestClock.adjust(Duration.millis(42))
      expect(yield* Ref.get(calls)).toEqual([])
      yield* TestClock.adjust(Duration.millis(1))
      yield* Deferred.await(firstStarted)
      expect(yield* Ref.get(calls)).toEqual(['a'])

      yield* TestClock.adjust(Duration.seconds(1))
      expect(yield* Deferred.isDone(secondStarted)).toBe(false)

      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Effect.yieldNow
      yield* TestClock.adjust(Duration.millis(73))
      expect(yield* Deferred.isDone(secondStarted)).toBe(false)
      yield* TestClock.adjust(Duration.millis(1))
      yield* Deferred.await(secondStarted)

      expect(yield* Fiber.join(fiber)).toEqual({
        sentSegments: 2,
        artificialWaitMs: 117,
      })
      expect(yield* Ref.get(calls)).toEqual(['a', 'bb'])
    }),
  ),
)

it.effect('stops after the second send fails and never retries a segment', () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const calls = yield* Ref.make<ReadonlyArray<string>>([])
      const expected = new HostSession.SendError({ cause: new Error('expected send failure') })
      const sendText: HostSession.SendText = (content) =>
        Ref.update(calls, (current) => [...current, content]).pipe(
          Effect.andThen(content === 'bb' ? Effect.fail(expected) : Effect.succeed([content])),
        )

      const fiber = yield* MessageSending.send({
        kind: 'direct',
        messages: [message('a'), message('bb'), message('ccc'), message('dddd')],
        sendText,
      }).pipe(Effect.flip, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* TestClock.adjust(Duration.millis(42))
      expect(yield* Ref.get(calls)).toEqual([])
      yield* TestClock.adjust(Duration.millis(1))
      expect(yield* Ref.get(calls)).toEqual(['a'])
      yield* TestClock.adjust(Duration.millis(73))
      expect(yield* Ref.get(calls)).toEqual(['a'])
      yield* TestClock.adjust(Duration.millis(1))

      expect(yield* Fiber.join(fiber)).toBe(expected)
      yield* TestClock.adjust(Duration.minutes(1))
      expect(yield* Ref.get(calls)).toEqual(['a', 'bb'])
    }),
  ),
)

it.effect('does not call the sender when there are no message segments', () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    const sendText: HostSession.SendText = () =>
      Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(Effect.succeed([])))

    expect(yield* MessageSending.send({ kind: 'initiative', messages: [], sendText })).toEqual({
      sentSegments: 0,
      artificialWaitMs: 0,
    })
    expect(yield* Ref.get(calls)).toBe(0)
  }),
)
