import { Option } from 'effect'

import * as ThreadScene from '../scene/model'
import {
  EpochMilliseconds,
  Interaction,
  InteractionId,
  Interest,
  Level,
  MAX_ACTIVE_THREAD_IDS,
  MAX_APPLIED_INTERACTION_IDS,
  MAX_CURRENT_INTERESTS,
  MAX_RELATIONSHIPS,
  MAX_SHARED_TOPICS,
  MAX_UNFINISHED_ITEMS,
  Mood,
  Relationship,
  RoleState,
  SignedLevel,
  Snapshot,
  UnfinishedItem,
  emptyRelationship,
  type MemberInteraction,
  type Parameters,
  type RoleReply,
} from './model'

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value))

const level = (value: number): Level => Level.make(clamp(value, 0, 1))
const signedLevel = (value: number): SignedLevel => SignedLevel.make(clamp(value, -1, 1))

const elapsedSince = (updatedAt: EpochMilliseconds, now: number): number =>
  Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, now) - updatedAt)

const decayFactor = (elapsed: number, halfLifeMs: number): number => 2 ** (-elapsed / halfLifeMs)

const recoveredEnergy = (energy: Level, elapsed: number, halfLifeMs: number): Level => {
  const remainingDeficit = (1 - energy) * decayFactor(elapsed, halfLifeMs)
  return level(1 - remainingDeficit)
}

const advancedRoleState = (
  state: RoleState,
  elapsed: number,
  parameters: Parameters,
): RoleState => {
  const moodFactor = decayFactor(elapsed, parameters.moodHalfLifeMs)
  const participationFactor = decayFactor(elapsed, parameters.recentParticipationHalfLifeMs)
  return RoleState.make({
    ...state,
    mood: Mood.make({
      valence: signedLevel(state.mood.valence * moodFactor),
      arousal: level(state.mood.arousal * moodFactor),
    }),
    socialEnergy: recoveredEnergy(
      state.socialEnergy,
      elapsed,
      parameters.socialEnergyRecoveryHalfLifeMs,
    ),
    recentParticipation: level(state.recentParticipation * participationFactor),
  })
}

export const advance = (snapshot: Snapshot, now: number, parameters: Parameters): Snapshot => {
  const nextNow = Math.max(snapshot.updatedAt, Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, now)))
  const elapsed = elapsedSince(snapshot.updatedAt, nextNow)
  if (elapsed === 0) return snapshot
  return Snapshot.make({
    ...snapshot,
    roleState: advancedRoleState(snapshot.roleState, elapsed, parameters),
    updatedAt: EpochMilliseconds.make(nextNow),
  })
}

const appendBoundedUnique = <A>(
  values: ReadonlyArray<A>,
  incoming: ReadonlyArray<A>,
  maximumLength: number,
): ReadonlyArray<A> => {
  const appended = incoming.reduce<ReadonlyArray<A>>(
    (current, value) => [...current.filter((candidate) => candidate !== value), value],
    values,
  )
  return appended.slice(-maximumLength)
}

const interestsOf = (scene: ThreadScene.Scene): ReadonlyArray<Interest> =>
  scene.thread.keywords.map((keyword) => Interest.make(keyword))

const unfinishedAfterScene = (
  items: ReadonlyArray<UnfinishedItem>,
  scene: ThreadScene.Scene,
): ReadonlyArray<UnfinishedItem> => {
  const retained = items.filter((item) => item.threadId !== scene.thread.id)
  if (scene.sufficientResponse) return retained
  if (scene.direction.kind !== 'yokai' || Option.isNone(scene.thread.openQuestion)) return items
  return [
    ...retained,
    UnfinishedItem.make({ threadId: scene.thread.id, summary: scene.thread.summary }),
  ].slice(-MAX_UNFINISHED_ITEMS)
}

interface MoodImpulse {
  readonly valence: number
  readonly arousal: number
}

const moodImpulse = (mode: ThreadScene.Mode, parameters: Parameters): MoodImpulse => {
  switch (mode) {
    case 'joke':
      return {
        valence: parameters.maxMoodValenceDelta,
        arousal: parameters.maxMoodArousalDelta * 0.5,
      }
    case 'dispute':
      return {
        valence: -parameters.maxMoodValenceDelta * 0.75,
        arousal: parameters.maxMoodArousalDelta,
      }
    case 'confiding':
      return {
        valence: -parameters.maxMoodValenceDelta * 0.25,
        arousal: parameters.maxMoodArousalDelta * 0.35,
      }
    case 'question':
      return { valence: 0, arousal: parameters.maxMoodArousalDelta * 0.3 }
    case 'notice':
      return { valence: 0, arousal: parameters.maxMoodArousalDelta * 0.2 }
    case 'chat':
      return {
        valence: parameters.maxMoodValenceDelta * 0.1,
        arousal: parameters.maxMoodArousalDelta * 0.1,
      }
  }
}

const familiarityWeight = (direction: ThreadScene.DirectionKind): number => {
  switch (direction) {
    case 'yokai':
      return 1
    case 'participant':
      return 0.5
    case 'group':
      return 0.25
  }
}

