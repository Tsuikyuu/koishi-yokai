import { Option, Schema } from 'effect'

import { MessageArchiveEvent } from '@yokai-internal/memory'

export const MAX_DEDUPE_KEY_LENGTH = 256
export const MAX_REASON_LENGTH = 2_048
export const MAX_TIME_ZONE_ID_LENGTH = 128
export const MAX_QUERY_LIMIT = 32

export const ScheduleId = Schema.String.check(Schema.isPattern(/^schedule_[a-f0-9]{32}$/)).pipe(
  Schema.brand('@yokai/core/ScheduleId'),
)

export type ScheduleId = typeof ScheduleId.Type

export const DedupeKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_DEDUPE_KEY_LENGTH),
  Schema.isPattern(/^[^\p{C}]+$/u),
).pipe(Schema.brand('@yokai/core/ScheduleDedupeKey'))

export type DedupeKey = typeof DedupeKey.Type

export const CreationFingerprint = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(
  Schema.brand('@yokai/core/ScheduleCreationFingerprint'),
)

export type CreationFingerprint = typeof CreationFingerprint.Type

export const Reason = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_REASON_LENGTH),
).pipe(Schema.brand('@yokai/core/ScheduleReason'))

export type Reason = typeof Reason.Type

export const TimeZoneId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_TIME_ZONE_ID_LENGTH),
).pipe(Schema.brand('@yokai/core/ScheduleTimeZoneId'))

export type TimeZoneId = typeof TimeZoneId.Type

export const TimeExpression = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(32),
  Schema.isPattern(/^(?:\d{4}-\d{2}-\d{2}T)?\d{2}:\d{2}(?::\d{2})?$/),
).pipe(Schema.brand('@yokai/core/ScheduleTimeExpression'))

export type TimeExpression = typeof TimeExpression.Type

export const EpochMilliseconds = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
).pipe(Schema.brand('@yokai/core/ScheduleEpochMilliseconds'))

export type EpochMilliseconds = typeof EpochMilliseconds.Type

export const RepeatEveryMilliseconds = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
).pipe(Schema.brand('@yokai/core/ScheduleRepeatEveryMilliseconds'))

export type RepeatEveryMilliseconds = typeof RepeatEveryMilliseconds.Type

export const RepeatEveryMinutes = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 5_256_000 }),
).pipe(Schema.brand('@yokai/core/ScheduleRepeatEveryMinutes'))

export type RepeatEveryMinutes = typeof RepeatEveryMinutes.Type

export const Occurrence = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
).pipe(Schema.brand('@yokai/core/ScheduleOccurrence'))

export type Occurrence = typeof Occurrence.Type

export const Revision = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
).pipe(Schema.brand('@yokai/core/ScheduleRevision'))

export type Revision = typeof Revision.Type

export const Status = Schema.Literals(['pending', 'triggered', 'cancelled', 'expired'])
export type Status = typeof Status.Type

export const QueryLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_QUERY_LIMIT }),
).pipe(Schema.brand('@yokai/core/ScheduleQueryLimit'))

export type QueryLimit = typeof QueryLimit.Type

export const Statuses = Schema.Array(Status).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4),
  Schema.isUnique(),
)

export type Statuses = typeof Statuses.Type

export const Task = Schema.Struct({
  ...MessageArchiveEvent.ChannelScope.fields,
  scheduleId: ScheduleId,
  dedupeKey: DedupeKey,
  creationFingerprint: CreationFingerprint,
  createdMessageId: MessageArchiveEvent.MessageId,
  creatorId: MessageArchiveEvent.ActorId,
  selfId: MessageArchiveEvent.ActorId,
  reason: Reason,
  dueAt: EpochMilliseconds,
  repeatEveryMs: Schema.OptionFromNullOr(RepeatEveryMilliseconds),
  timeZone: TimeZoneId,
  status: Status,
  occurrence: Occurrence,
  revision: Revision,
  createdAt: EpochMilliseconds,
  updatedAt: EpochMilliseconds,
  lastTriggeredAt: Schema.OptionFromNullOr(EpochMilliseconds),
})

export interface Task extends Schema.Schema.Type<typeof Task> {}

export const CreateRequest = Schema.Struct({
  scope: MessageArchiveEvent.ChannelScope,
  sourceMessageId: MessageArchiveEvent.MessageId,
  time: TimeExpression,
  reason: Reason,
  dedupeKey: DedupeKey,
  repeatEveryMs: Schema.OptionFromNullOr(RepeatEveryMilliseconds),
})

export interface CreateRequest extends Schema.Schema.Type<typeof CreateRequest> {}

export const UpdateRequest = Schema.Struct({
  scope: MessageArchiveEvent.ChannelScope,
  scheduleId: ScheduleId,
  time: TimeExpression,
  reason: Reason,
  repeatEveryMs: Schema.OptionFromNullOr(RepeatEveryMilliseconds),
})

export interface UpdateRequest extends Schema.Schema.Type<typeof UpdateRequest> {}

export const CancelRequest = Schema.Struct({
  scope: MessageArchiveEvent.ChannelScope,
  scheduleId: ScheduleId,
})

export interface CancelRequest extends Schema.Schema.Type<typeof CancelRequest> {}

export const QueryRequest = Schema.Struct({
  scope: MessageArchiveEvent.ChannelScope,
  statuses: Statuses,
  creatorId: Schema.OptionFromNullOr(MessageArchiveEvent.ActorId),
  dueFrom: Schema.OptionFromNullOr(EpochMilliseconds),
  dueUntil: Schema.OptionFromNullOr(EpochMilliseconds),
  limit: QueryLimit,
})

export interface QueryRequest extends Schema.Schema.Type<typeof QueryRequest> {}

export const scopeOf = (task: Task): MessageArchiveEvent.ChannelScope =>
  MessageArchiveEvent.ChannelScope.make({
    instanceId: task.instanceId,
    platform: task.platform,
    guildId: task.guildId,
    channelId: task.channelId,
  })

export const pendingQuery = (
  scope: MessageArchiveEvent.ChannelScope,
  creatorId: Option.Option<MessageArchiveEvent.ActorId>,
  limit: QueryLimit,
): QueryRequest =>
  QueryRequest.make({
    scope,
    statuses: ['pending'],
    creatorId,
    dueFrom: Option.none(),
    dueUntil: Option.none(),
    limit,
  })

export * as ScheduledTaskModel from './model'
