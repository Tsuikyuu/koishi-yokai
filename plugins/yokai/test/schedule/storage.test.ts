import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SQLiteDriver } from '@minatojs/driver-sqlite'
import { expect, it } from '@effect/vitest'
import { ScheduledTaskModel, ScheduledTaskStorage } from '@yokai-internal/core'
import { MessageArchiveEvent } from '@yokai-internal/memory'
import { Deferred, Effect, Fiber, Option } from 'effect'
import { Context } from 'koishi'
import { vi } from 'vitest'

vi.mock('koishi', () => import('@koishijs/core'))

import { YokaiScheduleModel } from '../../src/schedule/model'
import { YokaiScheduleRowCodec } from '../../src/schedule/row'
import { KoishiScheduledTaskStorage } from '../../src/schedule/storage'

const scope = (
  instanceId = 'schedule-test',
  platform = 'test',
  guildId = 'guild',
  channelId = 'channel',
): MessageArchiveEvent.ChannelScope =>
  MessageArchiveEvent.ChannelScope.make({
    instanceId: MessageArchiveEvent.InstanceId.make(instanceId),
    platform: MessageArchiveEvent.PlatformId.make(platform),
    guildId: MessageArchiveEvent.GuildId.make(guildId),
    channelId: MessageArchiveEvent.ChannelId.make(channelId),
  })

interface TaskOptions {
  readonly dueAt?: number
  readonly status?: ScheduledTaskModel.Status
  readonly creatorId?: string
  readonly fingerprintCharacter?: string
  readonly occurrence?: number
  readonly revision?: number
  readonly repeatEveryMs?: number | null
  readonly lastTriggeredAt?: number | null
}

const task = (
  channelScope: MessageArchiveEvent.ChannelScope,
  idCharacter: string,
  options: TaskOptions = {},
): ScheduledTaskModel.Task => {
  const repeatEveryMs = options.repeatEveryMs === undefined ? null : options.repeatEveryMs
  const lastTriggeredAt = options.lastTriggeredAt === undefined ? null : options.lastTriggeredAt
  return ScheduledTaskModel.Task.make({
    ...channelScope,
    scheduleId: ScheduledTaskModel.ScheduleId.make(`schedule_${idCharacter.repeat(32)}`),
    dedupeKey: ScheduledTaskModel.DedupeKey.make(`dedupe-${idCharacter}`),
    creationFingerprint: ScheduledTaskModel.CreationFingerprint.make(
      (options.fingerprintCharacter === undefined
        ? idCharacter
        : options.fingerprintCharacter
      ).repeat(64),
    ),
    createdMessageId: MessageArchiveEvent.MessageId.make(`message-${idCharacter}`),
    creatorId: MessageArchiveEvent.ActorId.make(
      options.creatorId === undefined ? 'user' : options.creatorId,
    ),
    selfId: MessageArchiveEvent.ActorId.make('bot'),
    reason: ScheduledTaskModel.Reason.make(`Reason ${idCharacter}`),
    dueAt: ScheduledTaskModel.EpochMilliseconds.make(
      options.dueAt === undefined ? 10_000 : options.dueAt,
    ),
    repeatEveryMs:
      repeatEveryMs === null
        ? Option.none()
        : Option.some(ScheduledTaskModel.RepeatEveryMilliseconds.make(repeatEveryMs)),
    timeZone: ScheduledTaskModel.TimeZoneId.make('Asia/Shanghai'),
    status: options.status === undefined ? 'pending' : options.status,
    occurrence: ScheduledTaskModel.Occurrence.make(
      options.occurrence === undefined ? 0 : options.occurrence,
    ),
    revision: ScheduledTaskModel.Revision.make(
      options.revision === undefined ? 1 : options.revision,
    ),
    createdAt: ScheduledTaskModel.EpochMilliseconds.make(1_000),
    updatedAt: ScheduledTaskModel.EpochMilliseconds.make(2_000),
    lastTriggeredAt:
      lastTriggeredAt === null
        ? Option.none()
        : Option.some(ScheduledTaskModel.EpochMilliseconds.make(lastTriggeredAt)),
  })
}

