import { expect, it } from '@effect/vitest'
import { Option } from 'effect'

import { RoleStateModel, RoleStateReducer, ThreadScene } from '../../src/index'
import { memberInteraction, parameters, roleReply, scene } from './fixtures'

it('applies no interaction impulse beyond the configured maximum for any numeric axis', () => {
  const limits = parameters(0.05)
  const initial = RoleStateModel.empty(0)
  const observed = memberInteraction(
    'member:a',
    'alice',
    scene('thread:a', 'alice', 'dispute', 'yokai', ['topic-a'], true, false),
  )
  const afterMember = RoleStateReducer.update(initial, observed, 0, limits)
  const relationship = afterMember.relationships[0]
  if (relationship === undefined) throw new Error('Expected a relationship')

  expect(
    Math.abs(afterMember.roleState.mood.valence - initial.roleState.mood.valence),
  ).toBeLessThanOrEqual(limits.maxMoodValenceDelta)
  expect(
    Math.abs(afterMember.roleState.mood.arousal - initial.roleState.mood.arousal),
  ).toBeLessThanOrEqual(limits.maxMoodArousalDelta)
  expect(relationship.familiarity).toBeLessThanOrEqual(limits.maxFamiliarityDelta)
  expect(relationship.interactionDepth).toBeLessThanOrEqual(limits.maxInteractionDepthDelta)

  const afterReply = RoleStateReducer.update(
    afterMember,
    roleReply('reply:a', Option.some(ThreadScene.ThreadId.make('thread:a')), 4),
    0,
    limits,
  )
  expect(afterMember.roleState.socialEnergy - afterReply.roleState.socialEnergy).toBeCloseTo(
    limits.maxSocialEnergyDelta,
  )
  expect(
    afterReply.roleState.recentParticipation - afterMember.roleState.recentParticipation,
  ).toBeLessThanOrEqual(limits.maxRecentParticipationDelta)
  expect(afterReply.roleState.socialEnergy).toBeCloseTo(0.95)
  expect(afterReply.roleState.recentParticipation).toBeCloseTo(0.05)
})

it('decays only short-term state, recovers energy, and retains medium-term state', () => {
  const limits = parameters(0.05, 1_000)
  const base = RoleStateModel.empty(0)
  const relationship = RoleStateModel.Relationship.make({
    memberId: RoleStateModel.MemberId.make('alice'),
    familiarity: RoleStateModel.Level.make(0.6),
    interactionDepth: RoleStateModel.Level.make(0.7),
    preferredAddress: Option.some(RoleStateModel.PreferredAddress.make('A')),
    preferredStyle: Option.some('gentle'),
    sharedTopics: [RoleStateModel.Interest.make('topic')],
    boundaries: [RoleStateModel.Boundary.make('no spoilers')],
    lastInteractionAt: RoleStateModel.EpochMilliseconds.make(0),
  })
  const current = RoleStateModel.Snapshot.make({
    ...base,
    roleState: RoleStateModel.RoleState.make({
      mood: RoleStateModel.Mood.make({
        valence: RoleStateModel.SignedLevel.make(0.5),
        arousal: RoleStateModel.Level.make(0.8),
      }),
      socialEnergy: RoleStateModel.Level.make(0.2),
      currentInterests: [RoleStateModel.Interest.make('topic')],
      activeThreadIds: [ThreadScene.ThreadId.make('thread:a')],
      unfinishedItems: [
        RoleStateModel.UnfinishedItem.make({
          threadId: ThreadScene.ThreadId.make('thread:a'),
          summary: ThreadScene.TopicSummary.make('unfinished topic'),
        }),
      ],
      recentParticipation: RoleStateModel.Level.make(0.8),
    }),
    relationships: [relationship],
  })

  const advanced = RoleStateReducer.advance(current, 1_000, limits)
  expect(advanced.roleState.mood.valence).toBeCloseTo(0.25)
  expect(advanced.roleState.mood.arousal).toBeCloseTo(0.4)
  expect(advanced.roleState.recentParticipation).toBeCloseTo(0.4)
  expect(advanced.roleState.socialEnergy).toBeCloseTo(0.6)
  expect(advanced.roleState.currentInterests).toEqual(current.roleState.currentInterests)
  expect(advanced.roleState.activeThreadIds).toEqual(current.roleState.activeThreadIds)
  expect(advanced.roleState.unfinishedItems).toEqual(current.roleState.unfinishedItems)
  expect(advanced.relationships).toEqual(current.relationships)
})

it('is idempotent across A to B to A while allowing only time materialization on a late replay', () => {
  const limits = parameters()
  const first = memberInteraction(
    'member:a',
    'alice',
    scene('thread:a', 'alice', 'joke', 'group', ['alpha'], false, false),
  )
  const second = memberInteraction(
    'member:b',
    'bob',
    scene('thread:b', 'bob', 'question', 'group', ['beta'], false, false),
  )
  const afterFirst = RoleStateReducer.update(RoleStateModel.empty(0), first, 0, limits)
  const afterSecond = RoleStateReducer.update(afterFirst, second, 0, limits)
  const replayed = RoleStateReducer.update(afterSecond, first, 0, limits)

  expect(replayed).toEqual(afterSecond)
  expect(replayed.appliedInteractionIds).toEqual(['member:a', 'member:b'])

  const lateReplay = RoleStateReducer.update(afterSecond, first, 1_000, limits)
  expect(lateReplay).toEqual(RoleStateReducer.advance(afterSecond, 1_000, limits))
})

