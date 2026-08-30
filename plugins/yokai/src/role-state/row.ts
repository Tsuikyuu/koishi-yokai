import { RoleStateModel } from '@yokai-internal/mind'
import type { CapabilityScope } from 'yokai-protocol'
import { Effect, Schema } from 'effect'

import type { YokaiChannelStateRow, YokaiMemberStateRow } from './model'

const ChannelPayload = Schema.Struct({
  roleState: RoleStateModel.RoleState,
  appliedInteractionIds: RoleStateModel.Snapshot.fields.appliedInteractionIds,
  updatedAt: RoleStateModel.EpochMilliseconds,
})

interface ChannelPayload extends Schema.Schema.Type<typeof ChannelPayload> {}

const ChannelPayloadJson = Schema.fromJsonString(ChannelPayload)
const RelationshipJson = Schema.fromJsonString(RoleStateModel.Relationship)

export const CorruptRowTable = Schema.Literals(['yokai_channel_state', 'yokai_member_state'])
export const CorruptRowReason = Schema.Literals(['timestamp-mismatch', 'member-id-mismatch'])

export class CorruptRowError extends Schema.TaggedError<CorruptRowError>(
  '@yokai/plugin/RoleStateRow.CorruptRowError',
)('RoleStateCorruptRowError', {
  table: CorruptRowTable,
  reason: CorruptRowReason,
}) {}

const scopeRow = (scope: CapabilityScope) => ({
  instanceId: scope.instanceId,
  platform: scope.platform,
  guildId: scope.guildId,
  channelId: scope.channelId,
})

export const encodeChannel = Effect.fn('KoishiRoleStateRow.encodeChannel')(function* (
  scope: CapabilityScope,
  snapshot: RoleStateModel.Snapshot,
) {
  const payload = yield* Schema.encodeEffect(ChannelPayloadJson)({
    roleState: snapshot.roleState,
    appliedInteractionIds: snapshot.appliedInteractionIds,
    updatedAt: snapshot.updatedAt,
  })
  return {
    ...scopeRow(scope),
    payload,
    updatedAt: new Date(snapshot.updatedAt),
  } satisfies YokaiChannelStateRow
})

export const decodeChannel = Effect.fn('KoishiRoleStateRow.decodeChannel')(function* (
  row: YokaiChannelStateRow,
) {
  const payload = yield* Schema.decodeUnknownEffect(ChannelPayloadJson)(row.payload)
  if (row.updatedAt.getTime() !== payload.updatedAt) {
    return yield* Effect.fail(
      new CorruptRowError({ table: 'yokai_channel_state', reason: 'timestamp-mismatch' }),
    )
  }
  return payload
})

export const encodeMember = Effect.fn('KoishiRoleStateRow.encodeMember')(function* (
  scope: CapabilityScope,
  relationship: RoleStateModel.Relationship,
) {
  const payload = yield* Schema.encodeEffect(RelationshipJson)(relationship)
  return {
    ...scopeRow(scope),
    memberId: relationship.memberId,
    payload,
    updatedAt: new Date(relationship.lastInteractionAt),
  } satisfies YokaiMemberStateRow
})

export const decodeMember = Effect.fn('KoishiRoleStateRow.decodeMember')(function* (
  row: YokaiMemberStateRow,
) {
  const relationship = yield* Schema.decodeUnknownEffect(RelationshipJson)(row.payload)
  if (relationship.memberId !== row.memberId) {
    return yield* Effect.fail(
      new CorruptRowError({ table: 'yokai_member_state', reason: 'member-id-mismatch' }),
    )
  }
  if (row.updatedAt.getTime() !== relationship.lastInteractionAt) {
    return yield* Effect.fail(
      new CorruptRowError({ table: 'yokai_member_state', reason: 'timestamp-mismatch' }),
    )
  }
  return relationship
})

export * as YokaiRoleStateRowCodec from './row'