const query = (
  channelScope: MessageArchiveEvent.ChannelScope,
  options: {
    readonly statuses?: ReadonlyArray<ScheduledTaskModel.Status>
    readonly creatorId?: string | null
    readonly dueFrom?: number | null
    readonly dueUntil?: number | null
    readonly limit?: number
  } = {},
): ScheduledTaskModel.QueryRequest => {
  const creatorId = options.creatorId === undefined ? null : options.creatorId
  const dueFrom = options.dueFrom === undefined ? null : options.dueFrom
  const dueUntil = options.dueUntil === undefined ? null : options.dueUntil
  return ScheduledTaskModel.QueryRequest.make({
    scope: channelScope,
    statuses: options.statuses === undefined ? ['pending'] : options.statuses,
    creatorId:
      creatorId === null ? Option.none() : Option.some(MessageArchiveEvent.ActorId.make(creatorId)),
    dueFrom:
      dueFrom === null
        ? Option.none()
        : Option.some(ScheduledTaskModel.EpochMilliseconds.make(dueFrom)),
    dueUntil:
      dueUntil === null
        ? Option.none()
        : Option.some(ScheduledTaskModel.EpochMilliseconds.make(dueUntil)),
    limit: ScheduledTaskModel.QueryLimit.make(options.limit === undefined ? 32 : options.limit),
  })
}

const databaseContext = (path: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const ctx = yield* Effect.sync(() => {
        const context = new Context()
        YokaiScheduleModel.define(context)
        context.plugin(SQLiteDriver, { path })
        return context
      })
      yield* Effect.promise(() => ctx.start())
      return ctx
    }),
    (ctx) => Effect.promise(() => ctx.stop()),
  )

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), 'yokai-schedule-'))),
  (directory) => Effect.tryPromise(() => rm(directory, { recursive: true, force: true })),
)

it.effect('deduplicates concurrent creates and distinguishes payload conflicts', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* databaseContext(':memory:')
      const expected = task(scope(), 'a')
      const conflict = ScheduledTaskModel.Task.make({
        ...expected,
        creationFingerprint: ScheduledTaskModel.CreationFingerprint.make('b'.repeat(64)),
        reason: ScheduledTaskModel.Reason.make('Conflicting payload'),
      })

      const results = yield* Effect.gen(function* () {
        const storage = yield* ScheduledTaskStorage.Service
        const concurrent = yield* Effect.all(
          Array.from({ length: 8 }, () => storage.create(expected)),
          { concurrency: 'unbounded' },
        )
        const conflicting = yield* storage.create(conflict)
        return { concurrent, conflicting }
      }).pipe(Effect.provide(KoishiScheduledTaskStorage.layer(ctx)))

      expect(results.concurrent.map((result) => result._tag).sort()).toEqual([
        'Replay',
        'Replay',
        'Replay',
        'Replay',
        'Replay',
        'Replay',
        'Replay',
        'Stored',
      ])
      expect(results.concurrent.map((result) => result.task)).toEqual(
        Array.from({ length: 8 }, () => expected),
      )
      expect(results.conflicting).toMatchObject({ _tag: 'Conflict', task: expected })
      expect(yield* Effect.promise(() => ctx.database.get('yokai_schedule', {}))).toHaveLength(1)
    }),
  ),
)

