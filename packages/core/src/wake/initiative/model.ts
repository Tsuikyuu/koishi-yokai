import { RoleStateModel, ThreadScene } from '@yokai-internal/mind'
import { CapabilityScope } from 'yokai-protocol'
import { Schema } from 'effect'

import { ActivityGateValue } from '../../activity-gating/index'
import { WakeMessage } from '../message'
import { DurationMilliseconds, EpochMilliseconds, ScopeId } from '../proposal'

export const PositiveDurationMilliseconds = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand('@yokai/core/InitiativePositiveDurationMilliseconds'),
)

export type PositiveDurationMilliseconds = typeof PositiveDurationMilliseconds.Type

export const Revision = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand('@yokai/core/InitiativeRevision'),
)

export type Revision = typeof Revision.Type

export const SelfId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(512),
  Schema.isPattern(/^[^\p{C}]+$/u),
).pipe(Schema.brand('@yokai/core/InitiativeSelfId'))

export type SelfId = typeof SelfId.Type

export const Options = Schema.Struct({
  enabled: Schema.Boolean,
  quietPeriodMs: PositiveDurationMilliseconds,
  channelCooldownMs: DurationMilliseconds,
  intrinsicIntervalMs: PositiveDurationMilliseconds,
  recentWindowMs: PositiveDurationMilliseconds,
  recentRelevanceThreshold: ActivityGateValue.Score,
  relationshipThreshold: RoleStateModel.Level,
  minSocialEnergy: RoleStateModel.Level,
  maxRecentParticipation: RoleStateModel.Level,
  debounceMs: DurationMilliseconds,
  proposalTtlMs: PositiveDurationMilliseconds,
}).check(
  Schema.makeFilter((options) =>
    options.proposalTtlMs > options.debounceMs
      ? true
      : 'Expected initiative proposalTtlMs greater than debounceMs',
  ),
)

export interface Options extends Schema.Schema.Type<typeof Options> {}

export const Observation = Schema.Struct({
  message: WakeMessage.Message,
  scene: ThreadScene.Scene,
  selfId: SelfId,
  isDirect: Schema.Boolean,
})

export interface Observation extends Schema.Schema.Type<typeof Observation> {}

export const Target = Schema.Struct({
  scope: CapabilityScope,
  selfId: SelfId,
})

export interface Target extends Schema.Schema.Type<typeof Target> {}

export const AdmissionToken = Schema.Struct({
  scopeId: ScopeId,
  revision: Revision,
  focusMessageId: Schema.NonEmptyString,
})

export interface AdmissionToken extends Schema.Schema.Type<typeof AdmissionToken> {}

export const Snapshot = Schema.Struct({
  scopeId: ScopeId,
  revision: Revision,
  focusMessageId: Schema.NonEmptyString,
  observedAt: EpochMilliseconds,
  lastIntrinsicAt: Schema.OptionFromNullOr(EpochMilliseconds),
  acceptedRevision: Schema.OptionFromNullOr(Revision),
})

export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}
