import { expect, it } from '@effect/vitest'
import { MessageArchiveEvent } from '@yokai-internal/memory'
import { Deferred, Duration, Effect, Layer, Option, Queue, Ref } from 'effect'
import { TestClock } from 'effect/testing'

import { ScheduledDelivery } from '../../src/schedule/delivery'
import { ScheduledTaskModel } from '../../src/schedule/model'
import { ScheduledTask } from '../../src/schedule/scheduled-task'
import { ScheduledTaskWorker } from '../../src/schedule/worker'
import { WakeProposal } from '../../src/wake/proposal'

const task = (
  idCharacter: string,
  dueAt: number,
  repeatEveryMs?: number,
): ScheduledTaskModel.Task =>
  ScheduledTaskModel.Task.make({
    instanceId: MessageArchiveEvent.InstanceId.make('test'),
    platform: MessageArchiveEvent.PlatformId.make('test'),
    guildId: MessageArchiveEvent.GuildId.make('guild'),
    channelId: MessageArchiveEvent.ChannelId.make('channel'),
    scheduleId: ScheduledTaskModel.ScheduleId.make(`schedule_${idCharacter.repeat(32)}`),
    dedupeKey: ScheduledTaskModel.DedupeKey.make(`dedupe-${idCharacter}`),
    creationFingerprint: ScheduledTaskModel.CreationFingerprint.make(idCharacter.repeat(64)),
    createdMessageId: MessageArchiveEvent.MessageId.make(`message-${idCharacter}`),
    creatorId: MessageArchiveEvent.ActorId.make('user'),
    selfId: MessageArchiveEvent.ActorId.make('bot'),
    reason: ScheduledTaskModel.Reason.make(`Run task ${idCharacter}`),
    dueAt: ScheduledTaskModel.EpochMilliseconds.make(dueAt),
    repeatEveryMs:
      repeatEveryMs === undefined
        ? Option.none()
        : Option.some(ScheduledTaskModel.RepeatEveryMilliseconds.make(repeatEveryMs)),
    timeZone: ScheduledTaskModel.TimeZoneId.make('UTC'),
    status: 'pending',
    occurrence: ScheduledTaskModel.Occurrence.make(0),
    revision: ScheduledTaskModel.Revision.make(1),
    createdAt: ScheduledTaskModel.EpochMilliseconds.make(0),
    updatedAt: ScheduledTaskModel.EpochMilliseconds.make(0),
    lastTriggeredAt: Option.none(),
  })

const nearest = (
  tasks: ReadonlyArray<ScheduledTaskModel.Task>,
  excludedScheduleIds: ReadonlyArray<ScheduledTaskModel.ScheduleId> = [],
): Option.Option<ScheduledTaskModel.Task> =>
  Option.fromUndefinedOr(
    [
      ...tasks.filter(
        (candidate) =>
          candidate.status === 'pending' && !excludedScheduleIds.includes(candidate.scheduleId),
      ),
    ].sort(
      (left, right) => left.dueAt - right.dueAt || left.scheduleId.localeCompare(right.scheduleId),
    )[0],
  )

const sameExpected = (
  current: ScheduledTaskModel.Task,
  expected: ScheduledTaskModel.Task,
): boolean =>
  current.scheduleId === expected.scheduleId &&
  current.status === 'pending' &&
  current.revision === expected.revision &&
  current.occurrence === expected.occurrence &&
  current.dueAt === expected.dueAt

const replace = (
  tasks: ReadonlyArray<ScheduledTaskModel.Task>,
  expected: ScheduledTaskModel.Task,
  replacement: ScheduledTaskModel.Task,
): ReadonlyArray<ScheduledTaskModel.Task> =>
  tasks.map((candidate) => (candidate.scheduleId === expected.scheduleId ? replacement : candidate))

interface HarnessOptions {
  readonly duplicateInitialReads?: number
  readonly initiallyAvailable?: boolean
  readonly isAvailable?: (task: ScheduledTaskModel.Task) => Effect.Effect<boolean>
  readonly dispatch?: (
    request: ScheduledDelivery.Request,
  ) => Effect.Effect<void, ScheduledDelivery.DispatchError>
}

