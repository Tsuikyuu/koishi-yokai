import { Clock, Duration, Effect, FiberSet, Layer, Option, Schedule } from 'effect'

import { WakeProposal } from '../wake/proposal'
import { ScheduledDelivery } from './delivery'
import { ScheduledTaskModel } from './model'
import { ScheduledTask } from './scheduled-task'

export const DEFAULT_GRACE_PERIOD_MS = WakeProposal.DurationMilliseconds.make(5 * 60_000)
export const DEFAULT_STORAGE_RETRY_DELAY_MS = WakeProposal.DurationMilliseconds.make(1_000)
export const DEFAULT_STORAGE_RETRY_ATTEMPTS = 2

export interface Options {
  readonly gracePeriodMs: WakeProposal.DurationMilliseconds
  readonly storageRetryDelayMs: WakeProposal.DurationMilliseconds
  readonly storageRetryAttempts: number
}

export const DEFAULT_OPTIONS: Options = {
  gracePeriodMs: DEFAULT_GRACE_PERIOD_MS,
  storageRetryDelayMs: DEFAULT_STORAGE_RETRY_DELAY_MS,
  storageRetryAttempts: DEFAULT_STORAGE_RETRY_ATTEMPTS,
}

const pastGrace = (
  dueAt: ScheduledTaskModel.EpochMilliseconds,
  now: number,
  gracePeriodMs: WakeProposal.DurationMilliseconds,
): boolean => Math.max(0, now - dueAt) > gracePeriodMs

const logStorageFailure = (error: ScheduledTask.TransitionError): Effect.Effect<void> =>
  Effect.logError('ScheduledTaskWorker.storage_failed', error)

const logDispatchFailure = (
  task: ScheduledTaskModel.Task,
  error: ScheduledDelivery.DispatchError,
): Effect.Effect<void> =>
  Effect.logError('ScheduledTaskWorker.dispatch_failed', error).pipe(
    Effect.annotateLogs({
      scheduleId: task.scheduleId,
      occurrence: task.occurrence,
    }),
  )

interface AvailableCandidate {
  readonly task: Option.Option<ScheduledTaskModel.Task>
  readonly unavailableDeadline: Option.Option<ScheduledTaskModel.EpochMilliseconds>
}

const withEarlierDeadline = (
  current: Option.Option<ScheduledTaskModel.EpochMilliseconds>,
  dueAt: ScheduledTaskModel.EpochMilliseconds,
  gracePeriodMs: WakeProposal.DurationMilliseconds,
): Option.Option<ScheduledTaskModel.EpochMilliseconds> => {
  const deadline = ScheduledTaskModel.EpochMilliseconds.make(
    Math.min(Number.MAX_SAFE_INTEGER, dueAt + gracePeriodMs),
  )
  return Option.isNone(current) || deadline < current.value ? Option.some(deadline) : current
}

const unavailableRetryDelay = (
  deadline: ScheduledTaskModel.EpochMilliseconds,
  now: ScheduledTaskModel.EpochMilliseconds,
  retryDelayMs: WakeProposal.DurationMilliseconds,
): number => Math.min(retryDelayMs, Math.max(1, deadline - now))

