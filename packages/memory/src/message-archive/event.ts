import { Data, Option, Schema } from 'effect'

export const MAX_INSTANCE_ID_LENGTH = 128
export const MAX_SCOPE_ID_LENGTH = 512

export const InstanceId = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_INSTANCE_ID_LENGTH),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9._-]*$/),
).pipe(Schema.brand('@yokai/memory/InstanceId'))

export type InstanceId = typeof InstanceId.Type

const ScopeIdentifier = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_SCOPE_ID_LENGTH),
  Schema.isPattern(/^[^\p{C}]+$/u),
)

export const PlatformId = ScopeIdentifier.pipe(Schema.brand('@yokai/memory/PlatformId'))
export type PlatformId = typeof PlatformId.Type

export const GuildId = ScopeIdentifier.pipe(Schema.brand('@yokai/memory/GuildId'))
export type GuildId = typeof GuildId.Type

export const ChannelId = ScopeIdentifier.pipe(Schema.brand('@yokai/memory/ChannelId'))
export type ChannelId = typeof ChannelId.Type

export const MessageId = ScopeIdentifier.pipe(Schema.brand('@yokai/memory/MessageId'))
export type MessageId = typeof MessageId.Type

export const ActorId = ScopeIdentifier.pipe(Schema.brand('@yokai/memory/ActorId'))
export type ActorId = typeof ActorId.Type

export const Timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand('@yokai/memory/Timestamp'),
)

export type Timestamp = typeof Timestamp.Type

export const MessageVersion = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand('@yokai/memory/MessageVersion'),
)

export type MessageVersion = typeof MessageVersion.Type

export const RetentionDays = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 3_650 }),
).pipe(Schema.brand('@yokai/memory/RetentionDays'))

export type RetentionDays = typeof RetentionDays.Type

export const ChannelScope = Schema.Struct({
  instanceId: InstanceId,
  platform: PlatformId,
  guildId: GuildId,
  channelId: ChannelId,
})

export interface ChannelScope extends Schema.Schema.Type<typeof ChannelScope> {}

const NormalizedMessageFields = {
  ...ChannelScope.fields,
  messageId: MessageId,
  authorId: ActorId,
  selfId: ActorId,
  replyToMessageId: Schema.OptionFromNullOr(MessageId),
  timestamp: Timestamp,
  content: Schema.String,
  isSelf: Schema.Boolean,
}

export const NormalizedEvent = Schema.TaggedUnion({
  MessageCreated: NormalizedMessageFields,
  MessageUpdated: NormalizedMessageFields,
})

export type NormalizedEvent = typeof NormalizedEvent.Type

export const ArchivedMessageKind = Schema.Literals(['created', 'updated'])
export type ArchivedMessageKind = typeof ArchivedMessageKind.Type

export const ArchivedMessage = Schema.Struct({
  ...ChannelScope.fields,
  messageId: MessageId,
  version: MessageVersion,
  sourceVersion: Schema.OptionFromNullOr(MessageVersion),
  previousVersion: Schema.OptionFromNullOr(MessageVersion),
  kind: ArchivedMessageKind,
  authorId: ActorId,
  selfId: ActorId,
  replyToMessageId: Schema.OptionFromNullOr(MessageId),
  timestamp: Timestamp,
  eventTimestamp: Timestamp,
  recordedAt: Timestamp,
  content: Schema.String,
  isSelf: Schema.Boolean,
})

export interface ArchivedMessage extends Schema.Schema.Type<typeof ArchivedMessage> {}

export type RecordResult = Data.TaggedEnum<{
  Stored: { readonly message: ArchivedMessage }
  Replay: { readonly message: ArchivedMessage }
}>

export const RecordResult = Data.taggedEnum<RecordResult>()

export const scopeOf = (event: NormalizedEvent): ChannelScope =>
  ChannelScope.make({
    instanceId: event.instanceId,
    platform: event.platform,
    guildId: event.guildId,
    channelId: event.channelId,
  })

export const contributesToActivity = (event: NormalizedEvent | ArchivedMessage): boolean =>
  !event.isSelf

export const originalVersion = (): MessageVersion => MessageVersion.make(1)

export const nextVersion = (message: ArchivedMessage): MessageVersion =>
  MessageVersion.make(message.version + 1)

export const editedVersion = (
  event: NormalizedEvent,
  previous: ArchivedMessage,
  recordedAt: Timestamp,
): ArchivedMessage =>
  ArchivedMessage.make({
    ...scopeOf(event),
    messageId: event.messageId,
    version: nextVersion(previous),
    sourceVersion: Option.some(originalVersion()),
    previousVersion: Option.some(previous.version),
    kind: 'updated',
    authorId: previous.authorId,
    selfId: previous.selfId,
    replyToMessageId: previous.replyToMessageId,
    timestamp: previous.timestamp,
    eventTimestamp: event.timestamp,
    recordedAt,
    content: event.content,
    isSelf: previous.isSelf,
  })

export const originalMessage = (event: NormalizedEvent, recordedAt: Timestamp): ArchivedMessage =>
  ArchivedMessage.make({
    ...scopeOf(event),
    messageId: event.messageId,
    version: originalVersion(),
    sourceVersion: Option.none(),
    previousVersion: Option.none(),
    kind: event._tag === 'MessageCreated' ? 'created' : 'updated',
    authorId: event.authorId,
    selfId: event.selfId,
    replyToMessageId: event.replyToMessageId,
    timestamp: event.timestamp,
    eventTimestamp: event.timestamp,
    recordedAt,
    content: event.content,
    isSelf: event.isSelf,
  })

export * as MessageArchiveEvent from './event'
