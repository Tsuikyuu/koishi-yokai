import { NotebookModel } from '@yokai-internal/memory'
import { RoleStateModel, SceneUnderstanding } from '@yokai-internal/mind'
import type { PresetSnapshot } from 'yokai-protocol'
import { Data, Option } from 'effect'

import { ActivityGateValue } from '../../activity-gating/index'
import type { Observation, Options } from './model'

export type IntrinsicSource = 'persona-interest' | 'current-state' | 'self-memory'

export type Motivation = Data.TaggedEnum<{
  UnfinishedTopic: {
    readonly threadId: RoleStateModel.ThreadId
    readonly stateUpdatedAt: RoleStateModel.EpochMilliseconds
  }
  RelevantRecentContent: {
    readonly sourceMessageId: string
    readonly score: ActivityGateValue.Score
  }
  IntrinsicOpportunity: {
    readonly sources: ReadonlyArray<IntrinsicSource>
    readonly presetVersion: PresetSnapshot['version']
    readonly stateUpdatedAt: RoleStateModel.EpochMilliseconds
    readonly selfNoteIds: ReadonlyArray<NotebookModel.NoteId>
  }
}>

export const Motivation = Data.taggedEnum<Motivation>()

export interface Input {
  readonly observation: Observation
  readonly roleState: RoleStateModel.Snapshot
  readonly preset: PresetSnapshot
  readonly selfMemory: ReadonlyArray<NotebookModel.NoteEvidence>
  readonly now: number
}

const participantIds = (observation: Observation): ReadonlyArray<string> =>
  [observation.message.focus.authorId, ...observation.scene.thread.participants].filter(
    (participantId, index, participants) => participants.indexOf(participantId) === index,
  )

export const relationshipFamiliarity = (input: Input): Option.Option<RoleStateModel.Level> => {
  const participants = participantIds(input.observation)
  const relationships = input.roleState.relationships.filter((relationship) =>
    participants.includes(relationship.memberId),
  )
  if (relationships.length === 0) return Option.none()
  return Option.some(
    RoleStateModel.Level.make(
      Math.max(...relationships.map((relationship) => relationship.familiarity)),
    ),
  )
}

const personaKeywordRelevance = (input: Input): ActivityGateValue.Score => {
  const personaKeywords = input.preset.persona.interests.flatMap(SceneUnderstanding.keywordsOf)
  const matchingKeywords = input.observation.scene.thread.keywords.filter((keyword) =>
    personaKeywords.includes(keyword),
  )
  return ActivityGateValue.Score.make(matchingKeywords.length > 0 ? 1 : 0)
}

export const recentRelevance = (input: Input): ActivityGateValue.Score =>
  ActivityGateValue.Score.make(
    Math.max(
      input.observation.message.localState.threadOrInterestEvidence,
      personaKeywordRelevance(input),
    ),
  )

const currentStateIsExpressive = (state: RoleStateModel.RoleState): boolean =>
  state.currentInterests.length > 0 ||
  state.mood.arousal >= 0.25 ||
  Math.abs(state.mood.valence) >= 0.25

const intrinsicSources = (input: Input): ReadonlyArray<IntrinsicSource> => {
  const candidates: ReadonlyArray<readonly [IntrinsicSource, boolean]> = [
    ['persona-interest', input.preset.persona.interests.length > 0],
    ['current-state', currentStateIsExpressive(input.roleState.roleState)],
    ['self-memory', input.selfMemory.length > 0],
  ]
  return candidates.filter((candidate) => candidate[1]).map((candidate) => candidate[0])
}

const relationshipAllows = (input: Input, options: Options): boolean =>
  Option.match(relationshipFamiliarity(input), {
    onNone: () => false,
    onSome: (familiarity) => familiarity >= options.relationshipThreshold,
  })

const stateAllows = (input: Input, options: Options): boolean =>
  input.roleState.roleState.socialEnergy >= options.minSocialEnergy &&
  input.roleState.roleState.recentParticipation <= options.maxRecentParticipation

export const decide = (input: Input, options: Options): Option.Option<Motivation> => {
  if (!relationshipAllows(input, options) || !stateAllows(input, options)) {
    return Option.none()
  }

  const unfinished = input.roleState.roleState.unfinishedItems.at(-1)
  if (unfinished !== undefined) {
    return Option.some(
      Motivation.UnfinishedTopic({
        threadId: unfinished.threadId,
        stateUpdatedAt: input.roleState.updatedAt,
      }),
    )
  }

  const relevance = recentRelevance(input)
  const recentAgeMs = Math.max(0, input.now - input.observation.scene.thread.lastActiveAt)
  if (recentAgeMs <= options.recentWindowMs && relevance >= options.recentRelevanceThreshold) {
    return Option.some(
      Motivation.RelevantRecentContent({
        sourceMessageId: input.observation.message.focus.messageId,
        score: relevance,
      }),
    )
  }

  const sources = intrinsicSources(input)
  return sources.length === 0
    ? Option.none()
    : Option.some(
        Motivation.IntrinsicOpportunity({
          sources,
          presetVersion: input.preset.version,
          stateUpdatedAt: input.roleState.updatedAt,
          selfNoteIds: input.selfMemory.map((evidence) => evidence.noteId),
        }),
      )
}

const sameValues = <A>(left: ReadonlyArray<A>, right: ReadonlyArray<A>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

export const sameAdmissionEvidence = (left: Motivation, right: Motivation): boolean => {
  if (left._tag !== right._tag) return false
  switch (left._tag) {
    case 'UnfinishedTopic':
      return right._tag === 'UnfinishedTopic' && left.threadId === right.threadId
    case 'RelevantRecentContent':
      return (
        right._tag === 'RelevantRecentContent' &&
        left.sourceMessageId === right.sourceMessageId &&
        left.score === right.score
      )
    case 'IntrinsicOpportunity':
      return (
        right._tag === 'IntrinsicOpportunity' &&
        left.presetVersion === right.presetVersion &&
        sameValues(left.sources, right.sources) &&
        sameValues(left.selfNoteIds, right.selfNoteIds)
      )
  }
}

export * as InitiativePolicy from './policy'
