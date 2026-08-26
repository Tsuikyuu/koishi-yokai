import { expect, it } from '@effect/vitest'
import { DateTime, Duration, Effect, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { CallBudget } from '../../src/index'

const limits = (
  reserved: { readonly minute: number; readonly day: number },
  normal: { readonly minute: number; readonly day: number },
  background: { readonly minute: number; readonly day: number },
): CallBudget.ClassifiedLimits => CallBudget.ClassifiedLimits.make({ reserved, normal, background })

const options = (
  classifiedLimits: CallBudget.ClassifiedLimits,
  timeZone = 'UTC',
): CallBudget.Options => ({
  limits: classifiedLimits,
  timeZone: DateTime.zoneMakeNamedUnsafe(timeZone),
})

it.effect('atomically reserves, commits, and releases quota', () =>
  Effect.gen(function* () {
    const budget = yield* CallBudget.Service
    const first = yield* budget.reserve('normal')
    const second = yield* budget.reserve('normal')

    const pending = yield* budget.snapshot()
    expect(pending.minute.usage.normal.pending).toBe(2)
    expect(pending.minute.usage.normal.committed).toBe(0)
    expect(pending.minute.usage.normal.remaining).toBe(0)
    expect(pending.day.usage.normal.pending).toBe(2)

    const exhausted = yield* budget.reserve('normal').pipe(Effect.flip)
    expect(exhausted._tag).toBe('CallBudgetExceededError')
    expect(exhausted.category).toBe('normal')
    expect(exhausted.window).toBe('minute')
    expect(exhausted.used).toBe(2)
    expect(exhausted.limit).toBe(2)

    expect(yield* budget.commit(first.id)).toBe(true)
    expect(yield* budget.release(second.id)).toBe(true)
    expect(yield* budget.commit(first.id)).toBe(false)
    expect(yield* budget.release(second.id)).toBe(false)

    const settled = yield* budget.snapshot()
    expect(settled.minute.usage.normal.pending).toBe(0)
    expect(settled.minute.usage.normal.committed).toBe(1)
    expect(settled.minute.usage.normal.remaining).toBe(1)
    expect(settled.day.usage.normal.committed).toBe(1)
  }).pipe(
    Effect.provide(
      CallBudget.layer(
        options(limits({ minute: 2, day: 4 }, { minute: 2, day: 4 }, { minute: 2, day: 4 })),
      ),
    ),
  ),
)

it.effect('never over-reserves during concurrent contention', () =>
  Effect.gen(function* () {
    const budget = yield* CallBudget.Service
    const outcomes = yield* Effect.all(
      Array.from({ length: 64 }, () => budget.reserve('normal').pipe(Effect.result)),
      { concurrency: 'unbounded' },
    )

    expect(outcomes.filter(Result.isSuccess)).toHaveLength(8)
    expect(outcomes.filter(Result.isFailure)).toHaveLength(56)

    const snapshot = yield* budget.snapshot()
    expect(snapshot.minute.usage.normal.pending).toBe(8)
    expect(snapshot.minute.usage.normal.remaining).toBe(0)
    expect(snapshot.day.usage.normal.pending).toBe(8)
  }).pipe(
    Effect.provide(
      CallBudget.layer(
        options(limits({ minute: 8, day: 8 }, { minute: 8, day: 8 }, { minute: 8, day: 8 })),
      ),
    ),
  ),
)

it.effect('releases pre-dispatch failures and commits post-dispatch failures', () =>
  Effect.gen(function* () {
    const budget = yield* CallBudget.Service
    const preDispatch = yield* budget.reserve('normal')
    expect(yield* budget.fail(preDispatch.id, 'before-dispatch')).toBe(true)

    const postDispatch = yield* budget.reserve('normal')
    expect(yield* budget.fail(postDispatch.id, 'after-dispatch')).toBe(true)
    expect(yield* budget.fail(postDispatch.id, 'after-dispatch')).toBe(false)
    const chargedFailure = yield* budget.reserve('normal').pipe(Effect.flip)
    expect(chargedFailure.window).toBe('minute')

    const snapshot = yield* budget.snapshot()
    expect(snapshot.minute.usage.normal.pending).toBe(0)
    expect(snapshot.minute.usage.normal.committed).toBe(1)
    expect(snapshot.day.usage.normal.committed).toBe(1)
  }).pipe(
    Effect.provide(
      CallBudget.layer(
        options(limits({ minute: 1, day: 1 }, { minute: 1, day: 1 }, { minute: 1, day: 1 })),
      ),
    ),
  ),
)

it.effect('opens a new minute window without resetting the current day', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse('2026-08-26T12:00:00.000Z'))
    yield* Effect.gen(function* () {
      const budget = yield* CallBudget.Service
      const first = yield* budget.reserve('normal')
      yield* budget.commit(first.id)

      const minuteFailure = yield* budget.reserve('normal').pipe(Effect.flip)
      expect(minuteFailure.window).toBe('minute')

      yield* TestClock.adjust(Duration.minutes(1))
      const second = yield* budget.reserve('normal')
      yield* budget.commit(second.id)

      yield* TestClock.adjust(Duration.minutes(1))
      const dayFailure = yield* budget.reserve('normal').pipe(Effect.flip)
      expect(dayFailure.window).toBe('day')

      const snapshot = yield* budget.snapshot()
      expect(snapshot.minute.usage.normal.committed).toBe(0)
      expect(snapshot.minute.usage.normal.remaining).toBe(1)
      expect(snapshot.day.usage.normal.committed).toBe(2)
    }).pipe(
      Effect.provide(
        CallBudget.layer(
          options(limits({ minute: 1, day: 2 }, { minute: 1, day: 2 }, { minute: 1, day: 2 })),
        ),
      ),
    )
  }),
)