const makeHarness = (
  initial: ReadonlyArray<ScheduledTaskModel.Task>,
  options: HarnessOptions = {},
) =>
  Effect.gen(function* () {
    const tasks = yield* Ref.make(initial)
    const changes = yield* Queue.unbounded<void>()
    const nextEvents = yield* Queue.unbounded<Option.Option<ScheduledTaskModel.Task>>()
    const claimEvents = yield* Queue.unbounded<boolean>()
    const requests = yield* Queue.unbounded<ScheduledDelivery.Request>()
    const recorded = yield* Ref.make<ReadonlyArray<ScheduledDelivery.Request>>([])
    const expired = yield* Ref.make<ReadonlyArray<ScheduledTaskModel.ScheduleId>>([])
    const expiredEvents = yield* Queue.unbounded<ScheduledTaskModel.ScheduleId>()
    const waitStarted = yield* Deferred.make<void>()
    const waitInterrupted = yield* Deferred.make<void>()
    const availabilityEvents = yield* Queue.unbounded<boolean>()
    const available = yield* Ref.make(
      options.initiallyAvailable === undefined ? true : options.initiallyAvailable,
    )
    const staleReads = yield* Ref.make(
      options.duplicateInitialReads === undefined ? 0 : options.duplicateInitialReads,
    )
    const initialNearest = nearest(initial)
    const dispatch =
      options.dispatch === undefined
        ? (_request: ScheduledDelivery.Request) => Effect.void
        : options.dispatch

    const next = Effect.fn('ScheduledTaskWorkerTest.next')(function* (
      excludedScheduleIds: ReadonlyArray<ScheduledTaskModel.ScheduleId> = [],
    ) {
      const stale = yield* Ref.modify(
        staleReads,
        (remaining): [Option.Option<ScheduledTaskModel.Task>, number] =>
          remaining > 0 ? [initialNearest, remaining - 1] : [Option.none(), remaining],
      )
      const result =
        Option.isSome(stale) && !excludedScheduleIds.includes(stale.value.scheduleId)
          ? stale
          : nearest(yield* Ref.get(tasks), excludedScheduleIds)
      yield* Queue.offer(nextEvents, result)
      return result
    })

    const claim = Effect.fn('ScheduledTaskWorkerTest.claim')(function* (
      expected: ScheduledTaskModel.Task,
      claimedAt: ScheduledTaskModel.EpochMilliseconds,
    ) {
      const claimed = yield* Ref.modify(
        tasks,
        (
          current,
        ): [Option.Option<ScheduledTaskModel.Task>, ReadonlyArray<ScheduledTaskModel.Task>] => {
          const stored = current.find((candidate) => sameExpected(candidate, expected))
          if (stored === undefined) return [Option.none(), current]

          const revision = ScheduledTaskModel.Revision.make(stored.revision + 1)
          if (Option.isNone(stored.repeatEveryMs)) {
            const occurrence = ScheduledTaskModel.Task.make({
              ...stored,
              status: 'triggered',
              revision,
              updatedAt: claimedAt,
              lastTriggeredAt: Option.some(claimedAt),
            })
            return [Option.some(occurrence), replace(current, stored, occurrence)]
          }

          const skipped = Math.floor(
            Math.max(0, claimedAt - stored.dueAt) / stored.repeatEveryMs.value,
          )
          const occurrenceNumber = stored.occurrence + skipped
          const occurrenceDueAt = stored.dueAt + skipped * stored.repeatEveryMs.value
          const occurrence = ScheduledTaskModel.Task.make({
            ...stored,
            status: 'triggered',
            dueAt: ScheduledTaskModel.EpochMilliseconds.make(occurrenceDueAt),
            occurrence: ScheduledTaskModel.Occurrence.make(occurrenceNumber),
            revision,
            updatedAt: claimedAt,
            lastTriggeredAt: Option.some(claimedAt),
          })
          const pending = ScheduledTaskModel.Task.make({
            ...occurrence,
            status: 'pending',
            dueAt: ScheduledTaskModel.EpochMilliseconds.make(
              occurrenceDueAt + stored.repeatEveryMs.value,
            ),
            occurrence: ScheduledTaskModel.Occurrence.make(occurrenceNumber + 1),
          })
          return [Option.some(occurrence), replace(current, stored, pending)]
        },
      )
      yield* Queue.offer(claimEvents, Option.isSome(claimed))
      return claimed
    })

    const expire = Effect.fn('ScheduledTaskWorkerTest.expire')(function* (
      expected: ScheduledTaskModel.Task,
      expiredAt: ScheduledTaskModel.EpochMilliseconds,
    ) {
      const didExpire = yield* Ref.modify(
        tasks,
        (current): [boolean, ReadonlyArray<ScheduledTaskModel.Task>] => {
          const stored = current.find((candidate) => sameExpected(candidate, expected))
          if (stored === undefined) return [false, current]
          const revision = ScheduledTaskModel.Revision.make(stored.revision + 1)
          if (Option.isNone(stored.repeatEveryMs)) {
            const replacement = ScheduledTaskModel.Task.make({
              ...stored,
              status: 'expired',
              revision,
              updatedAt: expiredAt,
            })
            return [true, replace(current, stored, replacement)]
          }

          const skipped =
            Math.floor(Math.max(0, expiredAt - stored.dueAt) / stored.repeatEveryMs.value) + 1
          const replacement = ScheduledTaskModel.Task.make({
            ...stored,
            dueAt: ScheduledTaskModel.EpochMilliseconds.make(
              stored.dueAt + skipped * stored.repeatEveryMs.value,
            ),
            occurrence: ScheduledTaskModel.Occurrence.make(stored.occurrence + skipped),
            revision,
            updatedAt: expiredAt,
          })
          return [true, replace(current, stored, replacement)]
        },
      )
      if (didExpire) {
        yield* Ref.update(expired, (current) => [...current, expected.scheduleId])
        yield* Queue.offer(expiredEvents, expected.scheduleId)
      }
      return didExpire
    })

    const taskService = ScheduledTask.Service.of({
      create: () => Effect.die('ScheduledTask.create is not used by worker tests'),
      get: () => Effect.die('ScheduledTask.get is not used by worker tests'),
      update: () => Effect.die('ScheduledTask.update is not used by worker tests'),
      cancel: () => Effect.die('ScheduledTask.cancel is not used by worker tests'),
      related: () => Effect.die('ScheduledTask.related is not used by worker tests'),
      query: () => Effect.die('ScheduledTask.query is not used by worker tests'),
      next,
      waitForChange: () =>
        Deferred.succeed(waitStarted, undefined).pipe(
          Effect.andThen(Queue.take(changes)),
          Effect.onInterrupt(() => Deferred.succeed(waitInterrupted, undefined)),
        ),
      claim,
      expire,
    })
    const deliveryService = ScheduledDelivery.Service.of({
      isAvailable: (candidate) =>
        (options.isAvailable === undefined
          ? Ref.get(available)
          : options.isAvailable(candidate)
        ).pipe(Effect.tap((current) => Queue.offer(availabilityEvents, current))),
      dispatch: (request) =>
        Ref.update(recorded, (current) => [...current, request]).pipe(
          Effect.andThen(Queue.offer(requests, request)),
          Effect.andThen(dispatch(request)),
          Effect.asVoid,
        ),
    })
    const dependencies = Layer.merge(
      Layer.succeed(ScheduledTask.Service, taskService),
      Layer.succeed(ScheduledDelivery.Service, deliveryService),
    )

    return {
      dependencies,
      requests,
      recorded,
      expired,
      expiredEvents,
      nextEvents,
      claimEvents,
      waitStarted,
      waitInterrupted,
      availabilityEvents,
      allTasks: () => Ref.get(tasks),
      setAvailable: (value: boolean) => Ref.set(available, value),
      insert: (inserted: ScheduledTaskModel.Task) =>
        Ref.update(tasks, (current) => [...current, inserted]).pipe(
          Effect.andThen(Queue.offer(changes, undefined)),
          Effect.asVoid,
        ),
    }
  })

