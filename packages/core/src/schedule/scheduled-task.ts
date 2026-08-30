import { Clock, Context, Effect, Layer, Option, Queue, Schema } from 'effect'

import { MessageArchive, MessageArchiveEvent, MessageArchiveStorage } from '@yokai-internal/memory'
import { ScheduledTaskIdentity } from './identity'
import {
  type CancelRequest,
  type CreateRequest,
  EpochMilliseconds,
  Occurrence,
  pendingQuery,
  type QueryLimit,
  type QueryRequest,
  Revision,
  scopeOf,
  type ScheduleId,
  Task,
  type TimeZoneId,
  type UpdateRequest,
} from './model'
import { ScheduledTaskStorage } from './storage'
import {
  type DueTimeNotFutureError,
  type InvalidTimeExpressionError,
  type InvalidTimeZoneError,
  type ResolvedZone,
  ScheduledTaskTime,
} from './time'

export type StorageError = ScheduledTaskStorage.StorageError

export interface Options {
  readonly instanceId: MessageArchiveEvent.InstanceId
  readonly timeZone: TimeZoneId
  readonly contextLimit: QueryLimit
}

export class InstanceScopeMismatchError extends Schema.TaggedError<InstanceScopeMismatchError>(
  '@yokai/core/ScheduledTask.InstanceScopeMismatchError',
)('ScheduledTaskInstanceScopeMismatchError', {
  configuredInstanceId: Schema.String,
  requestedInstanceId: Schema.String,
}) {}

export class SourceMessageNotFoundError extends Schema.TaggedError<SourceMessageNotFoundError>(
  '@yokai/core/ScheduledTask.SourceMessageNotFoundError',
)('ScheduledTaskSourceMessageNotFoundError', {
  instanceId: Schema.String,
  platform: Schema.String,
  guildId: Schema.String,
  channelId: Schema.String,
  messageId: Schema.String,
}) {}

export class DedupeConflictError extends Schema.TaggedError<DedupeConflictError>(
  '@yokai/core/ScheduledTask.DedupeConflictError',
)('ScheduledTaskDedupeConflictError', {
  scheduleId: Schema.String,
  dedupeKey: Schema.String,
}) {}

export class TaskNotFoundError extends Schema.TaggedError<TaskNotFoundError>(
  '@yokai/core/ScheduledTask.TaskNotFoundError',
)('ScheduledTaskNotFoundError', {
  scheduleId: Schema.String,
}) {}

export class TaskNotPendingError extends Schema.TaggedError<TaskNotPendingError>(
  '@yokai/core/ScheduledTask.TaskNotPendingError',
)('ScheduledTaskNotPendingError', {
  scheduleId: Schema.String,
  status: Schema.String,
}) {}

export class ConcurrentModificationError extends Schema.TaggedError<ConcurrentModificationError>(
  '@yokai/core/ScheduledTask.ConcurrentModificationError',
)('ScheduledTaskConcurrentModificationError', {
  scheduleId: Schema.String,
  revision: Schema.Int,
}) {}

export class TaskNotDueError extends Schema.TaggedError<TaskNotDueError>(
  '@yokai/core/ScheduledTask.TaskNotDueError',
)('ScheduledTaskNotDueError', {
  scheduleId: Schema.String,
  dueAt: Schema.Int,
  attemptedAt: Schema.Int,
}) {}

export class ScheduleArithmeticError extends Schema.TaggedError<ScheduleArithmeticError>(
  '@yokai/core/ScheduledTask.ScheduleArithmeticError',
)('ScheduledTaskArithmeticError', {
  scheduleId: Schema.String,
}) {}

export type CreateError =
  | StorageError
  | MessageArchive.InstanceScopeMismatchError
  | MessageArchiveStorage.StorageError
  | InstanceScopeMismatchError
  | SourceMessageNotFoundError
  | DedupeConflictError
  | InvalidTimeExpressionError
  | DueTimeNotFutureError

export type ReadError = StorageError | InstanceScopeMismatchError

export type MutationError =
  | StorageError
  | InstanceScopeMismatchError
  | TaskNotFoundError
  | TaskNotPendingError
  | ConcurrentModificationError
  | ScheduleArithmeticError
  | InvalidTimeExpressionError
  | DueTimeNotFutureError

