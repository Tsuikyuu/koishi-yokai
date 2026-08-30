import { expect, it } from '@effect/vitest'
import { RoleStateModel, SceneUnderstanding, ThreadScene } from '@yokai-internal/mind'
import { CapabilityScope } from 'yokai-protocol'
import { Context, Effect, HashMap, Layer, Option, Ref } from 'effect'
import { TestClock } from 'effect/testing'

import { RoleState, RoleStateStorage } from '../../src/index'

const SCOPE = CapabilityScope.make({
  instanceId: 'role-state-test',
  platform: 'test',
  guildId: 'guild',
  channelId: 'channel',
})

const ALICE = RoleStateModel.MemberId.make('alice')
const BOB = RoleStateModel.MemberId.make('bob')

const scopeKey = (scope: CapabilityScope): string =>
  JSON.stringify([scope.instanceId, scope.platform, scope.guildId, scope.channelId])

const mergeRelationships = (
  stored: ReadonlyArray<RoleStateModel.Relationship>,
  incoming: ReadonlyArray<RoleStateModel.Relationship>,
): ReadonlyArray<RoleStateModel.Relationship> => [
  ...stored.filter(
    (relationship) => !incoming.some((candidate) => candidate.memberId === relationship.memberId),
  ),
  ...incoming,
]

interface TestStorageInterface extends RoleStateStorage.Interface {
  readonly setLoadFailure: (fail: boolean) => Effect.Effect<void>
  readonly saveCount: () => Effect.Effect<number>
}

class TestStorage extends Context.Service<TestStorage, TestStorageInterface>()(
  '@yokai/core/test/RoleStateStorage',
) {}

const testStorageLayer = Layer.effectContext(
  Effect.gen(function* () {
    const snapshots = yield* Ref.make<HashMap.HashMap<string, RoleStateModel.Snapshot>>(
      HashMap.empty(),
    )
    const writes = yield* Ref.make(0)
    const loadFailure = yield* Ref.make(false)

    const service = TestStorage.of({
      load: Effect.fn('TestRoleStateStorage.load')(function* (
        scope: CapabilityScope,
        memberIds: ReadonlyArray<string>,
      ) {
        if (yield* Ref.get(loadFailure)) {
          return yield* Effect.fail(
            new RoleStateStorage.StorageError({ operation: 'load', cause: 'test load failure' }),
          )
        }
        return Option.map(
          yield* Ref.get(snapshots).pipe(Effect.map(HashMap.get(scopeKey(scope)))),
          (snapshot) =>
            RoleStateModel.Snapshot.make({
              ...snapshot,
              relationships: snapshot.relationships.filter((relationship) =>
                memberIds.includes(relationship.memberId),
              ),
            }),
        )
      }),
      save: Effect.fn('TestRoleStateStorage.save')(function* (
        scope: CapabilityScope,
        snapshot: RoleStateModel.Snapshot,
      ) {
        yield* Ref.update(snapshots, (current) => {
          const stored = HashMap.get(current, scopeKey(scope))
          const merged = Option.match(stored, {
            onNone: () => snapshot,
            onSome: (value) =>
              RoleStateModel.Snapshot.make({
                ...snapshot,
                relationships: mergeRelationships(value.relationships, snapshot.relationships),
              }),
          })
          return HashMap.set(current, scopeKey(scope), merged)
        })
        yield* Ref.update(writes, (count) => count + 1)
      }),
      setLoadFailure: (fail) => Ref.set(loadFailure, fail),
      saveCount: () => Ref.get(writes),
    })

    return Context.empty().pipe(
      Context.add(RoleStateStorage.Service, service),
      Context.add(TestStorage, service),
    )
  }),
)

const serviceLayer = (parameters = RoleStateModel.defaultParameters()) =>
  RoleState.layer({ parameters }).pipe(Layer.provideMerge(testStorageLayer))

const scene = (messageId: string, memberId: RoleStateModel.MemberId, content: string) =>
  SceneUnderstanding.observe(
    ThreadScene.empty(),
    ThreadScene.Message.make({
      messageId: ThreadScene.MessageId.make(messageId),
      authorId: memberId,
      timestamp: ThreadScene.EpochMilliseconds.make(0),
      content,
      replyToMessageId: Option.none(),
      isSelf: false,
      directedToYokai: true,
    }),
    0,
  ).scene

