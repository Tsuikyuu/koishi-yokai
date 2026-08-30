import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SQLiteDriver } from '@minatojs/driver-sqlite'
import { RoleStateStorage } from '@yokai-internal/core'
import { RoleStateModel, ThreadScene } from '@yokai-internal/mind'
import { expect, it } from '@effect/vitest'
import { CapabilityScope } from 'yokai-protocol'
import { Effect, Option } from 'effect'
import { Context } from 'koishi'
import { vi } from 'vitest'

vi.mock('koishi', () => import('@koishijs/core'))

import { YokaiRoleStateModel } from '../../src/role-state/model'
import { KoishiRoleStateStorage } from '../../src/role-state/storage'

const scope = (
  instanceId = 'role-state-test',
  platform = 'test',
  guildId = 'guild',
  channelId = 'channel',
): CapabilityScope => CapabilityScope.make({ instanceId, platform, guildId, channelId })

const relationship = (
  memberId: string,
  updatedAt: number,
  preferredAddress: Option.Option<RoleStateModel.PreferredAddress> = Option.none(),
): RoleStateModel.Relationship =>
  RoleStateModel.Relationship.make({
    memberId: ThreadScene.ParticipantId.make(memberId),
    familiarity: RoleStateModel.Level.make(0.4),
    interactionDepth: RoleStateModel.Level.make(0.25),
    preferredAddress,
    preferredStyle: Option.none(),
    sharedTopics: [RoleStateModel.Interest.make(`topic-${memberId}`)],
    boundaries: [RoleStateModel.Boundary.make(`boundary-${memberId}`)],
    lastInteractionAt: RoleStateModel.EpochMilliseconds.make(updatedAt),
  })

const snapshot = (
  updatedAt: number,
  relationships: ReadonlyArray<RoleStateModel.Relationship>,
  valence = 0.25,
): RoleStateModel.Snapshot => {
  const initial = RoleStateModel.empty(updatedAt)
  return RoleStateModel.Snapshot.make({
    ...initial,
    roleState: RoleStateModel.RoleState.make({
      ...initial.roleState,
      mood: RoleStateModel.Mood.make({
        valence: RoleStateModel.SignedLevel.make(valence),
        arousal: RoleStateModel.Level.make(0.5),
      }),
      socialEnergy: RoleStateModel.Level.make(0.75),
      currentInterests: [RoleStateModel.Interest.make('folklore')],
      activeThreadIds: [ThreadScene.ThreadId.make('thread:current')],
      unfinishedItems: [
        RoleStateModel.UnfinishedItem.make({
          threadId: ThreadScene.ThreadId.make('thread:unfinished'),
          summary: ThreadScene.TopicSummary.make('unfinished topic'),
        }),
      ],
      recentParticipation: RoleStateModel.Level.make(0.3),
    }),
    relationships,
    appliedInteractionIds: [RoleStateModel.InteractionId.make(`interaction:${updatedAt}`)],
  })
}

const databaseContext = (path: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const ctx = yield* Effect.sync(() => {
        const context = new Context()
        YokaiRoleStateModel.define(context)
        context.plugin(SQLiteDriver, { path })
        return context
      })
      yield* Effect.promise(() => ctx.start())
      return ctx
    }),
    (ctx) => Effect.promise(() => ctx.stop()),
  )

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), 'yokai-role-state-'))),
  (directory) => Effect.tryPromise(() => rm(directory, { recursive: true, force: true })),
)

it.effect('atomically upserts schema payloads and retains relationships omitted from a save', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* databaseContext(':memory:')
      const channelScope = scope()
      const alice = relationship(
        'alice',
        1_000,
        Option.some(RoleStateModel.PreferredAddress.make('小爱')),
      )
      const bob = relationship('bob', 2_000)
      const first = snapshot(2_000, [alice])
      const second = snapshot(3_000, [bob], -0.2)
      const transaction = vi.spyOn(ctx.database, 'transact')

      const program = Effect.gen(function* () {
        const storage = yield* RoleStateStorage.Service
        yield* storage.save(channelScope, first)
        yield* Effect.all(
          [storage.save(channelScope, second), storage.save(channelScope, second)],
          {
            discard: true,
          },
        )
        return yield* storage.load(channelScope, ['alice', 'bob', 'alice'])
      }).pipe(Effect.provide(KoishiRoleStateStorage.layer(ctx)))

      const loaded = yield* program
      if (Option.isNone(loaded)) return yield* Effect.die('Expected a stored role-state snapshot')
      expect(loaded.value.roleState.mood.valence).toBe(-0.2)
      expect(loaded.value.relationships.map((entry) => entry.memberId)).toEqual(['alice', 'bob'])
      const loadedAlice = loaded.value.relationships.find((entry) => entry.memberId === 'alice')
      if (loadedAlice === undefined) return yield* Effect.die('Expected the Alice relationship')
      expect(Option.getOrUndefined(loadedAlice.preferredAddress)).toBe('小爱')
      expect(Option.isNone(loadedAlice.preferredStyle)).toBe(true)
      expect(transaction).toHaveBeenCalledTimes(3)

      const channelRows = yield* Effect.promise(() => ctx.database.get('yokai_channel_state', {}))
      const memberRows = yield* Effect.promise(() => ctx.database.get('yokai_member_state', {}))
      expect(channelRows).toHaveLength(1)
      expect(memberRows).toHaveLength(2)
      const channelRow = channelRows[0]
      if (channelRow === undefined) return yield* Effect.die('Expected the channel state row')
      expect(channelRow.updatedAt).toBeInstanceOf(Date)
      expect(channelRow.updatedAt.getTime()).toBe(3_000)
      const aliceRow = memberRows.find((row) => row.memberId === 'alice')
      if (aliceRow === undefined) return yield* Effect.die('Expected the Alice relationship row')
      expect(aliceRow.updatedAt.getTime()).toBe(1_000)
      expect(JSON.parse(aliceRow.payload)).toMatchObject({
        memberId: 'alice',
        preferredAddress: '小爱',
        preferredStyle: null,
      })
    }),
  ),
)