const workerOptions = (
  gracePeriodMs = 1_000,
  storageRetryDelayMs = 1,
): ScheduledTaskWorker.Options => ({
  gracePeriodMs: WakeProposal.DurationMilliseconds.make(gracePeriodMs),
  storageRetryDelayMs: WakeProposal.DurationMilliseconds.make(storageRetryDelayMs),
  storageRetryAttempts: 0,
})

const workerLayer = (
  harness: Effect.Success<ReturnType<typeof makeHarness>>,
  gracePeriodMs = 1_000,
  storageRetryDelayMs = 1,
) =>
  ScheduledTaskWorker.layer(workerOptions(gracePeriodMs, storageRetryDelayMs)).pipe(
    Layer.provide(harness.dependencies),
  )

it.effect('sleeps until the nearest task and does not deliver a later task first', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const early = task('a', 1_000)
    const late = task('b', 2_000)
    const harness = yield* makeHarness([late, early])

    yield* Effect.gen(function* () {
      const observed = yield* Queue.take(harness.nextEvents)
      expect(Option.isSome(observed) && observed.value.scheduleId === early.scheduleId).toBe(true)

      yield* TestClock.adjust(Duration.millis(999))
      expect(yield* Ref.get(harness.recorded)).toHaveLength(0)

      yield* TestClock.adjust(Duration.millis(1))
      const request = yield* Queue.take(harness.requests)
      expect(request.task.scheduleId).toBe(early.scheduleId)
      expect(yield* Ref.get(harness.recorded)).toHaveLength(1)
    }).pipe(Effect.provide(workerLayer(harness)))
  }),
)

