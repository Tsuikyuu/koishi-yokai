import { expect, it } from '@effect/vitest'
import { Effect, Layer, Option } from 'effect'
import { TestClock } from 'effect/testing'

import { MessageArchiveEvent } from '@yokai-internal/memory'
import { ScheduledTask, ScheduledTaskModel } from '../../src/index'
import {
  CREATOR_ID,
  INSTANCE_ID,
  MISSING_SOURCE_ID,
  OTHER_INSTANCE_SCOPE,
  SCOPE,
  SELF_ID,
  TestStorage,
  archiveLayer,
  createRequest,
  domainLayer,
  serviceLayer,
  storageLayer,
} from './fixtures'

const due = (value: number): ScheduledTaskModel.EpochMilliseconds =>
  ScheduledTaskModel.EpochMilliseconds.make(value)

const some = <A>(value: Option.Option<A>): A => Option.getOrThrow(value)

it.effect('locks creation to an archived source and replays one stable dedupe identity', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const schedules = yield* ScheduledTask.Service
    const storage = yield* TestStorage
    const request = createRequest('1970-01-01T00:00:10')

    const first = yield* schedules.create(request)
    expect(first.creatorId).toBe(CREATOR_ID)
    expect(first.selfId).toBe(SELF_ID)
    expect(first.createdMessageId).toBe(request.sourceMessageId)
    expect(first.dueAt).toBe(10_000)

    yield* TestClock.adjust(100)
    const replay = yield* schedules.create(request)
    expect(replay).toEqual(first)
    expect((yield* storage.all()).length).toBe(1)

    yield* TestClock.setTime(20_000)
    const replayAfterDue = yield* schedules.create(request)
    expect(replayAfterDue).toEqual(first)
    expect((yield* storage.all()).length).toBe(1)

    const newPastDue = yield* schedules
      .create(createRequest('1970-01-01T00:00:10', 'new-past-due'))
      .pipe(Effect.flip)
    expect(newPastDue._tag).toBe('ScheduledTaskDueTimeNotFutureError')

    const conflict = yield* schedules
      .create(createRequest('1970-01-01T00:00:10', 'schedule-dedupe', 'Different payload'))
      .pipe(Effect.flip)
    expect(conflict._tag).toBe('ScheduledTaskDedupeConflictError')

    yield* schedules.waitForChange()
  }).pipe(Effect.provide(serviceLayer())),
)

it.effect('replays with the task creation zone after the configured IANA zone changes', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const request = createRequest('1970-01-02T00:00:00', 'zone-change-replay')
    const first = yield* Effect.gen(function* () {
      const schedules = yield* ScheduledTask.Service
      return yield* schedules.create(request)
    }).pipe(Effect.provide(domainLayer('UTC')))
    const replay = yield* Effect.gen(function* () {
      const schedules = yield* ScheduledTask.Service
      return yield* schedules.create(request)
    }).pipe(Effect.provide(domainLayer('Asia/Shanghai')))
    const storage = yield* TestStorage

    expect(first.timeZone).toBe('UTC')
    expect(replay).toEqual(first)
    expect((yield* storage.all()).length).toBe(1)
  }).pipe(Effect.provide(Layer.merge(storageLayer, archiveLayer))),
)

it.effect('rejects missing sources and foreign instance scopes before persistence', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const schedules = yield* ScheduledTask.Service
    const missing = yield* schedules
      .create(
        ScheduledTaskModel.CreateRequest.make({
          ...createRequest('1970-01-01T00:00:10'),
          sourceMessageId: MISSING_SOURCE_ID,
        }),
      )
      .pipe(Effect.flip)
    expect(missing._tag).toBe('ScheduledTaskSourceMessageNotFoundError')

    const foreign = yield* schedules
      .create(
        ScheduledTaskModel.CreateRequest.make({
          ...createRequest('1970-01-01T00:00:10'),
          scope: OTHER_INSTANCE_SCOPE,
        }),
      )
      .pipe(Effect.flip)
    expect(foreign._tag).toBe('ScheduledTaskInstanceScopeMismatchError')
  }).pipe(Effect.provide(serviceLayer())),
)

it.effect('claims a one-shot at most once with a durable triggered transition', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const schedules = yield* ScheduledTask.Service
    const storage = yield* TestStorage
    const pending = yield* schedules.create(createRequest('1970-01-01T00:00:01', 'one-shot'))

    const claimed = some(yield* schedules.claim(pending, due(1_000)))
    expect(claimed.status).toBe('triggered')
    expect(claimed.occurrence).toBe(0)
    expect(Option.getOrNull(claimed.lastTriggeredAt)).toBe(1_000)
    expect(Option.isNone(yield* schedules.claim(pending, due(1_000)))).toBe(true)

    const stored = some(yield* storage.get(ScheduledTaskModel.scopeOf(pending), pending.scheduleId))
    expect(stored.status).toBe('triggered')
    expect(stored.revision).toBe(2)
  }).pipe(Effect.provide(serviceLayer())),
)