it.effect('isolates every scope dimension and member projection', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* databaseContext(':memory:')
      const primaryScope = scope('one', 'test', 'guild', 'channel')
      const scopes = [
        primaryScope,
        scope('two', 'test', 'guild', 'channel'),
        scope('one', 'other-platform', 'guild', 'channel'),
        scope('one', 'test', 'other-guild', 'channel'),
        scope('one', 'test', 'guild', 'other-channel'),
      ]

      const program = Effect.gen(function* () {
        const storage = yield* RoleStateStorage.Service
        yield* Effect.forEach(
          scopes,
          (channelScope, index) =>
            storage.save(
              channelScope,
              snapshot(1_000 + index, [relationship('same', 500 + index)], index / 10),
            ),
          { discard: true },
        )
        const loaded = yield* Effect.forEach(scopes, (channelScope) =>
          storage.load(channelScope, ['same']),
        )
        const memberFiltered = yield* storage.load(primaryScope, ['not-same'])
        const missing = yield* storage.load(scope('missing'), ['same'])
        return { loaded, memberFiltered, missing }
      }).pipe(Effect.provide(KoishiRoleStateStorage.layer(ctx)))

      const result = yield* program
      expect(
        result.loaded.map((entry) =>
          Option.match(entry, {
            onNone: () => undefined,
            onSome: (value) => value.roleState.mood.valence,
          }),
        ),
      ).toEqual([0, 0.1, 0.2, 0.3, 0.4])
      expect(
        result.loaded.map((entry) =>
          Option.match(entry, {
            onNone: () => [],
            onSome: (value) => value.relationships.map((item) => item.memberId),
          }),
        ),
      ).toEqual([['same'], ['same'], ['same'], ['same'], ['same']])
      if (Option.isNone(result.memberFiltered)) {
        return yield* Effect.die('Expected the channel state without a relationship projection')
      }
      expect(result.memberFiltered.value.relationships).toEqual([])
      expect(Option.isNone(result.missing)).toBe(true)
    }),
  ),
)

it.effect('loads the same schema-validated state after a SQLite restart', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory
      const path = join(directory, 'role-state.db')
      const channelScope = scope('restart')
      const expected = snapshot(42_000, [relationship('member', 41_000)])

      yield* Effect.scoped(
        Effect.gen(function* () {
          const ctx = yield* databaseContext(path)
          yield* RoleStateStorage.Service.pipe(
            Effect.flatMap((storage) => storage.save(channelScope, expected)),
            Effect.provide(KoishiRoleStateStorage.layer(ctx)),
          )
        }),
      )

      const loaded = yield* Effect.scoped(
        Effect.gen(function* () {
          const ctx = yield* databaseContext(path)
          return yield* RoleStateStorage.Service.pipe(
            Effect.flatMap((storage) => storage.load(channelScope, ['member'])),
            Effect.provide(KoishiRoleStateStorage.layer(ctx)),
          )
        }),
      )
      expect(Option.getOrUndefined(loaded)).toEqual(expected)
    }),
  ),
)

it.effect('returns a typed storage failure for malformed persisted payloads', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* databaseContext(':memory:')
      const channelScope = scope()
      yield* Effect.promise(() =>
        ctx.database.create('yokai_channel_state', {
          ...channelScope,
          payload: '{not-json',
          updatedAt: new Date(1_000),
        }),
      )

      const error = yield* RoleStateStorage.Service.pipe(
        Effect.flatMap((storage) => storage.load(channelScope, [])),
        Effect.provide(KoishiRoleStateStorage.layer(ctx)),
        Effect.flip,
      )
      expect(error).toMatchObject({ _tag: 'RoleStateStorageError', operation: 'load' })
    }),
  ),
)
