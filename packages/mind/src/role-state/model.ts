import { Option, Schema } from 'effect'

import * as ThreadScene from '../scene/model'

export const MAX_INTERACTION_ID_LENGTH = 1_024
export const MAX_INTEREST_LENGTH = 64
export const MAX_ADDRESS_LENGTH = 64
export const MAX_BOUNDARY_LENGTH = 256
export const MAX_CURRENT_INTERESTS = 16
export const MAX_ACTIVE_THREAD_IDS = ThreadScene.MAX_ACTIVE_THREADS
export const MAX_UNFINISHED_ITEMS = 16
export const MAX_RELATIONSHIPS = 128
export const MAX_SHARED_TOPICS = 16
export const MAX_BOUNDARIES = 16
export const MAX_APPLIED_INTERACTION_IDS = 256
export const MAX_DECAY_HALF_LIFE_MS = 365 * 24 * 60 * 60 * 1_000

export const MemberId = ThreadScene.ParticipantId
export type MemberId = ThreadScene.ParticipantId

export const ThreadId = ThreadScene.ThreadId
export type ThreadId = ThreadScene.ThreadId

const Identifier = (maximumLength: number) =>
  Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(maximumLength),
    Schema.isPattern(/^[^\p{C}]+$/u),
  )

const BoundedText = (maximumLength: number) =>
  Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(maximumLength),
    Schema.isPattern(/^[^\p{C}]+$/u),
  )

export const InteractionId = Identifier(MAX_INTERACTION_ID_LENGTH).pipe(
  Schema.brand('@yokai/mind/RoleStateInteractionId'),
)
export type InteractionId = typeof InteractionId.Type

export const Interest = BoundedText(MAX_INTEREST_LENGTH).pipe(
  Schema.brand('@yokai/mind/RoleStateInterest'),
)
export type Interest = typeof Interest.Type

export const PreferredAddress = BoundedText(MAX_ADDRESS_LENGTH).pipe(
  Schema.brand('@yokai/mind/PreferredAddress'),
)
export type PreferredAddress = typeof PreferredAddress.Type

export const Boundary = BoundedText(MAX_BOUNDARY_LENGTH).pipe(
  Schema.brand('@yokai/mind/RelationshipBoundary'),
)
export type Boundary = typeof Boundary.Type

export const SignedLevel = Schema.Number.check(Schema.isBetween({ minimum: -1, maximum: 1 })).pipe(
  Schema.brand('@yokai/mind/RoleStateSignedLevel'),
)
export type SignedLevel = typeof SignedLevel.Type

export const Level = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(
  Schema.brand('@yokai/mind/RoleStateLevel'),
)
export type Level = typeof Level.Type

export const EpochMilliseconds = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
).pipe(Schema.brand('@yokai/mind/RoleStateEpochMilliseconds'))
export type EpochMilliseconds = typeof EpochMilliseconds.Type

export const DecayHalfLifeMilliseconds = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_DECAY_HALF_LIFE_MS }),
).pipe(Schema.brand('@yokai/mind/RoleStateDecayHalfLifeMilliseconds'))
export type DecayHalfLifeMilliseconds = typeof DecayHalfLifeMilliseconds.Type

export const SentSegmentCount = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })).pipe(
  Schema.brand('@yokai/mind/RoleStateSentSegmentCount'),
)
export type SentSegmentCount = typeof SentSegmentCount.Type

export const Mood = Schema.Struct({
  valence: SignedLevel,
  arousal: Level,
})
export interface Mood extends Schema.Schema.Type<typeof Mood> {}

export const UnfinishedItem = Schema.Struct({
  threadId: ThreadScene.ThreadId,
  summary: ThreadScene.TopicSummary,
})
export interface UnfinishedItem extends Schema.Schema.Type<typeof UnfinishedItem> {}

export const RoleState = Schema.Struct({
  mood: Mood,
  socialEnergy: Level,
  currentInterests: Schema.Array(Interest).check(Schema.isMaxLength(MAX_CURRENT_INTERESTS)),
  activeThreadIds: Schema.Array(ThreadScene.ThreadId).check(
    Schema.isMaxLength(MAX_ACTIVE_THREAD_IDS),
  ),
  unfinishedItems: Schema.Array(UnfinishedItem).check(Schema.isMaxLength(MAX_UNFINISHED_ITEMS)),
  recentParticipation: Level,
})
export interface RoleState extends Schema.Schema.Type<typeof RoleState> {}