it('tracks only Yokai-directed open questions and resolves the matching thread', () => {
  const limits = parameters()
  const groupQuestion = memberInteraction(
    'member:group',
    'alice',
    scene('thread:group', 'alice', 'question', 'group', ['group-topic'], true, false),
  )
  const afterGroup = RoleStateReducer.update(RoleStateModel.empty(0), groupQuestion, 0, limits)
  expect(afterGroup.roleState.unfinishedItems).toEqual([])

  const directQuestion = memberInteraction(
    'member:direct',
    'alice',
    scene('thread:direct', 'alice', 'question', 'yokai', ['direct-topic'], true, false),
  )
  const pending = RoleStateReducer.update(afterGroup, directQuestion, 0, limits)
  expect(pending.roleState.unfinishedItems.map((item) => item.threadId)).toEqual(['thread:direct'])

  const replyWithoutScene = RoleStateReducer.update(
    pending,
    roleReply('reply:no-scene', Option.none()),
    0,
    limits,
  )
  expect(replyWithoutScene.roleState.unfinishedItems).toEqual(pending.roleState.unfinishedItems)
  expect(replyWithoutScene.roleState.socialEnergy).toBeLessThan(pending.roleState.socialEnergy)

  const replied = RoleStateReducer.update(
    replyWithoutScene,
    roleReply('reply:direct', Option.some(ThreadScene.ThreadId.make('thread:direct'))),
    0,
    limits,
  )
  expect(replied.roleState.unfinishedItems).toEqual([])

  const reopened = RoleStateReducer.update(
    replied,
    memberInteraction(
      'member:direct-again',
      'alice',
      scene('thread:direct', 'alice', 'question', 'yokai', ['direct-topic'], true, false),
    ),
    0,
    limits,
  )
  const answeredByGroup = RoleStateReducer.update(
    reopened,
    memberInteraction(
      'member:answered',
      'bob',
      scene('thread:direct', 'bob', 'question', 'participant', ['direct-topic'], true, true),
    ),
    0,
    limits,
  )
  expect(answeredByGroup.roleState.unfinishedItems).toEqual([])
})

it('bounds interests, threads, unfinished items, relationships, topics, and dedupe metadata', () => {
  const limits = parameters(0.01)
  const total = RoleStateModel.MAX_APPLIED_INTERACTION_IDS + 20
  const accumulated = Array.from({ length: total }, (_, index) => index).reduce(
    (snapshot, index) =>
      RoleStateReducer.update(
        snapshot,
        memberInteraction(
          `member:${index}`,
          `member-${index}`,
          scene(
            `thread:${index}`,
            `member-${index}`,
            'question',
            'yokai',
            [`topic-${index}`],
            true,
            false,
          ),
        ),
        0,
        limits,
      ),
    RoleStateModel.empty(0),
  )

  expect(accumulated.roleState.currentInterests).toHaveLength(RoleStateModel.MAX_CURRENT_INTERESTS)
  expect(accumulated.roleState.activeThreadIds).toHaveLength(RoleStateModel.MAX_ACTIVE_THREAD_IDS)
  expect(accumulated.roleState.unfinishedItems).toHaveLength(RoleStateModel.MAX_UNFINISHED_ITEMS)
  expect(accumulated.relationships).toHaveLength(RoleStateModel.MAX_RELATIONSHIPS)
  expect(accumulated.appliedInteractionIds).toHaveLength(RoleStateModel.MAX_APPLIED_INTERACTION_IDS)
  expect(accumulated.appliedInteractionIds).not.toContain('member:0')
  expect(accumulated.appliedInteractionIds).toContain(`member:${total - 1}`)

  const shared = Array.from(
    { length: RoleStateModel.MAX_SHARED_TOPICS + 4 },
    (_, index) => index,
  ).reduce(
    (snapshot, index) =>
      RoleStateReducer.update(
        snapshot,
        memberInteraction(
          `shared:${index}`,
          'shared-member',
          scene(
            `shared-thread:${index}`,
            'shared-member',
            'chat',
            'group',
            [`shared-${index}`],
            false,
            false,
          ),
        ),
        0,
        limits,
      ),
    RoleStateModel.empty(0),
  )
  const sharedRelationship = shared.relationships[0]
  if (sharedRelationship === undefined) throw new Error('Expected shared relationship')
  expect(sharedRelationship.sharedTopics).toHaveLength(RoleStateModel.MAX_SHARED_TOPICS)
  expect(sharedRelationship.sharedTopics[0]).toBe('shared-4')
})

it('keeps familiarity independent from other relationship dimensions and preferences', () => {
  const limits = parameters(0.05)
  const initial = RoleStateModel.empty(0)
  const shallow = RoleStateReducer.update(
    initial,
    memberInteraction(
      'member:notice',
      'alice',
      scene('thread:notice', 'alice', 'notice', 'yokai', ['status'], false, false),
    ),
    0,
    limits,
  )
  const deep = RoleStateReducer.update(
    initial,
    memberInteraction(
      'member:confiding',
      'bob',
      scene('thread:confiding', 'bob', 'confiding', 'yokai', ['feelings'], false, false),
    ),
    0,
    limits,
  )
  const shallowRelationship = shallow.relationships[0]
  const deepRelationship = deep.relationships[0]
  if (shallowRelationship === undefined || deepRelationship === undefined)
    throw new Error('Expected relationships')

  expect(shallowRelationship.familiarity).toBeCloseTo(deepRelationship.familiarity)
  expect(shallowRelationship.interactionDepth).toBeLessThan(deepRelationship.interactionDepth)
  expect(Option.isNone(shallowRelationship.preferredAddress)).toBe(true)
  expect(Option.isNone(shallowRelationship.preferredStyle)).toBe(true)
})
