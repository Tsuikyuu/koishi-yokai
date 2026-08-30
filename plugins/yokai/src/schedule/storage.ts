import { ScheduledTaskModel, ScheduledTaskStorage } from '@yokai-internal/core'
import type { MessageArchiveEvent } from '@yokai-internal/memory'
import { Effect, Layer, Option, Semaphore } from 'effect'
import type { Context } from 'koishi'

import type { YokaiScheduleRow } from './model'
import { YokaiScheduleRowCodec } from './row'

interface ScopeRow {
  readonly instanceId: string
  readonly platform: string
  readonly guildId: string
  readonly channelId: string
}

const scopeQuery = (scope: ScopeRow) => ({
  instanceId: scope.instanceId,
  platform: scope.platform,
  guildId: scope.guildId,
  channelId: scope.channelId,
})

const scheduleQuery = (
  scope: MessageArchiveEvent.ChannelScope,
  scheduleId: ScheduledTaskModel.ScheduleId,
) => ({ ...scopeQuery(scope), scheduleId })

const creatorQuery = (creatorId: Option.Option<MessageArchiveEvent.ActorId>) =>
  Option.match(creatorId, {
    onNone: () => ({}),
    onSome: (value) => ({ creatorId: value }),
  })

const dueQuery = (request: ScheduledTaskModel.QueryRequest) => {
  const lower = Option.match(request.dueFrom, {
    onNone: () => ({}),
    onSome: (dueAt) => ({ $gte: new Date(dueAt) }),
  })
  const upper = Option.match(request.dueUntil, {
    onNone: () => ({}),
    onSome: (dueAt) => ({ $lte: new Date(dueAt) }),
  })
  return Option.isNone(request.dueFrom) && Option.isNone(request.dueUntil)
    ? {}
    : { dueAt: { ...lower, ...upper } }
}

const taskQuery = (request: ScheduledTaskModel.QueryRequest) => ({
  ...scopeQuery(request.scope),
  status: { $in: [...request.statuses] },
  ...creatorQuery(request.creatorId),
  ...dueQuery(request),
})

const excludedScheduleQuery = (scheduleIds: ReadonlyArray<string>) =>
  scheduleIds.length === 0 ? {} : { scheduleId: { $nin: [...scheduleIds] } }

const storageFailure = (operation: ScheduledTaskStorage.StorageOperation) =>
  Effect.mapError((cause) => new ScheduledTaskStorage.StorageError({ operation, cause }))

const decodeRows = (
  rows: ReadonlyArray<YokaiScheduleRow>,
  operation: ScheduledTaskStorage.StorageOperation,
) =>
  Effect.forEach(rows, (row) => YokaiScheduleRowCodec.decode(row).pipe(storageFailure(operation)))

const sameIdentity = (left: ScheduledTaskModel.Task, right: ScheduledTaskModel.Task): boolean =>
  left.instanceId === right.instanceId &&
  left.platform === right.platform &&
  left.guildId === right.guildId &&
  left.channelId === right.channelId &&
  left.scheduleId === right.scheduleId

const classifyExisting = (
  requested: ScheduledTaskModel.Task,
  existing: ScheduledTaskModel.Task,
): ScheduledTaskStorage.CreateResult =>
  existing.dedupeKey === requested.dedupeKey &&
  existing.creationFingerprint === requested.creationFingerprint
    ? ScheduledTaskStorage.CreateResult.Replay({ task: existing })
    : ScheduledTaskStorage.CreateResult.Conflict({ task: existing })

const mutableRow = (row: YokaiScheduleRow) => ({
  dedupeKey: row.dedupeKey,
  creationFingerprint: row.creationFingerprint,
  createdMessageId: row.createdMessageId,
  creatorId: row.creatorId,
  selfId: row.selfId,
  reason: row.reason,
  dueAt: row.dueAt,
  repeatEveryMs: row.repeatEveryMs,
  timeZone: row.timeZone,
  status: row.status,
  occurrence: row.occurrence,
  revision: row.revision,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  lastTriggeredAt: row.lastTriggeredAt,
})