export type TransitionError =
  | StorageError
  | InstanceScopeMismatchError
  | TaskNotPendingError
  | TaskNotDueError
  | ScheduleArithmeticError

export interface Interface {
  readonly create: (request: CreateRequest) => Effect.Effect<Task, CreateError>
  readonly get: (
    scope: MessageArchiveEvent.ChannelScope,
    scheduleId: ScheduleId,
  ) => Effect.Effect<Option.Option<Task>, ReadError>
  readonly update: (request: UpdateRequest) => Effect.Effect<Task, MutationError>
  readonly cancel: (request: CancelRequest) => Effect.Effect<Task, MutationError>
  readonly related: (
    scope: MessageArchiveEvent.ChannelScope,
    creatorId: MessageArchiveEvent.ActorId,
  ) => Effect.Effect<ReadonlyArray<Task>, ReadError>
  readonly query: (request: QueryRequest) => Effect.Effect<ReadonlyArray<Task>, ReadError>
  readonly next: (
    excludedScheduleIds?: ReadonlyArray<ScheduleId>,
  ) => Effect.Effect<Option.Option<Task>, StorageError>
  readonly waitForChange: () => Effect.Effect<void>
  readonly claim: (
    task: Task,
    claimedAt: EpochMilliseconds,
  ) => Effect.Effect<Option.Option<Task>, TransitionError>
  readonly expire: (
    task: Task,
    expiredAt: EpochMilliseconds,
  ) => Effect.Effect<boolean, TransitionError>
}

export class Service extends Context.Service<Service, Interface>()('@yokai/core/ScheduledTask') {}

const ensureInstance = (
  configuredInstanceId: MessageArchiveEvent.InstanceId,
  requestedInstanceId: MessageArchiveEvent.InstanceId,
): Effect.Effect<void, InstanceScopeMismatchError> =>
  configuredInstanceId === requestedInstanceId
    ? Effect.void
    : Effect.fail(new InstanceScopeMismatchError({ configuredInstanceId, requestedInstanceId }))

const requirePending = (task: Task): Effect.Effect<Task, TaskNotPendingError> =>
  task.status === 'pending'
    ? Effect.succeed(task)
    : Effect.fail(new TaskNotPendingError({ scheduleId: task.scheduleId, status: task.status }))

const safeRevision = (task: Task): Effect.Effect<Revision, ScheduleArithmeticError> => {
  const revision = task.revision + 1
  return Number.isSafeInteger(revision) && revision > 0
    ? Effect.succeed(Revision.make(revision))
    : Effect.fail(new ScheduleArithmeticError({ scheduleId: task.scheduleId }))
}

interface RepeatOccurrence {
  readonly occurrence: Occurrence
  readonly dueAt: EpochMilliseconds
  readonly nextOccurrence: Occurrence
  readonly nextDueAt: EpochMilliseconds
}

const repeatOccurrence = (
  task: Task,
  at: EpochMilliseconds,
): Effect.Effect<RepeatOccurrence, ScheduleArithmeticError> =>
  Effect.gen(function* () {
    if (Option.isNone(task.repeatEveryMs)) {
      return yield* Effect.fail(new ScheduleArithmeticError({ scheduleId: task.scheduleId }))
    }
    const elapsed = Math.max(0, at - task.dueAt)
    const skipped = Math.floor(elapsed / task.repeatEveryMs.value)
    const occurrence = task.occurrence + skipped
    const dueAt = task.dueAt + skipped * task.repeatEveryMs.value
    const nextOccurrence = occurrence + 1
    const nextDueAt = dueAt + task.repeatEveryMs.value
    if (
      !Number.isSafeInteger(occurrence) ||
      !Number.isSafeInteger(dueAt) ||
      !Number.isSafeInteger(nextOccurrence) ||
      !Number.isSafeInteger(nextDueAt) ||
      nextDueAt <= at
    ) {
      return yield* Effect.fail(new ScheduleArithmeticError({ scheduleId: task.scheduleId }))
    }
    return {
      occurrence: Occurrence.make(occurrence),
      dueAt: EpochMilliseconds.make(dueAt),
      nextOccurrence: Occurrence.make(nextOccurrence),
      nextDueAt: EpochMilliseconds.make(nextDueAt),
    }
  })