it.effect('requeries when an earlier insert invalidates the current sleep', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const later = task('b', 2_000)
    const earlier = task('a', 500)
    const harness = yield* makeHarness([later])

    yield* Effect.gen(function* () {
      yield* Queue.take(harness.nextEvents)
      yield* harness.insert(earlier)
      const requeried = yield* Queue.take(harness.nextEvents)
      expect(Option.isSome(requeried) && requeried.value.scheduleId === earlier.scheduleId).toBe(
        true,
      )

      yield* TestClock.adjust(Duration.millis(499))
      expect(yield* Ref.get(harness.recorded)).toHaveLength(0)
      yield* TestClock.adjust(Duration.millis(1))
      expect((yield* Queue.take(harness.requests)).task.scheduleId).toBe(earlier.scheduleId)
    }).pipe(Effect.provide(workerLayer(harness)))
  }),
)

it.effect('expires beyond grace but claims the inclusive grace boundary', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(10_000)
    const tooLate = task('a', 8_999)
    const atBoundary = task('b', 9_000)
    const harness = yield* makeHarness([atBoundary, tooLate])

    yield* Effect.gen(function* () {
      const request = yield* Queue.take(harness.requests)
      expect(request.task.scheduleId).toBe(atBoundary.scheduleId)
      expect(yield* Ref.get(harness.expired)).toEqual([tooLate.scheduleId])

      const stored = yield* harness.allTasks()
      const expiredTask = stored.find((candidate) => candidate.scheduleId === tooLate.scheduleId)
      expect(expiredTask === undefined ? undefined : expiredTask.status).toBe('expired')
    }).pipe(Effect.provide(workerLayer(harness)))
  }),
)

it.effect('dispatches an occurrence once when the same pending snapshot is read twice', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const due = task('a', 0)
    const harness = yield* makeHarness([due], { duplicateInitialReads: 2 })

    yield* Effect.gen(function* () {
      expect(yield* Queue.take(harness.claimEvents)).toBe(true)
      expect(yield* Queue.take(harness.claimEvents)).toBe(false)
      yield* Effect.yieldNow
      expect(yield* Ref.get(harness.recorded)).toHaveLength(1)
    }).pipe(Effect.provide(workerLayer(harness)))
  }),
)

