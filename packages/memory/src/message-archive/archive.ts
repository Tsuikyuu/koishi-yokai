import { Clock, Context, Duration, Effect, Layer, Option, Schedule, Schema } from 'effect'

import {
  type ArchivedMessage,
  type ChannelScope,
  type InstanceId,
  type MessageId,
  type NormalizedEvent,
  type RecordResult,
  type RetentionDays,
  Timestamp,
} from './event'
import {
  MessageArchiveStorage,
  type OriginalMessageNotFoundError,
  type StorageError,
} from './storage'

export const DEFAULT_RETENTION_DAYS = 90
export const DEFAULT_CLEANUP_INTERVAL = Duration.days(1)

export interface Options {
  readonly instanceId: InstanceId
  readonly retentionDays: RetentionDays
  readonly cleanupInterval: Duration.Duration
}

export class InstanceScopeMismatchError extends Schema.TaggedError<InstanceScopeMismatchError>(
  '@yokai/memory/MessageArchive.InstanceScopeMismatchError',
)('MessageArchiveInstanceScopeMismatchError', {
  configuredInstanceId: Schema.String,
  requestedInstanceId: Schema.String,
}) {}

export interface Interface {
  readonly record: (
    event: NormalizedEvent,
  ) => Effect.Effect<
    RecordResult,
    StorageError | OriginalMessageNotFoundError | InstanceScopeMismatchError
  >
  readonly latest: (
    scope: ChannelScope,
    messageId: MessageId,
  ) => Effect.Effect<Option.Option<ArchivedMessage>, StorageError | InstanceScopeMismatchError>
  readonly versions: (
    scope: ChannelScope,
    messageId: MessageId,
  ) => Effect.Effect<ReadonlyArray<ArchivedMessage>, StorageError | InstanceScopeMismatchError>
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/memory/MessageArchive',
) {}

const ensureInstance = (
  configuredInstanceId: InstanceId,
  requestedInstanceId: InstanceId,
): Effect.Effect<void, InstanceScopeMismatchError> =>
  configuredInstanceId === requestedInstanceId
    ? Effect.void
    : Effect.fail(new InstanceScopeMismatchError({ configuredInstanceId, requestedInstanceId }))

export const layer = (options: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const storage = yield* MessageArchiveStorage.Service

      const record = Effect.fn('MessageArchive.record')(function* (event: NormalizedEvent) {
        yield* ensureInstance(options.instanceId, event.instanceId)
        const recordedAt = Timestamp.make(yield* Clock.currentTimeMillis)
        return yield* storage.store(event, recordedAt)
      })

      const latest = Effect.fn('MessageArchive.latest')(function* (
        scope: ChannelScope,
        messageId: MessageId,
      ) {
        yield* ensureInstance(options.instanceId, scope.instanceId)
        return yield* storage.latest(scope, messageId)
      })

      const versions = Effect.fn('MessageArchive.versions')(function* (
        scope: ChannelScope,
        messageId: MessageId,
      ) {
        yield* ensureInstance(options.instanceId, scope.instanceId)
        return yield* storage.versions(scope, messageId)
      })

      const cleanupPass = Effect.fn('MessageArchive.cleanupExpired')(function* () {
        const now = yield* Clock.currentTimeMillis
        const retention = Duration.toMillis(Duration.days(options.retentionDays))
        const cutoff = Timestamp.make(Math.max(0, now - retention))
        return yield* storage.removeExpired(options.instanceId, cutoff)
      })

      const recoverCleanupFailure = cleanupPass().pipe(
        Effect.tapError((error) => Effect.logError('MessageArchive.cleanup_failed', error)),
        Effect.ignore,
      )
      yield* recoverCleanupFailure.pipe(
        Effect.repeat(Schedule.spaced(options.cleanupInterval)),
        Effect.delay(options.cleanupInterval),
        Effect.forkScoped,
      )

      return Service.of({ record, latest, versions })
    }),
  )

export * as MessageArchive from './archive'