export const layer = (options: Options = DEFAULT_OPTIONS) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const tasks = yield* ScheduledTask.Service
      const delivery = yield* ScheduledDelivery.Service
      const deliveries = yield* FiberSet.make<void, never>()

      const nextAvailable = (
        excludedScheduleIds: ReadonlyArray<ScheduledTaskModel.ScheduleId>,
        now: ScheduledTaskModel.EpochMilliseconds,
        unavailableDeadline: Option.Option<ScheduledTaskModel.EpochMilliseconds>,
      ): Effect.Effect<AvailableCandidate, ScheduledTask.TransitionError> =>
        Effect.gen(function* () {
          const candidate = yield* tasks.next(excludedScheduleIds)
          if (Option.isNone(candidate)) {
            return {
              task: Option.none<ScheduledTaskModel.Task>(),
              unavailableDeadline,
            }
          }
          const relevantDueAt =
            candidate.value.dueAt <= now
              ? yield* ScheduledTask.latestDueAt(candidate.value, now)
              : candidate.value.dueAt
          if (candidate.value.dueAt <= now) {
            if (pastGrace(relevantDueAt, now, options.gracePeriodMs)) {
              yield* tasks.expire(candidate.value, now)
              return yield* nextAvailable(
                [...excludedScheduleIds, candidate.value.scheduleId],
                now,
                unavailableDeadline,
              )
            }
          }
          if (yield* delivery.isAvailable(candidate.value)) {
            return {
              task: candidate,
              unavailableDeadline,
            }
          }
          return yield* nextAvailable(
            [...excludedScheduleIds, candidate.value.scheduleId],
            now,
            withEarlierDeadline(unavailableDeadline, relevantDueAt, options.gracePeriodMs),
          )
        })

      const dispatch = Effect.fn('ScheduledTaskWorker.dispatch')(function* (
        task: ScheduledTaskModel.Task,
        claimedAt: ScheduledTaskModel.EpochMilliseconds,
      ) {
        const proposal = WakeProposal.scheduledTask(task, claimedAt, options.gracePeriodMs)
        yield* delivery.dispatch({ task, proposal }).pipe(
          Effect.tapError((error) => logDispatchFailure(task, error)),
          Effect.ignore,
        )
      })

      const runStep = Effect.fn('ScheduledTaskWorker.runStep')(function* () {
        const scanStartedAt = ScheduledTaskModel.EpochMilliseconds.make(
          yield* Clock.currentTimeMillis,
        )
        const candidate = yield* nextAvailable([], scanStartedAt, Option.none())
        if (Option.isNone(candidate.task)) {
          yield* Option.match(candidate.unavailableDeadline, {
            onNone: () => tasks.waitForChange(),
            onSome: (deadline) =>
              Clock.currentTimeMillis.pipe(
                Effect.map(ScheduledTaskModel.EpochMilliseconds.make),
                Effect.flatMap((now) =>
                  Effect.raceFirst(
                    Effect.sleep(
                      Duration.millis(
                        unavailableRetryDelay(deadline, now, options.storageRetryDelayMs),
                      ),
                    ),
                    tasks.waitForChange(),
                  ),
                ),
              ),
          })
          return
        }

        const task = candidate.task.value
        const transitionAt = ScheduledTaskModel.EpochMilliseconds.make(
          yield* Clock.currentTimeMillis,
        )
        if (task.dueAt > transitionAt) {
          const delay = Option.match(candidate.unavailableDeadline, {
            onNone: () => task.dueAt - transitionAt,
            onSome: (deadline) =>
              Math.min(
                task.dueAt - transitionAt,
                unavailableRetryDelay(deadline, transitionAt, options.storageRetryDelayMs),
              ),
          })
          yield* Effect.raceFirst(Effect.sleep(Duration.millis(delay)), tasks.waitForChange())
          return
        }

        const latestDueAt = yield* ScheduledTask.latestDueAt(task, transitionAt)
        if (pastGrace(latestDueAt, transitionAt, options.gracePeriodMs)) {
          yield* tasks.expire(task, transitionAt)
          return
        }
        const claimed = yield* tasks.claim(task, transitionAt)
        if (Option.isSome(claimed)) {
          yield* FiberSet.run(deliveries, dispatch(claimed.value, transitionAt))
        }
      })

      const runRecoveringStep = runStep().pipe(
        Effect.retry({
          times: options.storageRetryAttempts,
          schedule: Schedule.spaced(Duration.millis(options.storageRetryDelayMs)),
        }),
        Effect.tapError(logStorageFailure),
        Effect.catch(() => Effect.sleep(Duration.millis(options.storageRetryDelayMs))),
      )

      yield* runRecoveringStep.pipe(
        Effect.repeat(Schedule.forever),
        Effect.asVoid,
        Effect.forkScoped({ startImmediately: true }),
      )
    }),
  )

export * as ScheduledTaskWorker from './worker'