const depthWeight = (mode: ThreadScene.Mode): number => {
  switch (mode) {
    case 'confiding':
      return 1
    case 'dispute':
      return 0.75
    case 'question':
      return 0.5
    case 'joke':
      return 0.35
    case 'chat':
      return 0.2
    case 'notice':
      return 0.1
  }
}

const updatedRelationship = (
  relationship: Relationship,
  interaction: MemberInteraction,
  now: number,
  parameters: Parameters,
): Relationship => {
  const interests = interestsOf(interaction.scene)
  return Relationship.make({
    ...relationship,
    familiarity: level(
      relationship.familiarity +
        parameters.maxFamiliarityDelta * familiarityWeight(interaction.scene.direction.kind),
    ),
    interactionDepth: level(
      relationship.interactionDepth +
        parameters.maxInteractionDepthDelta * depthWeight(interaction.scene.thread.mode),
    ),
    sharedTopics: appendBoundedUnique(relationship.sharedTopics, interests, MAX_SHARED_TOPICS),
    lastInteractionAt: EpochMilliseconds.make(
      Math.max(relationship.lastInteractionAt, Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, now))),
    ),
  })
}

const relationshipAfterInteraction = (
  relationships: ReadonlyArray<Relationship>,
  interaction: MemberInteraction,
  now: number,
  parameters: Parameters,
): ReadonlyArray<Relationship> => {
  const existing = relationships.find(
    (relationship) => relationship.memberId === interaction.memberId,
  )
  const relationship = updatedRelationship(
    existing === undefined ? emptyRelationship(interaction.memberId, now) : existing,
    interaction,
    now,
    parameters,
  )
  return [
    ...relationships.filter((candidate) => candidate.memberId !== interaction.memberId),
    relationship,
  ].slice(-MAX_RELATIONSHIPS)
}

const applyMemberInteraction = (
  snapshot: Snapshot,
  interaction: MemberInteraction,
  now: number,
  parameters: Parameters,
): Snapshot => {
  const interests = interestsOf(interaction.scene)
  const impulse = moodImpulse(interaction.scene.thread.mode, parameters)
  return Snapshot.make({
    ...snapshot,
    roleState: RoleState.make({
      ...snapshot.roleState,
      mood: Mood.make({
        valence: signedLevel(snapshot.roleState.mood.valence + impulse.valence),
        arousal: level(snapshot.roleState.mood.arousal + impulse.arousal),
      }),
      currentInterests: appendBoundedUnique(
        snapshot.roleState.currentInterests,
        interests,
        MAX_CURRENT_INTERESTS,
      ),
      activeThreadIds: appendBoundedUnique(
        snapshot.roleState.activeThreadIds,
        [interaction.scene.thread.id],
        MAX_ACTIVE_THREAD_IDS,
      ),
      unfinishedItems: unfinishedAfterScene(snapshot.roleState.unfinishedItems, interaction.scene),
    }),
    relationships: relationshipAfterInteraction(
      snapshot.relationships,
      interaction,
      now,
      parameters,
    ),
  })
}

const unresolvedThread = (
  items: ReadonlyArray<UnfinishedItem>,
  threadId: Option.Option<ThreadScene.ThreadId>,
): ReadonlyArray<UnfinishedItem> =>
  Option.match(threadId, {
    onNone: () => items,
    onSome: (resolved) => items.filter((item) => item.threadId !== resolved),
  })

const applyRoleReply = (
  snapshot: Snapshot,
  interaction: RoleReply,
  parameters: Parameters,
): Snapshot =>
  Snapshot.make({
    ...snapshot,
    roleState: RoleState.make({
      ...snapshot.roleState,
      socialEnergy: level(snapshot.roleState.socialEnergy - parameters.maxSocialEnergyDelta),
      recentParticipation: level(
        snapshot.roleState.recentParticipation + parameters.maxRecentParticipationDelta,
      ),
      unfinishedItems: unresolvedThread(snapshot.roleState.unfinishedItems, interaction.threadId),
    }),
  })

const markApplied = (snapshot: Snapshot, interactionId: InteractionId): Snapshot =>
  Snapshot.make({
    ...snapshot,
    appliedInteractionIds: appendBoundedUnique(
      snapshot.appliedInteractionIds,
      [interactionId],
      MAX_APPLIED_INTERACTION_IDS,
    ),
  })

export const update = (
  snapshot: Snapshot,
  interaction: Interaction,
  now: number,
  parameters: Parameters,
): Snapshot => {
  const current = advance(snapshot, now, parameters)
  if (snapshot.appliedInteractionIds.includes(interaction.interactionId)) return current
  const changed = Interaction.match(interaction, {
    MemberInteraction: (memberInteraction) =>
      applyMemberInteraction(current, memberInteraction, now, parameters),
    RoleReply: (roleReply) => applyRoleReply(current, roleReply, parameters),
  })
  return markApplied(changed, interaction.interactionId)
}
