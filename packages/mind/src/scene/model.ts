import { Schema } from 'effect'

export const MAX_ACTIVE_THREADS = 8
export const MAX_THREAD_PARTICIPANTS = 16
export const MAX_THREAD_MESSAGES = 24
export const MAX_THREAD_KEYWORDS = 16
export const MAX_THREAD_DIGESTS = 4
export const MAX_TOPIC_SUMMARY_LENGTH = 256
export const THREAD_IDLE_TTL_MS = 30 * 60 * 1_000
export const THREAD_CONTINUATION_WINDOW_MS = 90 * 1_000
export const THREAD_ACTIVITY_HALF_LIFE_MS = 5 * 60 * 1_000

const Identifier = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(512),
  Schema.isPattern(/^[^\p{C}]+$/u),
)

export const ThreadId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(520),
  Schema.isPattern(/^[^\p{C}]+$/u),
).pipe(Schema.brand('@yokai/mind/ThreadId'))
export type ThreadId = typeof ThreadId.Type

export const MessageId = Identifier.pipe(Schema.brand('@yokai/mind/SceneMessageId'))
export type MessageId = typeof MessageId.Type

export const ParticipantId = Identifier.pipe(Schema.brand('@yokai/mind/SceneParticipantId'))
export type ParticipantId = typeof ParticipantId.Type

export const EpochMilliseconds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand('@yokai/mind/SceneEpochMilliseconds'),
)
export type EpochMilliseconds = typeof EpochMilliseconds.Type

export const Activity = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(
  Schema.brand('@yokai/mind/ThreadActivity'),
)
export type Activity = typeof Activity.Type

export const TopicSummary = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_TOPIC_SUMMARY_LENGTH),
).pipe(Schema.brand('@yokai/mind/TopicSummary'))
export type TopicSummary = typeof TopicSummary.Type

export const Keyword = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(64),
).pipe(Schema.brand('@yokai/mind/ThreadKeyword'))
export type Keyword = typeof Keyword.Type

export const Mode = Schema.Literals(['question', 'chat', 'joke', 'dispute', 'confiding', 'notice'])
export type Mode = typeof Mode.Type

export const DirectionKind = Schema.Literals(['yokai', 'participant', 'group'])
export type DirectionKind = typeof DirectionKind.Type

export const Direction = Schema.Struct({
  kind: DirectionKind,
  targetParticipantId: Schema.OptionFromNullOr(ParticipantId),
})
export interface Direction extends Schema.Schema.Type<typeof Direction> {}

export const Message = Schema.Struct({
  messageId: MessageId,
  authorId: ParticipantId,
  timestamp: EpochMilliseconds,
  content: Schema.String.check(Schema.isMaxLength(16_384)),
  replyToMessageId: Schema.OptionFromNullOr(MessageId),
  isSelf: Schema.Boolean,
  directedToYokai: Schema.Boolean,
})
export interface Message extends Schema.Schema.Type<typeof Message> {}

export const MessageReference = Schema.Struct({
  messageId: MessageId,
  authorId: ParticipantId,
  isSelf: Schema.Boolean,
})
export interface MessageReference extends Schema.Schema.Type<typeof MessageReference> {}

export const OpenQuestion = Schema.Struct({
  messageId: MessageId,
  authorId: ParticipantId,
})
export interface OpenQuestion extends Schema.Schema.Type<typeof OpenQuestion> {}

export const ThreadState = Schema.Struct({
  id: ThreadId,
  summary: TopicSummary,
  participants: Schema.Array(ParticipantId).check(Schema.isMaxLength(MAX_THREAD_PARTICIPANTS)),
  mode: Mode,
  activity: Activity,
  lastActiveAt: EpochMilliseconds,
  messageCount: Schema.Int.check(Schema.isGreaterThan(0)),
  recentMessages: Schema.Array(MessageReference).check(Schema.isMaxLength(MAX_THREAD_MESSAGES)),
  keywords: Schema.Array(Keyword).check(Schema.isMaxLength(MAX_THREAD_KEYWORDS)),
  openQuestion: Schema.OptionFromNullOr(OpenQuestion),
  sufficientResponse: Schema.Boolean,
})
export interface ThreadState extends Schema.Schema.Type<typeof ThreadState> {}

export const ThreadDigest = Schema.Struct({
  id: ThreadId,
  summary: TopicSummary,
  participants: Schema.Array(ParticipantId).check(Schema.isMaxLength(MAX_THREAD_PARTICIPANTS)),
  mode: Mode,
  messageCount: Schema.Int.check(Schema.isGreaterThan(0)),
  expiredAt: EpochMilliseconds,
})
export interface ThreadDigest extends Schema.Schema.Type<typeof ThreadDigest> {}

export const State = Schema.Struct({
  activeThreads: Schema.Array(ThreadState).check(Schema.isMaxLength(MAX_ACTIVE_THREADS)),
  recentDigests: Schema.Array(ThreadDigest).check(Schema.isMaxLength(MAX_THREAD_DIGESTS)),
})
export interface State extends Schema.Schema.Type<typeof State> {}

export const Scene = Schema.Struct({
  thread: ThreadState,
  activeThreadCount: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_ACTIVE_THREADS }),
  ),
  direction: Direction,
  interruptsOthers: Schema.Boolean,
  sufficientResponse: Schema.Boolean,
})
export interface Scene extends Schema.Schema.Type<typeof Scene> {}

export const Observation = Schema.Struct({
  state: State,
  scene: Scene,
})
export interface Observation extends Schema.Schema.Type<typeof Observation> {}

export const empty = (): State => State.make({ activeThreads: [], recentDigests: [] })
