import { Option } from 'effect'

import { RoleStateModel, ThreadScene } from '../../src/index'

export const parameters = (maximumDelta = 0.05, halfLifeMs = 1_000) =>
  RoleStateModel.Parameters.make({
    moodHalfLifeMs: RoleStateModel.DecayHalfLifeMilliseconds.make(halfLifeMs),
    recentParticipationHalfLifeMs: RoleStateModel.DecayHalfLifeMilliseconds.make(halfLifeMs),
    socialEnergyRecoveryHalfLifeMs: RoleStateModel.DecayHalfLifeMilliseconds.make(halfLifeMs),
    maxMoodValenceDelta: RoleStateModel.Level.make(maximumDelta),
    maxMoodArousalDelta: RoleStateModel.Level.make(maximumDelta),
    maxSocialEnergyDelta: RoleStateModel.Level.make(maximumDelta),
    maxRecentParticipationDelta: RoleStateModel.Level.make(maximumDelta),
    maxFamiliarityDelta: RoleStateModel.Level.make(maximumDelta),
    maxInteractionDepthDelta: RoleStateModel.Level.make(maximumDelta),
  })

export const scene = (
  threadId: string,
  memberId: string,
  mode: ThreadScene.Mode,
  direction: ThreadScene.DirectionKind,
  keywords: ReadonlyArray<string>,
  hasOpenQuestion: boolean,
  sufficientResponse: boolean,
): ThreadScene.Scene => {
  const typedMemberId = ThreadScene.ParticipantId.make(memberId)
  const typedThreadId = ThreadScene.ThreadId.make(threadId)
  const openQuestion = hasOpenQuestion
    ? Option.some(
        ThreadScene.OpenQuestion.make({
          messageId: ThreadScene.MessageId.make(`question:${threadId}`),
          authorId: typedMemberId,
        }),
      )
    : Option.none<ThreadScene.OpenQuestion>()
  const thread = ThreadScene.ThreadState.make({
    id: typedThreadId,
    summary: ThreadScene.TopicSummary.make(`summary ${threadId}`),
    participants: [typedMemberId],
    mode,
    activity: ThreadScene.Activity.make(1),
    lastActiveAt: ThreadScene.EpochMilliseconds.make(0),
    messageCount: 1,
    recentMessages: [
      ThreadScene.MessageReference.make({
        messageId: ThreadScene.MessageId.make(`message:${threadId}`),
        authorId: typedMemberId,
        isSelf: false,
      }),
    ],
    keywords: keywords.map((keyword) => ThreadScene.Keyword.make(keyword)),
    openQuestion,
    sufficientResponse,
  })
  return ThreadScene.Scene.make({
    thread,
    activeThreadCount: 1,
    direction: ThreadScene.Direction.make({
      kind: direction,
      targetParticipantId: Option.none(),
    }),
    interruptsOthers: false,
    sufficientResponse,
  })
}

export const memberInteraction = (
  interactionId: string,
  memberId: string,
  value: ThreadScene.Scene,
): RoleStateModel.MemberInteraction =>
  RoleStateModel.Interaction.cases.MemberInteraction.make({
    interactionId: RoleStateModel.InteractionId.make(interactionId),
    memberId: RoleStateModel.MemberId.make(memberId),
    scene: value,
  })

export const roleReply = (
  interactionId: string,
  threadId: Option.Option<ThreadScene.ThreadId>,
  sentSegments = 1,
): RoleStateModel.RoleReply =>
  RoleStateModel.Interaction.cases.RoleReply.make({
    interactionId: RoleStateModel.InteractionId.make(interactionId),
    threadId,
    sentSegments: RoleStateModel.SentSegmentCount.make(sentSegments),
  })