it.effect('keeps an unavailable bot task pending and claims it once after availability', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const due = task('a', 0)
    const harness = yield* makeHarness([due], { initiallyAvailable: false })

    yield* Effect.gen(function* () {
      expect(yield* Queue.take(harness.availabilityEvents)).toBe(false)
      expect(yield* Ref.get(harness.recorded)).toHaveLength(0)
      expect((yield* harness.allTasks())[0]).toMatchObject({
        scheduleId: due.scheduleId,
        status: 'pending',
        occurrence: 0,
      })

      yield* harness.setAvailable(true)
      yield* TestClock.adjust(Duration.millis(1))
      expect(yield* Queue.take(harness.availabilityEvents)).toBe(true)
      expect((yield* Queue.take(harness.requests)).task.scheduleId).toBe(due.scheduleId)
      expect(yield* Queue.take(harness.claimEvents)).toBe(true)
      yield* Effect.yieldNow

      expect(yield* Ref.get(harness.recorded)).toHaveLength(1)
      expect((yield* harness.allTasks())[0]).toMatchObject({
        scheduleId: due.scheduleId,
        status: 'triggered',
        occurrence: 0,
      })
    }).pipe(Effect.provide(workerLayer(harness)))
  }),
)

it.effect('rechecks grace with a fresh clock after availability resolution', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(999)
    const availabilityStarted = yield* Deferred.make<void>()
    const due = task('a', 0)
    const harness = yield* makeHarness([due], {
      isAvailable: () =>
        Deferred.succeed(availabilityStarted, undefined).pipe(
          Effect.andThen(Effect.sleep(Duration.millis(100))),
          Effect.as(true),
        ),
    })

    yield* Effect.gen(function* () {
      yield* Deferred.await(availabilityStarted)
      yield* TestClock.adjust(Duration.millis(100))
      expect(yield* Queue.take(harness.expiredEvents)).toBe(due.scheduleId)
      expect((yield* harness.allTasks())[0]).toMatchObject({ status: 'expired', revision: 2 })
      expect(yield* Queue.size(harness.requests)).toBe(0)
    }).pipe(Effect.provide(workerLayer(harness, 1_000)))
  }),
)

it.effect('rechecks an unavailable task at its grace deadline before a longer retry delay', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const due = task('a', 0)
    const harness = yield* makeHarness([due], { initiallyAvailable: false })

    yield* Effect.gen(function* () {
      expect(yield* Queue.take(harness.availabilityEvents)).toBe(false)
      yield* Effect.yieldNow
      yield* TestClock.adjust(Duration.millis(100))
      yield* harness.setAvailable(true)
      yield* TestClock.adjust(Duration.millis(400))

      expect(yield* Queue.take(harness.availabilityEvents)).toBe(true)
      expect((yield* Queue.take(harness.requests)).task.scheduleId).toBe(due.scheduleId)
      expect((yield* harness.allTasks())[0]).toMatchObject({ status: 'triggered', revision: 2 })
    }).pipe(Effect.provide(workerLayer(harness, 500, 1_000)))
  }),
)

it.effect('skips an unavailable earliest target without starving a later ready target', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const unavailable = task('a', 0)
    const ready = task('b', 0)
    const harness = yield* makeHarness([unavailable, ready], {
      isAvailable: (candidate) => Effect.succeed(candidate.scheduleId === ready.scheduleId),
    })

    yield* Effect.gen(function* () {
      const request = yield* Queue.take(harness.requests)
      expect(request.task.scheduleId).toBe(ready.scheduleId)

      const stored = yield* harness.allTasks()
      expect(
        stored.find((candidate) => candidate.scheduleId === unavailable.scheduleId),
      ).toMatchObject({ status: 'pending', revision: 1 })
      expect(stored.find((candidate) => candidate.scheduleId === ready.scheduleId)).toMatchObject({
        status: 'triggered',
        revision: 2,
      })
    }).pipe(Effect.provide(workerLayer(harness)))
  }),
)

