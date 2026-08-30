import { RoleStateStorage } from '@yokai-internal/core'
import { RoleStateModel } from '@yokai-internal/mind'
import type { CapabilityScope } from 'yokai-protocol'
import { Effect, Layer, Option, Schema } from 'effect'
import type { Context } from 'koishi'

import type { YokaiMemberStateRow } from './model'
import { YokaiRoleStateRowCodec } from './row'

class OrphanedMemberRowsError extends Schema.TaggedError<OrphanedMemberRowsError>(
  '@yokai/plugin/RoleStateStorage.OrphanedMemberRowsError',
)('RoleStateOrphanedMemberRowsError', {}) {}

const scopeQuery = (scope: CapabilityScope) => ({
  instanceId: scope.instanceId,
  platform: scope.platform,
  guildId: scope.guildId,
  channelId: scope.channelId,
})

const unique = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  values.filter((value, index) => values.indexOf(value) === index)

const storageFailure = (operation: RoleStateStorage.StorageOperation) =>
  Effect.mapError((cause) => new RoleStateStorage.StorageError({ operation, cause }))

const compareMembers = (
  left: RoleStateModel.Relationship,
  right: RoleStateModel.Relationship,
): number => (left.memberId < right.memberId ? -1 : left.memberId > right.memberId ? 1 : 0)

export const layer = (ctx: Context) =>
  Layer.succeed(
    RoleStateStorage.Service,
    RoleStateStorage.Service.of({
      load: Effect.fn('KoishiRoleStateStorage.load')(function* (
        scope: CapabilityScope,
        memberIds: ReadonlyArray<string>,
      ) {
        const requestedMemberIds = unique(memberIds)
        const channelRows = yield* Effect.tryPromise(() =>
          ctx.database.get('yokai_channel_state', scopeQuery(scope), { limit: 1 }),
        ).pipe(storageFailure('load'))
        const noMemberRows: ReadonlyArray<YokaiMemberStateRow> = []
        const memberRows =
          requestedMemberIds.length === 0
            ? noMemberRows
            : yield* Effect.tryPromise(() =>
                ctx.database.get('yokai_member_state', {
                  ...scopeQuery(scope),
                  memberId: { $in: [...requestedMemberIds] },
                }),
              ).pipe(storageFailure('load'))

        const channelRow = channelRows[0]
        if (channelRow === undefined) {
          if (memberRows.length > 0) {
            return yield* Effect.fail(
              new RoleStateStorage.StorageError({
                operation: 'load',
                cause: new OrphanedMemberRowsError({}),
              }),
            )
          }
          return Option.none<RoleStateModel.Snapshot>()
        }

        const channel = yield* YokaiRoleStateRowCodec.decodeChannel(channelRow).pipe(
          storageFailure('load'),
        )
        const relationships = yield* Effect.forEach(memberRows, (row) =>
          YokaiRoleStateRowCodec.decodeMember(row).pipe(storageFailure('load')),
        )
        return Option.some(
          RoleStateModel.Snapshot.make({
            roleState: channel.roleState,
            relationships: [...relationships].sort(compareMembers),
            appliedInteractionIds: channel.appliedInteractionIds,
            updatedAt: channel.updatedAt,
          }),
        )
      }),
      save: Effect.fn('KoishiRoleStateStorage.save')(function* (
        scope: CapabilityScope,
        snapshot: RoleStateModel.Snapshot,
      ) {
        const channelRow = yield* YokaiRoleStateRowCodec.encodeChannel(scope, snapshot).pipe(
          storageFailure('save'),
        )
        const memberRows = yield* Effect.forEach(snapshot.relationships, (relationship) =>
          YokaiRoleStateRowCodec.encodeMember(scope, relationship).pipe(storageFailure('save')),
        )

        yield* Effect.tryPromise({
          try: () =>
            ctx.database
              .transact((database) =>
                database
                  .upsert('yokai_channel_state', [channelRow])
                  .then(() =>
                    memberRows.length === 0
                      ? undefined
                      : database.upsert('yokai_member_state', memberRows),
                  ),
              )
              .then(() => undefined),
          catch: (cause) => new RoleStateStorage.StorageError({ operation: 'save', cause }),
        })
      }),
    }),
  )

export * as KoishiRoleStateStorage from './storage'
