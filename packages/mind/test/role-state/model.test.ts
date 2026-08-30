import { expect, it } from '@effect/vitest'

import { RoleStateModel } from '../../src/index'

it('bounds every identifier, numeric value, and collection at the schema boundary', () => {
  expect(() => RoleStateModel.InteractionId.make('x'.repeat(1_025))).toThrow()
  expect(() => RoleStateModel.InteractionId.make('member:\u0000')).toThrow()
  expect(() => RoleStateModel.Level.make(-0.01)).toThrow()
  expect(() => RoleStateModel.Level.make(1.01)).toThrow()
  expect(() => RoleStateModel.SignedLevel.make(-1.01)).toThrow()
  expect(() => RoleStateModel.SignedLevel.make(1.01)).toThrow()
  expect(() => RoleStateModel.SentSegmentCount.make(0)).toThrow()
  expect(() => RoleStateModel.SentSegmentCount.make(5)).toThrow()

  const state = RoleStateModel.emptyRoleState()
  const interests = Array.from({ length: RoleStateModel.MAX_CURRENT_INTERESTS + 1 }, (_, index) =>
    RoleStateModel.Interest.make(`topic-${index}`),
  )
  expect(() => RoleStateModel.RoleState.make({ ...state, currentInterests: interests })).toThrow()

  const snapshot = RoleStateModel.empty(0)
  const appliedInteractionIds = Array.from(
    { length: RoleStateModel.MAX_APPLIED_INTERACTION_IDS + 1 },
    (_, index) => RoleStateModel.InteractionId.make(`interaction-${index}`),
  )
  expect(() => RoleStateModel.Snapshot.make({ ...snapshot, appliedInteractionIds })).toThrow()
})

it('accepts prefixed stable interaction IDs at the documented bound', () => {
  const prefix = 'reply:initiative:'
  const messageId = 'm'.repeat(RoleStateModel.MAX_INTERACTION_ID_LENGTH - prefix.length)
  expect(RoleStateModel.InteractionId.make(prefix + messageId)).toHaveLength(
    RoleStateModel.MAX_INTERACTION_ID_LENGTH,
  )
})