it.effect('isolates the complete scope and queries pending tasks in stable due-time order', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* databaseContext(':memory:')
      const primaryScope = scope()
      const primaryA = task(primaryScope, 'a', { dueAt: 3_000 })
      const primaryB = task(primaryScope, 'b', { dueAt: 1_000 })
      const primaryC = task(primaryScope, 'c', {
        dueAt: 1_000,
        creatorId: 'other-user',
      })
      const primaryD = task(primaryScope, 'd', { dueAt: 500, status: 'cancelled' })
      const primary = [primaryA, primaryB, primaryC, primaryD]
      const isolated = [
        scope('other-instance', 'test', 'guild', 'channel'),
        scope('schedule-test', 'other-platform', 'guild', 'channel'),
        scope('schedule-test', 'test', 'other-guild', 'channel'),
        scope('schedule-test', 'test', 'guild', 'other-channel'),
      ].map((channelScope) => task(channelScope, 'a', { dueAt: 9_000 }))

      const result = yield* Effect.gen(function* () {
        const storage = yield* ScheduledTaskStorage.Service
        yield* Effect.forEach([...primary, ...isolated], (entry) => storage.create(entry), {
          discard: true,
        })
        const loaded = yield* Effect.forEach(
          [primaryScope, ...isolated.map(ScheduledTaskModel.scopeOf)],
          (channelScope) => storage.get(channelScope, primaryA.scheduleId),
        )
        const pending = yield* storage.query(query(primaryScope))
        const bounded = yield* storage.query(
          query(primaryScope, { creatorId: 'user', dueFrom: 2_000, dueUntil: 3_000 }),
        )
        const allStatuses = yield* storage.query(
          query(primaryScope, { statuses: ['pending', 'cancelled'] }),
        )
        const next = yield* storage.next(primaryScope.instanceId, [])
        const nextAfterFirst = yield* storage.next(primaryScope.instanceId, [primaryB.scheduleId])
        const nextAfterAll = yield* storage.next(primaryScope.instanceId, [
          primaryA.scheduleId,
          primaryB.scheduleId,
          primaryC.scheduleId,
        ])
        return { loaded, pending, bounded, allStatuses, next, nextAfterFirst, nextAfterAll }
      }).pipe(Effect.provide(KoishiScheduledTaskStorage.layer(ctx)))

      expect(result.loaded.map(Option.getOrUndefined)).toEqual([primaryA, ...isolated])
      expect(result.pending.map((entry) => entry.scheduleId)).toEqual([
        primaryB.scheduleId,
        primaryC.scheduleId,
        primaryA.scheduleId,
      ])
      expect(result.bounded).toEqual([primaryA])
      expect(result.allStatuses.map((entry) => entry.scheduleId)).toEqual([
        primaryD.scheduleId,
        primaryB.scheduleId,
        primaryC.scheduleId,
        primaryA.scheduleId,
      ])
      expect(Option.getOrUndefined(result.next)).toEqual(primaryB)
      expect(Option.getOrUndefined(result.nextAfterFirst)).toEqual(primaryC)
      expect(Option.isNone(result.nextAfterAll)).toBe(true)
    }),
  ),
)