it.effect('selects the next pending task while honoring bounded starvation exclusions', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const schedules = yield* ScheduledTask.Service
    const first = yield* schedules.create(createRequest('1970-01-01T00:00:10', 'next-first'))
    const second = yield* schedules.create(createRequest('1970-01-01T00:00:20', 'next-second'))

    expect(some(yield* schedules.next()).scheduleId).toBe(first.scheduleId)
    expect(some(yield* schedules.next([first.scheduleId])).scheduleId).toBe(second.scheduleId)
    expect(Option.isNone(yield* schedules.next([first.scheduleId, second.scheduleId]))).toBe(true)
  }).pipe(Effect.provide(serviceLayer())),
)

it.effect(
  'claims only the latest due repeat occurrence and advances strictly into the future',
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const schedules = yield* ScheduledTask.Service
      const storage = yield* TestStorage
      const repeat = Option.some(ScheduledTaskModel.RepeatEveryMilliseconds.make(1_000))
      const pending = yield* schedules.create(
        createRequest('1970-01-01T00:00:01', 'repeat-claim', 'Repeat', repeat),
      )

      expect(yield* ScheduledTask.latestDueAt(pending, due(4_500))).toBe(4_000)
      const occurrence = some(yield* schedules.claim(pending, due(4_500)))
      expect(occurrence.status).toBe('triggered')
      expect(occurrence.dueAt).toBe(4_000)
      expect(occurrence.occurrence).toBe(3)

      const advanced = some(yield* storage.get(SCOPE, pending.scheduleId))
      expect(advanced.status).toBe('pending')
      expect(advanced.dueAt).toBe(5_000)
      expect(advanced.occurrence).toBe(4)
      expect(advanced.dueAt).toBeGreaterThan(4_500)
    }).pipe(Effect.provide(serviceLayer())),
)

it.effect('expires missed one-shots and skips missed repeats without catch-up delivery', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const schedules = yield* ScheduledTask.Service
    const storage = yield* TestStorage
    const oneShot = yield* schedules.create(createRequest('1970-01-01T00:00:01', 'expire-one'))
    const repeating = yield* schedules.create(
      createRequest(
        '1970-01-01T00:00:01',
        'expire-repeat',
        'Repeat',
        Option.some(ScheduledTaskModel.RepeatEveryMilliseconds.make(1_000)),
      ),
    )

    expect(yield* schedules.expire(oneShot, due(4_500))).toBe(true)
    expect(yield* schedules.expire(repeating, due(4_500))).toBe(true)
    const expired = some(yield* storage.get(SCOPE, oneShot.scheduleId))
    const advanced = some(yield* storage.get(SCOPE, repeating.scheduleId))
    expect(expired.status).toBe('expired')
    expect(Option.isNone(expired.lastTriggeredAt)).toBe(true)
    expect(advanced.status).toBe('pending')
    expect(advanced.dueAt).toBe(5_000)
    expect(advanced.occurrence).toBe(4)
    expect(Option.isNone(advanced.lastTriggeredAt)).toBe(true)
  }).pipe(Effect.provide(serviceLayer())),
)

it.effect('updates by full replacement, scopes queries, and cancels pending tasks', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const schedules = yield* ScheduledTask.Service
    const task = yield* schedules.create(createRequest('1970-01-01T00:00:10', 'mutable'))

    yield* TestClock.setTime(1_000)
    const updated = yield* schedules.update(
      ScheduledTaskModel.UpdateRequest.make({
        scope: SCOPE,
        scheduleId: task.scheduleId,
        time: ScheduledTaskModel.TimeExpression.make('1970-01-01T00:00:20'),
        reason: ScheduledTaskModel.Reason.make('Replacement'),
        repeatEveryMs: Option.some(ScheduledTaskModel.RepeatEveryMilliseconds.make(60_000)),
      }),
    )
    expect(updated.reason).toBe('Replacement')
    expect(updated.dueAt).toBe(20_000)
    expect(Option.getOrNull(updated.repeatEveryMs)).toBe(60_000)
    expect(updated.revision).toBe(2)

    const related = yield* schedules.related(SCOPE, CREATOR_ID)
    expect(related.map((value) => value.scheduleId)).toEqual([task.scheduleId])

    const cancelled = yield* schedules.cancel(
      ScheduledTaskModel.CancelRequest.make({ scope: SCOPE, scheduleId: task.scheduleId }),
    )
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.revision).toBe(3)
    expect(yield* schedules.related(SCOPE, CREATOR_ID)).toEqual([])

    const foreignRead = yield* schedules
      .get(OTHER_INSTANCE_SCOPE, ScheduledTaskModel.ScheduleId.make(`schedule_${'0'.repeat(32)}`))
      .pipe(Effect.flip)
    expect(foreignRead._tag).toBe('ScheduledTaskInstanceScopeMismatchError')
    expect(INSTANCE_ID).not.toBe(MessageArchiveEvent.InstanceId.make('schedule-other'))
  }).pipe(Effect.provide(serviceLayer())),
)
