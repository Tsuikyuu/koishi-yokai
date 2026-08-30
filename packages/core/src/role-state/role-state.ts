import { RoleStateModel, RoleStateReducer } from '@yokai-internal/mind'
import type { CapabilityScope } from 'yokai-protocol'
import { Clock, Context, Effect, Layer, Option, Semaphore } from 'effect'

import { RoleStateStorage } from './storage'

export const MAX_SNAPSHOT_MEMBERS = 16

type MemberInteraction = Extract<RoleStateModel.Interaction, { readonly _tag: 'MemberInteraction' }>
type RoleReply = Extract<RoleStateModel.Interaction, { readonly _tag: 'RoleReply' }>

export interface Options {
  readonly parameters: RoleStateModel.Parameters
}

export interface MemberObservation {
  readonly scope: CapabilityScope
  readonly messageId: string
  readonly memberId: MemberInteraction['memberId']
  readonly scene: MemberInteraction['scene']
}

export interface SuccessfulTurn {
  readonly scope: CapabilityScope
  readonly focusMessageId: string
  readonly kind: string
  readonly submittedAt: number
  readonly threadId: RoleReply['threadId']
  readonly sentSegments: RoleReply['sentSegments']
}

export interface Interface {
  readonly observe: (
    observation: MemberObservation,
  ) => Effect.Effect<RoleStateModel.Snapshot, RoleStateStorage.StorageError>
  readonly recordSuccessfulTurn: (
    turn: SuccessfulTurn,
  ) => Effect.Effect<RoleStateModel.Snapshot, RoleStateStorage.StorageError>
  readonly materialize: (
    snapshot: RoleStateModel.Snapshot,
  ) => Effect.Effect<RoleStateModel.Snapshot>
  /** Load and materialize a bounded relationship projection. Storage failures remain typed. */
  readonly snapshot: (
    scope: CapabilityScope,
    memberIds: ReadonlyArray<string>,
  ) => Effect.Effect<RoleStateModel.Snapshot, RoleStateStorage.StorageError>
}

export class Service extends Context.Service<Service, Interface>()('@yokai/core/RoleState') {}

const boundedMemberIds = (memberIds: ReadonlyArray<string>): ReadonlyArray<string> =>
  memberIds
    .filter((memberId, index) => memberIds.indexOf(memberId) === index)
    .slice(0, MAX_SNAPSHOT_MEMBERS)

const restrictRelationships = (
  snapshot: RoleStateModel.Snapshot,
  memberIds: ReadonlyArray<string>,
): RoleStateModel.Snapshot =>
  RoleStateModel.Snapshot.make({
    ...snapshot,
    relationships: memberIds.flatMap((memberId) =>
      snapshot.relationships.filter((relationship) => relationship.memberId === memberId),
    ),
  })

const scopeId = (scope: CapabilityScope): string =>
  JSON.stringify([scope.instanceId, scope.platform, scope.guildId, scope.channelId])

const logStorageFailure = (
  scope: CapabilityScope,
  error: RoleStateStorage.StorageError,
): Effect.Effect<void> =>
  Effect.logWarning('RoleState.storage_failed').pipe(
    Effect.annotateLogs({
      errorTag: error._tag,
      operation: error.operation,
      scopeId: scopeId(scope),
    }),
  )

export const memberInteractionId = (messageId: string): RoleStateModel.InteractionId =>
  RoleStateModel.InteractionId.make(`member:${messageId}`)

export const roleReplyInteractionId = (
  kind: string,
  focusMessageId: string,
  submittedAt: number,
): RoleStateModel.InteractionId =>
  RoleStateModel.InteractionId.make(`reply:${kind}:${submittedAt}:${focusMessageId}`)

export const layer = (options: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const storage = yield* RoleStateStorage.Service
      const gate = yield* Semaphore.make(1)

      const materialize = Effect.fn('RoleState.materialize')(function* (
        snapshot: RoleStateModel.Snapshot,
      ) {
        const now = yield* Clock.currentTimeMillis
        return RoleStateReducer.advance(snapshot, now, options.parameters)
      })

      const update = Effect.fn('RoleState.update')(function* (
        scope: CapabilityScope,
        memberIds: ReadonlyArray<string>,
        interaction: RoleStateModel.Interaction,
      ) {
        return yield* gate
          .withPermits(1)(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis
              const stored = yield* storage.load(scope, memberIds)
              const current = Option.getOrElse(stored, () => RoleStateModel.empty(now))
              const next = RoleStateReducer.update(current, interaction, now, options.parameters)
              if (current.appliedInteractionIds.includes(interaction.interactionId)) return next
              yield* storage.save(scope, next)
              return next
            }),
          )
          .pipe(Effect.tapError((error) => logStorageFailure(scope, error)))
      })

      const observe = Effect.fn('RoleState.observe')(function* (observation: MemberObservation) {
        const interaction = RoleStateModel.Interaction.cases.MemberInteraction.make({
          interactionId: memberInteractionId(observation.messageId),
          memberId: observation.memberId,
          scene: observation.scene,
        })
        return yield* update(observation.scope, [observation.memberId], interaction)
      })

      const recordSuccessfulTurn = Effect.fn('RoleState.recordSuccessfulTurn')(function* (
        turn: SuccessfulTurn,
      ) {
        const interaction = RoleStateModel.Interaction.cases.RoleReply.make({
          interactionId: roleReplyInteractionId(turn.kind, turn.focusMessageId, turn.submittedAt),
          threadId: turn.threadId,
          sentSegments: turn.sentSegments,
        })
        return yield* update(turn.scope, [], interaction)
      })

      const snapshot = Effect.fn('RoleState.snapshot')(function* (
        scope: CapabilityScope,
        requestedMemberIds: ReadonlyArray<string>,
      ) {
        const memberIds = boundedMemberIds(requestedMemberIds)
        return yield* gate
          .withPermits(1)(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis
              const stored = yield* storage.load(scope, memberIds)
              const current = Option.getOrElse(stored, () => RoleStateModel.empty(now))
              return restrictRelationships(
                RoleStateReducer.advance(current, now, options.parameters),
                memberIds,
              )
            }),
          )
          .pipe(Effect.tapError((error) => logStorageFailure(scope, error)))
      })

      return Service.of({ observe, recordSuccessfulTurn, materialize, snapshot })
    }),
  )

export * as RoleState from './role-state'