it.effect('compares the full identity and mutable revision state before replacing a task', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* databaseContext(':memory:')
      const channelScope = scope()
      const original = task(channelScope, 'a', { dueAt: 1_000 })
      const replacement = ScheduledTaskModel.Task.make({
        ...original,
        status: 'triggered',
        occurrence: ScheduledTaskModel.Occurrence.make(1),
        revision: ScheduledTaskModel.Revision.make(2),
        updatedAt: ScheduledTaskModel.EpochMilliseconds.make(3_000),
        lastTriggeredAt: Option.some(ScheduledTaskModel.EpochMilliseconds.make(1_000)),
      })
      const nextRevision = ScheduledTaskModel.Task.make({
        ...replacement,
        revision: ScheduledTaskModel.Revision.make(3),
      })
      const wrongDueAt = ScheduledTaskModel.Task.make({
        ...replacement,
        dueAt: ScheduledTaskModel.EpochMilliseconds.make(999),
      })
      const wrongOccurrence = ScheduledTaskModel.Task.make({
        ...replacement,
        occurrence: ScheduledTaskModel.Occurrence.make(0),
      })
      const wrongIdentity = task(scope('schedule-test', 'test', 'guild', 'other'), 'a')

      const result = yield* Effect.gen(function* () {
        const storage = yield* ScheduledTaskStorage.Service
        yield* storage.create(original)
        const replaced = yield* storage.compareAndSet(original, replacement)
        const stale = yield* storage.compareAndSet(original, nextRevision)
        const mismatchedDueAt = yield* storage.compareAndSet(wrongDueAt, nextRevision)
        const mismatchedOccurrence = yield* storage.compareAndSet(wrongOccurrence, nextRevision)
        const mismatchedIdentity = yield* storage.compareAndSet(replacement, wrongIdentity)
        const loaded = yield* storage.get(channelScope, original.scheduleId)
        return {
          replaced,
          stale,
          mismatchedDueAt,
          mismatchedOccurrence,
          mismatchedIdentity,
          loaded,
        }
      }).pipe(Effect.provide(KoishiScheduledTaskStorage.layer(ctx)))

      expect(result).toMatchObject({
        replaced: true,
        stale: false,
        mismatchedDueAt: false,
        mismatchedOccurrence: false,
        mismatchedIdentity: false,
      })
      expect(Option.getOrUndefined(result.loaded)).toEqual(replacement)
    }),
  ),
)

it.effect('serializes competing compare-and-set mutations within one runtime', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* databaseContext(':memory:')
      const channelScope = scope()
      const original = task(channelScope, 'a', { dueAt: 1_000 })
      const triggered = ScheduledTaskModel.Task.make({
        ...original,
        reason: ScheduledTaskModel.Reason.make('Triggered winner'),
        status: 'triggered',
        occurrence: ScheduledTaskModel.Occurrence.make(1),
        revision: ScheduledTaskModel.Revision.make(2),
        updatedAt: ScheduledTaskModel.EpochMilliseconds.make(3_000),
        lastTriggeredAt: Option.some(ScheduledTaskModel.EpochMilliseconds.make(1_000)),
      })
      const cancelled = ScheduledTaskModel.Task.make({
        ...original,
        reason: ScheduledTaskModel.Reason.make('Cancelled winner'),
        status: 'cancelled',
        revision: ScheduledTaskModel.Revision.make(2),
        updatedAt: ScheduledTaskModel.EpochMilliseconds.make(4_000),
      })

      const result = yield* Effect.gen(function* () {
        const storage = yield* ScheduledTaskStorage.Service
        yield* storage.create(original)
        const outcomes = yield* Effect.all(
          [storage.compareAndSet(original, triggered), storage.compareAndSet(original, cancelled)],
          { concurrency: 'unbounded' },
        )
        const loaded = yield* storage.get(channelScope, original.scheduleId)
        return { outcomes, loaded }
      }).pipe(Effect.provide(KoishiScheduledTaskStorage.layer(ctx)))

      expect([...result.outcomes].sort()).toEqual([false, true])
      const winner = Option.getOrUndefined(result.loaded)
      if (winner === undefined) return yield* Effect.die('Expected the winning replacement')
      expect(winner.revision).toBe(2)
      expect([triggered, cancelled]).toContainEqual(winner)
    }),
  ),
)