it.effect('turns the day window at midnight in the configured time zone', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse('2026-08-26T15:59:59.500Z'))
    yield* Effect.gen(function* () {
      const budget = yield* CallBudget.Service
      const beforeMidnight = yield* budget.reserve('normal')
      yield* budget.commit(beforeMidnight.id)

      const firstDay = yield* budget.snapshot()
      expect(firstDay.day.localDate).toBe('2026-08-26')

      yield* TestClock.adjust(Duration.millis(500))
      const afterMidnight = yield* budget.reserve('normal')
      yield* budget.commit(afterMidnight.id)

      const secondDay = yield* budget.snapshot()
      expect(secondDay.day.localDate).toBe('2026-08-27')
      expect(secondDay.day.usage.normal.committed).toBe(1)
    }).pipe(
      Effect.provide(
        CallBudget.layer(
          options(
            limits({ minute: 2, day: 1 }, { minute: 2, day: 1 }, { minute: 2, day: 1 }),
            'Asia/Shanghai',
          ),
        ),
      ),
    )
  }),
)

it.effect('settles a reservation only against the windows where it was admitted', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse('2026-08-26T12:00:59.500Z'))
    yield* Effect.gen(function* () {
      const budget = yield* CallBudget.Service
      const previousMinute = yield* budget.reserve('normal')

      yield* TestClock.adjust(Duration.millis(500))
      const currentMinute = yield* budget.reserve('normal')
      expect(yield* budget.commit(previousMinute.id)).toBe(true)

      const snapshot = yield* budget.snapshot()
      expect(snapshot.minute.usage.normal.pending).toBe(1)
      expect(snapshot.minute.usage.normal.committed).toBe(0)
      expect(snapshot.day.usage.normal.pending).toBe(1)
      expect(snapshot.day.usage.normal.committed).toBe(1)

      expect(yield* budget.release(currentMinute.id)).toBe(true)
      const released = yield* budget.snapshot()
      expect(released.minute.usage.normal.pending).toBe(0)
      expect(released.day.usage.normal.pending).toBe(0)
      expect(released.day.usage.normal.committed).toBe(1)
    }).pipe(
      Effect.provide(
        CallBudget.layer(
          options(limits({ minute: 1, day: 3 }, { minute: 1, day: 3 }, { minute: 1, day: 3 })),
        ),
      ),
    )
  }),
)

it.effect('keeps reserved and background capacity isolated from normal exhaustion', () =>
  Effect.gen(function* () {
    const budget = yield* CallBudget.Service
    const normal = yield* budget.reserve('normal')
    yield* budget.commit(normal.id)

    const normalFailure = yield* budget.reserve('normal').pipe(Effect.flip)
    expect(normalFailure.category).toBe('normal')

    const reserved = yield* budget.reserve('reserved')
    const background = yield* budget.reserve('background')
    yield* budget.commit(reserved.id)
    yield* budget.commit(background.id)

    const snapshot = yield* budget.snapshot()
    expect(snapshot.minute.usage.normal.committed).toBe(1)
    expect(snapshot.minute.usage.reserved.committed).toBe(1)
    expect(snapshot.minute.usage.background.committed).toBe(1)
  }).pipe(
    Effect.provide(
      CallBudget.layer(
        options(limits({ minute: 1, day: 1 }, { minute: 1, day: 1 }, { minute: 1, day: 1 })),
      ),
    ),
  ),
)