export const latestDueAt = (
  task: Task,
  at: EpochMilliseconds,
): Effect.Effect<EpochMilliseconds, ScheduleArithmeticError> =>
  Option.isNone(task.repeatEveryMs)
    ? Effect.succeed(task.dueAt)
    : repeatOccurrence(task, at).pipe(Effect.map((value) => value.dueAt))

const repeatAfter = (
  task: Task,
  at: EpochMilliseconds,
): Effect.Effect<
  { readonly occurrence: Occurrence; readonly dueAt: EpochMilliseconds },
  ScheduleArithmeticError
> =>
  Effect.gen(function* () {
    if (Option.isNone(task.repeatEveryMs)) {
      return yield* Effect.fail(new ScheduleArithmeticError({ scheduleId: task.scheduleId }))
    }
    const elapsed = Math.max(0, at - task.dueAt)
    const skipped = Math.floor(elapsed / task.repeatEveryMs.value) + 1
    const occurrence = task.occurrence + skipped
    const dueAt = task.dueAt + skipped * task.repeatEveryMs.value
    if (!Number.isSafeInteger(occurrence) || !Number.isSafeInteger(dueAt) || dueAt <= at) {
      return yield* Effect.fail(new ScheduleArithmeticError({ scheduleId: task.scheduleId }))
    }
    return {
      occurrence: Occurrence.make(occurrence),
      dueAt: EpochMilliseconds.make(dueAt),
    }
  })

const sourceMissing = (
  scope: MessageArchiveEvent.ChannelScope,
  messageId: MessageArchiveEvent.MessageId,
) =>
  new SourceMessageNotFoundError({
    ...scope,
    messageId,
  })

const currentTime = (): Effect.Effect<EpochMilliseconds> =>
  Clock.currentTimeMillis.pipe(Effect.map(EpochMilliseconds.make))

const requestFingerprint = (
  request: CreateRequest,
  creatorId: MessageArchiveEvent.ActorId,
  selfId: MessageArchiveEvent.ActorId,
  timeZone: TimeZoneId,
) =>
  ScheduledTaskIdentity.creationFingerprint(request.scope, request.dedupeKey, {
    sourceMessageId: request.sourceMessageId,
    creatorId,
    selfId,
    reason: request.reason,
    time: request.time,
    repeatEveryMs: request.repeatEveryMs,
    timeZone,
  })

const taskAtCreation = (
  request: CreateRequest,
  source: MessageArchiveEvent.ArchivedMessage,
  now: EpochMilliseconds,
  dueAt: EpochMilliseconds,
  timeZone: TimeZoneId,
): Task => {
  const scheduleId = ScheduledTaskIdentity.stableId(request.scope, request.dedupeKey)
  const creationFingerprint = requestFingerprint(request, source.authorId, source.selfId, timeZone)
  return Task.make({
    ...request.scope,
    scheduleId,
    dedupeKey: request.dedupeKey,
    creationFingerprint,
    createdMessageId: request.sourceMessageId,
    creatorId: source.authorId,
    selfId: source.selfId,
    reason: request.reason,
    dueAt,
    repeatEveryMs: request.repeatEveryMs,
    timeZone,
    status: 'pending',
    occurrence: Occurrence.make(0),
    revision: Revision.make(1),
    createdAt: now,
    updatedAt: now,
    lastTriggeredAt: Option.none(),
  })
}

const replacementTask = (
  task: Task,
  request: UpdateRequest,
  now: EpochMilliseconds,
  dueAt: EpochMilliseconds,
  revision: Revision,
  timeZone: TimeZoneId,
): Task =>
  Task.make({
    ...task,
    reason: request.reason,
    dueAt,
    repeatEveryMs: request.repeatEveryMs,
    timeZone,
    revision,
    updatedAt: now,
  })