it.effect('retains the mutation permit until an interrupted database promise settles', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* databaseContext(':memory:')
      const channelScope = scope()
      const original = task(channelScope, 'a', { dueAt: 1_000 })
      const firstReplacement = ScheduledTaskModel.Task.make({
        ...original,
        reason: ScheduledTaskModel.Reason.make('Interrupted mutation'),
        revision: ScheduledTaskModel.Revision.make(2),
      })
      const secondReplacement = ScheduledTaskModel.Task.make({
        ...original,
        reason: ScheduledTaskModel.Reason.make('Following mutation'),
        revision: ScheduledTaskModel.Revision.make(2),
      })

      yield* Effect.gen(function* () {
        const storage = yield* ScheduledTaskStorage.Service
        yield* storage.create(original)
        const firstEntered = yield* Deferred.make<void>()
        const settleFirst = yield* Deferred.make<void>()
        const set = vi.spyOn(ctx.database, 'set').mockImplementationOnce(() => {
          Effect.runSync(Deferred.succeed(firstEntered, undefined))
          return Effect.runPromise(Deferred.await(settleFirst).pipe(Effect.as({ matched: 1 })))
        })

        const first = yield* Effect.forkChild(storage.compareAndSet(original, firstReplacement))
        yield* Deferred.await(firstEntered)
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(first))
        const second = yield* Effect.forkChild(storage.compareAndSet(original, secondReplacement))
        yield* Effect.yieldNow
        expect(set).toHaveBeenCalledTimes(1)

        yield* Deferred.succeed(settleFirst, undefined)
        yield* Fiber.join(interrupting)
        expect(yield* Fiber.join(second)).toBe(true)
        expect(set).toHaveBeenCalledTimes(2)
        set.mockRestore()
      }).pipe(Effect.provide(KoishiScheduledTaskStorage.layer(ctx)))
    }),
  ),
)

it.effect('loads the same schema-validated task after a SQLite restart', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory
      const path = join(directory, 'schedule.db')
      const channelScope = scope('restart')
      const expected = task(channelScope, 'a', {
        dueAt: 42_000,
        repeatEveryMs: 315_360_000_000,
        lastTriggeredAt: 21_000,
      })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const ctx = yield* databaseContext(path)
          yield* ScheduledTaskStorage.Service.pipe(
            Effect.flatMap((storage) => storage.create(expected)),
            Effect.provide(KoishiScheduledTaskStorage.layer(ctx)),
          )
        }),
      )

      const loaded = yield* Effect.scoped(
        Effect.gen(function* () {
          const ctx = yield* databaseContext(path)
          return yield* ScheduledTaskStorage.Service.pipe(
            Effect.flatMap((storage) => storage.get(channelScope, expected.scheduleId)),
            Effect.provide(KoishiScheduledTaskStorage.layer(ctx)),
          )
        }),
      )
      expect(Option.getOrUndefined(loaded)).toEqual(expected)
    }),
  ),
)

it.effect('returns operation-typed failures for malformed persisted rows', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* databaseContext(':memory:')
      const channelScope = scope()
      const expected = task(channelScope, 'a')
      const later = task(channelScope, 'b', { dueAt: expected.dueAt + 1_000 })
      const row = yield* YokaiScheduleRowCodec.encode(expected)
      yield* Effect.promise(() => ctx.database.create('yokai_schedule', { ...row, revision: 0 }))
      yield* ScheduledTaskStorage.Service.pipe(
        Effect.flatMap((storage) => storage.create(later)),
        Effect.provide(KoishiScheduledTaskStorage.layer(ctx)),
      )

      const getError = yield* ScheduledTaskStorage.Service.pipe(
        Effect.flatMap((storage) => storage.get(channelScope, expected.scheduleId)),
        Effect.provide(KoishiScheduledTaskStorage.layer(ctx)),
        Effect.flip,
      )
      const queryError = yield* ScheduledTaskStorage.Service.pipe(
        Effect.flatMap((storage) => storage.query(query(channelScope))),
        Effect.provide(KoishiScheduledTaskStorage.layer(ctx)),
        Effect.flip,
      )
      const next = yield* ScheduledTaskStorage.Service.pipe(
        Effect.flatMap((storage) => storage.next(channelScope.instanceId)),
        Effect.provide(KoishiScheduledTaskStorage.layer(ctx)),
      )
      expect(getError).toMatchObject({
        _tag: 'ScheduledTaskStorageError',
        operation: 'get',
      })
      expect(queryError).toMatchObject({
        _tag: 'ScheduledTaskStorageError',
        operation: 'query',
      })
      expect(Option.getOrUndefined(next)).toEqual(later)
    }),
  ),
)