it.effect('expires unavailable one-shot and repeat tasks after grace without claiming them', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(2_500)
    const oneShot = task('a', 0)
    const repeating = task('b', 0, 1_000)
    const harness = yield* makeHarness([oneShot, repeating], { initiallyAvailable: false })

    yield* Effect.gen(function* () {
      expect(yield* Queue.take(harness.expiredEvents)).toBe(oneShot.scheduleId)
      expect(yield* Queue.take(harness.expiredEvents)).toBe(repeating.scheduleId)

      const stored = yield* harness.allTasks()
      expect(stored.find((candidate) => candidate.scheduleId === oneShot.scheduleId)).toMatchObject(
        { status: 'expired', revision: 2 },
      )
      expect(
        stored.find((candidate) => candidate.scheduleId === repeating.scheduleId),
      ).toMatchObject({ status: 'pending', occurrence: 3, dueAt: 3_000, revision: 2 })
      expect(yield* Ref.get(harness.recorded)).toHaveLength(0)
      expect(yield* Queue.size(harness.availabilityEvents)).toBe(0)
    }).pipe(Effect.provide(workerLayer(harness, 400)))
  }),
)

it.effect('starts the next due delivery while an earlier delivery is still blocked', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const firstStarted = yield* Deferred.make<void>()
    const secondStarted = yield* Deferred.make<void>()
    const first = task('a', 0)
    const second = task('b', 0)
    const harness = yield* makeHarness([second, first], {
      dispatch: (request) =>
        request.task.scheduleId === first.scheduleId
          ? Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Effect.never))
          : Deferred.succeed(secondStarted, undefined),
    })

    yield* Effect.gen(function* () {
      yield* Deferred.await(firstStarted)
      yield* Deferred.await(secondStarted)
      expect(yield* Ref.get(harness.recorded)).toHaveLength(2)
    }).pipe(Effect.provide(workerLayer(harness)))
  }),
)

it.effect('recovers only the latest due repeat occurrence and advances storage to the future', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(10_500)
    const repeating = task('a', 1_000, 1_000)
    const harness = yield* makeHarness([repeating])

    yield* Effect.gen(function* () {
      const request = yield* Queue.take(harness.requests)
      expect(request.task).toMatchObject({
        scheduleId: repeating.scheduleId,
        occurrence: 9,
        dueAt: 10_000,
        status: 'triggered',
      })
      expect(request.proposal.focus.timestamp).toBe(10_000)
      expect(request.proposal.mergeKey).toContain(':9')

      const stored = (yield* harness.allTasks()).find(
        (candidate) => candidate.scheduleId === repeating.scheduleId,
      )
      expect(stored).toMatchObject({ status: 'pending', occurrence: 10, dueAt: 11_000 })
      expect(stored === undefined ? 0 : stored.dueAt).toBeGreaterThan(10_500)
      expect(yield* Ref.get(harness.expired)).toHaveLength(0)
    }).pipe(Effect.provide(workerLayer(harness, 600)))
  }),
)

it.effect('interrupts both the active timer and in-flight delivery when its Layer closes', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const deliveryStarted = yield* Deferred.make<void>()
    const deliveryInterrupted = yield* Deferred.make<void>()
    const due = task('a', 0)
    const future = task('b', 60_000)
    const harness = yield* makeHarness([future, due], {
      dispatch: () =>
        Deferred.succeed(deliveryStarted, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(deliveryInterrupted, undefined)),
        ),
    })

    yield* Effect.gen(function* () {
      yield* Deferred.await(deliveryStarted)
      yield* Deferred.await(harness.waitStarted)
    }).pipe(Effect.provide(workerLayer(harness)))

    expect(yield* Deferred.isDone(deliveryInterrupted)).toBe(true)
    expect(yield* Deferred.isDone(harness.waitInterrupted)).toBe(true)
    yield* TestClock.adjust(Duration.minutes(1))
    expect(yield* Ref.get(harness.recorded)).toHaveLength(1)
  }),
)