export const layer = (options: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const archive = yield* MessageArchive.Service
      const storage = yield* ScheduledTaskStorage.Service
      const resolvedZone = yield* ScheduledTaskTime.resolveZone(options.timeZone)
      const changes = yield* Queue.sliding<void>(1)

      const notify = (): Effect.Effect<void> => Queue.offer(changes, undefined).pipe(Effect.asVoid)

      const resolveDueAt = (
        time: CreateRequest['time'] | UpdateRequest['time'],
        now: EpochMilliseconds,
      ) => ScheduledTaskTime.parse(time, now, resolvedZone)

      const get = Effect.fn('ScheduledTask.get')(function* (
        scope: MessageArchiveEvent.ChannelScope,
        scheduleId: ScheduleId,
      ) {
        yield* ensureInstance(options.instanceId, scope.instanceId)
        return yield* storage.get(scope, scheduleId)
      })

      const requireTask = Effect.fn('ScheduledTask.requireTask')(function* (
        scope: MessageArchiveEvent.ChannelScope,
        scheduleId: ScheduleId,
      ) {
        const found = yield* get(scope, scheduleId)
        return yield* Option.match(found, {
          onNone: () => Effect.fail(new TaskNotFoundError({ scheduleId })),
          onSome: Effect.succeed,
        })
      })

      const create = Effect.fn('ScheduledTask.create')(function* (request: CreateRequest) {
        yield* ensureInstance(options.instanceId, request.scope.instanceId)
        const scheduleId = ScheduledTaskIdentity.stableId(request.scope, request.dedupeKey)
        const existing = yield* storage.get(request.scope, scheduleId)
        if (Option.isSome(existing)) {
          const fingerprint = requestFingerprint(
            request,
            existing.value.creatorId,
            existing.value.selfId,
            existing.value.timeZone,
          )
          if (fingerprint === existing.value.creationFingerprint) return existing.value
          return yield* Effect.fail(
            new DedupeConflictError({ scheduleId, dedupeKey: request.dedupeKey }),
          )
        }
        const source = yield* archive.latest(request.scope, request.sourceMessageId)
        const archived = yield* Option.match(source, {
          onNone: () => Effect.fail(sourceMissing(request.scope, request.sourceMessageId)),
          onSome: Effect.succeed,
        })
        const now = yield* currentTime()
        const dueAt = yield* resolveDueAt(request.time, now)
        const candidate = taskAtCreation(request, archived, now, dueAt, resolvedZone.id)
        const stored = yield* storage.create(candidate)
        return yield* ScheduledTaskStorage.CreateResult.$match(stored, {
          Stored: ({ task }) => notify().pipe(Effect.as(task)),
          Replay: ({ task }) => Effect.succeed(task),
          Conflict: ({ task }) =>
            Effect.fail(
              new DedupeConflictError({
                scheduleId: task.scheduleId,
                dedupeKey: request.dedupeKey,
              }),
            ),
        })
      })

      const update = Effect.fn('ScheduledTask.update')(function* (request: UpdateRequest) {
        yield* ensureInstance(options.instanceId, request.scope.instanceId)
        const task = yield* requireTask(request.scope, request.scheduleId)
        yield* requirePending(task)
        const now = yield* currentTime()
        const dueAt = yield* resolveDueAt(request.time, now)
        const revision = yield* safeRevision(task)
        const replacement = replacementTask(task, request, now, dueAt, revision, resolvedZone.id)
        const changed = yield* storage.compareAndSet(task, replacement)
        if (!changed) {
          return yield* Effect.fail(
            new ConcurrentModificationError({
              scheduleId: task.scheduleId,
              revision: task.revision,
            }),
          )
        }
        yield* notify()
        return replacement
      })

      const cancel = Effect.fn('ScheduledTask.cancel')(function* (request: CancelRequest) {
        yield* ensureInstance(options.instanceId, request.scope.instanceId)
        const task = yield* requireTask(request.scope, request.scheduleId)
        yield* requirePending(task)
        const now = yield* currentTime()
        const revision = yield* safeRevision(task)
        const replacement = Task.make({
          ...task,
          status: 'cancelled',
          revision,
          updatedAt: now,
        })
        const changed = yield* storage.compareAndSet(task, replacement)
        if (!changed) {
          return yield* Effect.fail(
            new ConcurrentModificationError({
              scheduleId: task.scheduleId,
              revision: task.revision,
            }),
          )
        }
        yield* notify()
        return replacement
      })

      const query = Effect.fn('ScheduledTask.query')(function* (request: QueryRequest) {
        yield* ensureInstance(options.instanceId, request.scope.instanceId)
        return yield* storage.query(request)
      })

      const related = Effect.fn('ScheduledTask.related')(function* (
        scope: MessageArchiveEvent.ChannelScope,
        creatorId: MessageArchiveEvent.ActorId,
      ) {
        return yield* query(pendingQuery(scope, Option.some(creatorId), options.contextLimit))
      })

      const claim = Effect.fn('ScheduledTask.claim')(function* (
        task: Task,
        claimedAt: EpochMilliseconds,
      ) {
        yield* ensureInstance(options.instanceId, task.instanceId)
        yield* requirePending(task)
        if (task.dueAt > claimedAt) {
          return yield* Effect.fail(
            new TaskNotDueError({
              scheduleId: task.scheduleId,
              dueAt: task.dueAt,
              attemptedAt: claimedAt,
            }),
          )
        }
        const revision = yield* safeRevision(task)
        if (Option.isNone(task.repeatEveryMs)) {
          const claimed = Task.make({
            ...task,
            status: 'triggered',
            revision,
            updatedAt: claimedAt,
            lastTriggeredAt: Option.some(claimedAt),
          })
          const changed = yield* storage.compareAndSet(task, claimed)
          if (changed) yield* notify()
          return changed ? Option.some(claimed) : Option.none<Task>()
        }

        const occurrence = yield* repeatOccurrence(task, claimedAt)
        const claimed = Task.make({
          ...task,
          status: 'triggered',
          dueAt: occurrence.dueAt,
          occurrence: occurrence.occurrence,
          revision,
          updatedAt: claimedAt,
          lastTriggeredAt: Option.some(claimedAt),
        })
        const replacement = Task.make({
          ...claimed,
          status: 'pending',
          dueAt: occurrence.nextDueAt,
          occurrence: occurrence.nextOccurrence,
        })
        const changed = yield* storage.compareAndSet(task, replacement)
        if (changed) yield* notify()
        return changed ? Option.some(claimed) : Option.none<Task>()
      })

      const expire = Effect.fn('ScheduledTask.expire')(function* (
        task: Task,
        expiredAt: EpochMilliseconds,
      ) {
        yield* ensureInstance(options.instanceId, task.instanceId)
        yield* requirePending(task)
        if (task.dueAt > expiredAt) {
          return yield* Effect.fail(
            new TaskNotDueError({
              scheduleId: task.scheduleId,
              dueAt: task.dueAt,
              attemptedAt: expiredAt,
            }),
          )
        }
        const revision = yield* safeRevision(task)
        const replacement = Option.isNone(task.repeatEveryMs)
          ? Task.make({
              ...task,
              status: 'expired',
              revision,
              updatedAt: expiredAt,
            })
          : yield* repeatAfter(task, expiredAt).pipe(
              Effect.map((future) =>
                Task.make({
                  ...task,
                  status: 'pending',
                  dueAt: future.dueAt,
                  occurrence: future.occurrence,
                  revision,
                  updatedAt: expiredAt,
                }),
              ),
            )
        const changed = yield* storage.compareAndSet(task, replacement)
        if (changed) yield* notify()
        return changed
      })

      return Service.of({
        create,
        get,
        update,
        cancel,
        related,
        query,
        next: (excludedScheduleIds = []) => storage.next(options.instanceId, excludedScheduleIds),
        waitForChange: () => Queue.take(changes),
        claim,
        expire,
      })
    }),
  )

export type LayerError = InvalidTimeZoneError

export const timeZoneOf = (options: Options): TimeZoneId => options.timeZone

export const resolvedLocalIso = (at: EpochMilliseconds, resolvedZone: ResolvedZone): string =>
  ScheduledTaskTime.localIso(at, resolvedZone)

export const taskScope = scopeOf

export * as ScheduledTask from './scheduled-task'