export const PreferredStyle = Schema.Literals(['direct', 'gentle', 'playful'])
export type PreferredStyle = typeof PreferredStyle.Type

export const Relationship = Schema.Struct({
  memberId: ThreadScene.ParticipantId,
  familiarity: Level,
  interactionDepth: Level,
  preferredAddress: Schema.OptionFromNullOr(PreferredAddress),
  preferredStyle: Schema.OptionFromNullOr(PreferredStyle),
  sharedTopics: Schema.Array(Interest).check(Schema.isMaxLength(MAX_SHARED_TOPICS)),
  boundaries: Schema.Array(Boundary).check(Schema.isMaxLength(MAX_BOUNDARIES)),
  lastInteractionAt: EpochMilliseconds,
})
export interface Relationship extends Schema.Schema.Type<typeof Relationship> {}

export const Snapshot = Schema.Struct({
  roleState: RoleState,
  relationships: Schema.Array(Relationship).check(Schema.isMaxLength(MAX_RELATIONSHIPS)),
  appliedInteractionIds: Schema.Array(InteractionId).check(
    Schema.isMaxLength(MAX_APPLIED_INTERACTION_IDS),
  ),
  updatedAt: EpochMilliseconds,
})
export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}

export const Parameters = Schema.Struct({
  moodHalfLifeMs: DecayHalfLifeMilliseconds,
  recentParticipationHalfLifeMs: DecayHalfLifeMilliseconds,
  socialEnergyRecoveryHalfLifeMs: DecayHalfLifeMilliseconds,
  maxMoodValenceDelta: Level,
  maxMoodArousalDelta: Level,
  maxSocialEnergyDelta: Level,
  maxRecentParticipationDelta: Level,
  maxFamiliarityDelta: Level,
  maxInteractionDepthDelta: Level,
})
export interface Parameters extends Schema.Schema.Type<typeof Parameters> {}

export const Interaction = Schema.TaggedUnion({
  MemberInteraction: {
    interactionId: InteractionId,
    memberId: ThreadScene.ParticipantId,
    scene: ThreadScene.Scene,
  },
  RoleReply: {
    interactionId: InteractionId,
    threadId: Schema.OptionFromNullOr(ThreadScene.ThreadId),
    sentSegments: SentSegmentCount,
  },
})
export type Interaction = typeof Interaction.Type
export type MemberInteraction = typeof Interaction.cases.MemberInteraction.Type
export type RoleReply = typeof Interaction.cases.RoleReply.Type

export const DEFAULT_PARAMETERS = Parameters.make({
  moodHalfLifeMs: DecayHalfLifeMilliseconds.make(4 * 60 * 60 * 1_000),
  recentParticipationHalfLifeMs: DecayHalfLifeMilliseconds.make(30 * 60 * 1_000),
  socialEnergyRecoveryHalfLifeMs: DecayHalfLifeMilliseconds.make(2 * 60 * 60 * 1_000),
  maxMoodValenceDelta: Level.make(0.08),
  maxMoodArousalDelta: Level.make(0.1),
  maxSocialEnergyDelta: Level.make(0.15),
  maxRecentParticipationDelta: Level.make(0.2),
  maxFamiliarityDelta: Level.make(0.04),
  maxInteractionDepthDelta: Level.make(0.03),
})

export const defaultParameters = (): Parameters => DEFAULT_PARAMETERS

export const emptyRoleState = (): RoleState =>
  RoleState.make({
    mood: Mood.make({ valence: SignedLevel.make(0), arousal: Level.make(0) }),
    socialEnergy: Level.make(1),
    currentInterests: [],
    activeThreadIds: [],
    unfinishedItems: [],
    recentParticipation: Level.make(0),
  })

export const emptyRelationship = (memberId: ThreadScene.ParticipantId, now: number): Relationship =>
  Relationship.make({
    memberId,
    familiarity: Level.make(0),
    interactionDepth: Level.make(0),
    preferredAddress: Option.none(),
    preferredStyle: Option.none(),
    sharedTopics: [],
    boundaries: [],
    lastInteractionAt: EpochMilliseconds.make(Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, now))),
  })

export const empty = (now: number): Snapshot =>
  Snapshot.make({
    roleState: emptyRoleState(),
    relationships: [],
    appliedInteractionIds: [],
    updatedAt: EpochMilliseconds.make(Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, now))),
  })