const relationship = (
  snapshot: RoleStateModel.Snapshot,
  memberId: RoleStateModel.MemberId,
): Effect.Effect<RoleStateModel.Relationship> => {
  const found = snapshot.relationships.find((candidate) => candidate.memberId === memberId)
  return found === undefined
    ? Effect.die(`Missing relationship for ${memberId}`)
    : Effect.succeed(found)
}

it.effect('serializes concurrent updates and keeps A-B-A replays idempotent', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const roleState = yield* RoleState.Service
    const storage = yield* TestStorage
    const aliceScene = scene('alice-message', ALICE, 'shared topic?')
    const aliceObservation: RoleState.MemberObservation = {
      scope: SCOPE,
      messageId: 'alice-message',
      memberId: ALICE,
      scene: aliceScene,
    }

    yield* Effect.all([roleState.observe(aliceObservation), roleState.observe(aliceObservation)], {
      concurrency: 'unbounded',
    })
    yield* roleState.observe({
      scope: SCOPE,
      messageId: 'bob-message',
      memberId: BOB,
      scene: scene('bob-message', BOB, 'another topic?'),
    })
    yield* roleState.observe(aliceObservation)

    const snapshot = yield* roleState.snapshot(SCOPE, [ALICE, BOB])
    const alice = yield* relationship(snapshot, ALICE)
    const bob = yield* relationship(snapshot, BOB)
    expect(alice.familiarity).toBeCloseTo(RoleStateModel.defaultParameters().maxFamiliarityDelta)
    expect(bob.familiarity).toBeCloseTo(RoleStateModel.defaultParameters().maxFamiliarityDelta)
    expect(snapshot.appliedInteractionIds).toEqual([
      RoleState.memberInteractionId('alice-message'),
      RoleState.memberInteractionId('bob-message'),
    ])
    expect(yield* storage.saveCount()).toBe(2)
  }).pipe(Effect.provide(serviceLayer())),
)

it.effect('materializes energy recovery and recent-participation decay with TestClock', () => {
  const halfLife = RoleStateModel.DecayHalfLifeMilliseconds.make(1_000)
  const parameters = RoleStateModel.Parameters.make({
    ...RoleStateModel.defaultParameters(),
    moodHalfLifeMs: halfLife,
    recentParticipationHalfLifeMs: halfLife,
    socialEnergyRecoveryHalfLifeMs: halfLife,
  })
  return Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const roleState = yield* RoleState.Service
    const updated = yield* roleState.recordSuccessfulTurn({
      scope: SCOPE,
      focusMessageId: 'focus',
      kind: 'direct',
      submittedAt: 0,
      threadId: Option.none(),
      sentSegments: RoleStateModel.SentSegmentCount.make(1),
    })
    expect(updated.roleState.socialEnergy).toBeCloseTo(0.85)
    expect(updated.roleState.recentParticipation).toBeCloseTo(0.2)

    yield* TestClock.adjust(1_000)
    const projected = yield* roleState.snapshot(SCOPE, [])
    expect(projected.roleState.socialEnergy).toBeCloseTo(0.925)
    expect(projected.roleState.recentParticipation).toBeCloseTo(0.1)
    expect(yield* roleState.materialize(projected)).toEqual(projected)
  }).pipe(Effect.provide(serviceLayer(parameters)))
})

it.effect('logs and preserves typed load failures from snapshots and updates', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(5_000)
    const roleState = yield* RoleState.Service
    const storage = yield* TestStorage
    yield* storage.setLoadFailure(true)

    const snapshotFailure = yield* roleState.snapshot(SCOPE, [ALICE]).pipe(Effect.flip)
    expect(snapshotFailure._tag).toBe('RoleStateStorageError')
    expect(snapshotFailure.operation).toBe('load')

    const updateFailure = yield* roleState
      .observe({
        scope: SCOPE,
        messageId: 'failed-message',
        memberId: ALICE,
        scene: scene('failed-message', ALICE, 'failure?'),
      })
      .pipe(Effect.flip)
    expect(updateFailure._tag).toBe('RoleStateStorageError')
    expect(updateFailure.operation).toBe('load')
  }).pipe(Effect.provide(serviceLayer())),
)