export const layer = (ctx: Context) =>
  Layer.effect(
    ScheduledTaskStorage.Service,
    Effect.gen(function* () {
      const mutationGate = yield* Semaphore.make(1)

      const get = Effect.fn('KoishiScheduledTaskStorage.get')(function* (
        scope: MessageArchiveEvent.ChannelScope,
        scheduleId: ScheduledTaskModel.ScheduleId,
      ) {
        const rows = yield* Effect.tryPromise(() =>
          ctx.database.get('yokai_schedule', scheduleQuery(scope, scheduleId), { limit: 1 }),
        ).pipe(storageFailure('get'))
        const row = rows[0]
        if (row === undefined) return Option.none<ScheduledTaskModel.Task>()
        return Option.some(yield* YokaiScheduleRowCodec.decode(row).pipe(storageFailure('get')))
      })

      const query = Effect.fn('KoishiScheduledTaskStorage.query')(function* (
        request: ScheduledTaskModel.QueryRequest,
      ) {
        const rows = yield* Effect.tryPromise(() =>
          ctx.database.get('yokai_schedule', taskQuery(request), {
            limit: request.limit,
            sort: { dueAt: 'asc', scheduleId: 'asc' },
          }),
        ).pipe(storageFailure('query'))
        return yield* decodeRows(rows, 'query')
      })

      const nextCandidate = (
        instanceId: MessageArchiveEvent.InstanceId,
        excludedScheduleIds: ReadonlyArray<string>,
      ): Effect.Effect<Option.Option<ScheduledTaskModel.Task>, ScheduledTaskStorage.StorageError> =>
        Effect.tryPromise(() =>
          ctx.database.get(
            'yokai_schedule',
            {
              instanceId,
              status: 'pending',
              ...excludedScheduleQuery(excludedScheduleIds),
            },
            { limit: 1, sort: { dueAt: 'asc', scheduleId: 'asc' } },
          ),
        ).pipe(
          storageFailure('next'),
          Effect.flatMap((rows) => {
            const row = rows[0]
            if (row === undefined) return Effect.succeed(Option.none<ScheduledTaskModel.Task>())
            return YokaiScheduleRowCodec.decode(row).pipe(
              Effect.map(Option.some),
              Effect.catch((error) =>
                Effect.logWarning('KoishiScheduledTaskStorage.malformed_next_row', error).pipe(
                  Effect.annotateLogs({ instanceId, scheduleId: row.scheduleId }),
                  Effect.andThen(
                    nextCandidate(instanceId, [...excludedScheduleIds, row.scheduleId]),
                  ),
                ),
              ),
            )
          }),
        )

      const next = Effect.fn('KoishiScheduledTaskStorage.next')(
        (
          instanceId: MessageArchiveEvent.InstanceId,
          excludedScheduleIds: ReadonlyArray<ScheduledTaskModel.ScheduleId> = [],
        ) => nextCandidate(instanceId, excludedScheduleIds),
      )

      const readCreateConflict = Effect.fn('KoishiScheduledTaskStorage.readCreateConflict')(
        function* (task: ScheduledTaskModel.Task) {
          const rows = yield* Effect.tryPromise(() =>
            ctx.database.get(
              'yokai_schedule',
              scheduleQuery(ScheduledTaskModel.scopeOf(task), task.scheduleId),
              { limit: 1 },
            ),
          ).pipe(storageFailure('create'))
          const row = rows[0]
          if (row === undefined) return Option.none<ScheduledTaskModel.Task>()
          return Option.some(
            yield* YokaiScheduleRowCodec.decode(row).pipe(storageFailure('create')),
          )
        },
      )

      const create = Effect.fn('KoishiScheduledTaskStorage.create')(function* (
        task: ScheduledTaskModel.Task,
      ) {
        const row = yield* YokaiScheduleRowCodec.encode(task).pipe(storageFailure('create'))
        return yield* mutationGate.withPermits(1)(
          Effect.uninterruptible(
            Effect.tryPromise(() => ctx.database.create('yokai_schedule', row)).pipe(
              storageFailure('create'),
              Effect.as(ScheduledTaskStorage.CreateResult.Stored({ task })),
              Effect.catch((insertError) =>
                readCreateConflict(task).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(insertError),
                      onSome: (existing) => Effect.succeed(classifyExisting(task, existing)),
                    }),
                  ),
                ),
              ),
            ),
          ),
        )
      })

      const compareAndSet = Effect.fn('KoishiScheduledTaskStorage.compareAndSet')(function* (
        expected: ScheduledTaskModel.Task,
        replacement: ScheduledTaskModel.Task,
      ) {
        if (!sameIdentity(expected, replacement)) return false
        const row = yield* YokaiScheduleRowCodec.encode(replacement).pipe(
          storageFailure('compare-and-set'),
        )
        const result = yield* mutationGate.withPermits(1)(
          Effect.uninterruptible(
            Effect.tryPromise(() =>
              ctx.database.set(
                'yokai_schedule',
                {
                  ...scheduleQuery(ScheduledTaskModel.scopeOf(expected), expected.scheduleId),
                  revision: expected.revision,
                  status: expected.status,
                  dueAt: new Date(expected.dueAt),
                  occurrence: expected.occurrence,
                },
                mutableRow(row),
              ),
            ).pipe(storageFailure('compare-and-set')),
          ),
        )
        return result.matched === 1
      })

      return ScheduledTaskStorage.Service.of({ create, get, query, next, compareAndSet })
    }),
  )

export * as KoishiScheduledTaskStorage from './storage'
