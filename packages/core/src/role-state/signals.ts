import { RoleStateModel, type ThreadScene } from '@yokai-internal/mind'

import { ActivityGateValue } from '../activity-gating/index'
import { WakeMessage } from '../wake/message'

export const CURRENT_UNFINISHED_ITEM_EVIDENCE = ActivityGateValue.Score.make(1)
export const OTHER_UNFINISHED_ITEM_EVIDENCE = ActivityGateValue.Score.make(0.25)
export const ACTIVE_THREAD_EVIDENCE = ActivityGateValue.Score.make(0.75)
export const SHARED_INTEREST_EVIDENCE = ActivityGateValue.Score.make(0.5)

const unfinishedItemEvidence = (
  snapshot: RoleStateModel.Snapshot,
  scene: ThreadScene.Scene,
): ActivityGateValue.Score => {
  const matchesCurrentThread = snapshot.roleState.unfinishedItems.some(
    (item) => item.threadId === scene.thread.id,
  )
  if (matchesCurrentThread) return CURRENT_UNFINISHED_ITEM_EVIDENCE
  return snapshot.roleState.unfinishedItems.length === 0
    ? ActivityGateValue.Score.make(0)
    : OTHER_UNFINISHED_ITEM_EVIDENCE
}

const threadOrInterestEvidence = (
  snapshot: RoleStateModel.Snapshot,
  scene: ThreadScene.Scene,
): ActivityGateValue.Score => {
  const activeThread = snapshot.roleState.activeThreadIds.includes(scene.thread.id)
  const sharedInterest = scene.thread.keywords.some((keyword) =>
    snapshot.roleState.currentInterests.includes(RoleStateModel.Interest.make(keyword)),
  )
  return ActivityGateValue.Score.make(
    (activeThread ? ACTIVE_THREAD_EVIDENCE : 0) + (sharedInterest ? SHARED_INTEREST_EVIDENCE : 0),
  )
}

export const localSignals = (
  snapshot: RoleStateModel.Snapshot,
  scene: ThreadScene.Scene,
): WakeMessage.LocalStateSignals =>
  WakeMessage.LocalStateSignals.make({
    unfinishedItemEvidence: unfinishedItemEvidence(snapshot, scene),
    threadOrInterestEvidence: threadOrInterestEvidence(snapshot, scene),
    recentParticipationPressure: ActivityGateValue.Pressure.make(
      snapshot.roleState.recentParticipation,
    ),
    sufficientResponsePressure: ActivityGateValue.Pressure.make(scene.sufficientResponse ? 1 : 0),
  })

export * as RoleStateSignals from './signals'
