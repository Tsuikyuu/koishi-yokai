import { expect, it } from '@effect/vitest'
import { RoleStateModel, SceneUnderstanding, ThreadScene } from '@yokai-internal/mind'
import { Option } from 'effect'

import { RoleStateSignals } from '../../src/index'

const scene = (messageId: string, content: string) =>
  SceneUnderstanding.observe(
    ThreadScene.empty(),
    ThreadScene.Message.make({
      messageId: ThreadScene.MessageId.make(messageId),
      authorId: ThreadScene.ParticipantId.make('alice'),
      timestamp: ThreadScene.EpochMilliseconds.make(0),
      content,
      replyToMessageId: Option.none(),
      isSelf: false,
      directedToYokai: false,
    }),
    0,
  ).scene

it('derives bounded local gate signals from the pre-interaction snapshot', () => {
  const currentScene = scene('current', 'shared topic?')
  const keyword = currentScene.thread.keywords[0]
  if (keyword === undefined) {
    expect(keyword).toBeDefined()
    return
  }
  const empty = RoleStateModel.empty(0)
  const snapshot = RoleStateModel.Snapshot.make({
    ...empty,
    roleState: RoleStateModel.RoleState.make({
      ...empty.roleState,
      currentInterests: [RoleStateModel.Interest.make(keyword)],
      activeThreadIds: [currentScene.thread.id],
      unfinishedItems: [
        RoleStateModel.UnfinishedItem.make({
          threadId: currentScene.thread.id,
          summary: currentScene.thread.summary,
        }),
      ],
      recentParticipation: RoleStateModel.Level.make(0.6),
    }),
  })

  const signals = RoleStateSignals.localSignals(snapshot, currentScene)
  expect(signals.unfinishedItemEvidence).toBe(1)
  expect(signals.threadOrInterestEvidence).toBe(1.25)
  expect(signals.recentParticipationPressure).toBe(0.6)
  expect(signals.sufficientResponsePressure).toBe(0)

  const unrelated = RoleStateSignals.localSignals(snapshot, scene('other', 'unrelated subject'))
  expect(unrelated.unfinishedItemEvidence).toBe(0.25)
  expect(unrelated.threadOrInterestEvidence).toBe(0)
})
