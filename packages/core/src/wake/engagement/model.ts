import { ThreadScene } from '@yokai-internal/mind'
import { CapabilityScope } from 'yokai-protocol'
import { Schema } from 'effect'

import { DurationMilliseconds, EpochMilliseconds, ScopeId } from '../proposal'

export const PositiveDurationMilliseconds = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand('@yokai/core/EngagementPositiveDurationMilliseconds'),
)

export type PositiveDurationMilliseconds = typeof PositiveDurationMilliseconds.Type

export const RoundCount = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand('@yokai/core/EngagementRoundCount'),
)

export type RoundCount = typeof RoundCount.Type

export const LeaseId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand('@yokai/core/EngagementLeaseId'),
)

export type LeaseId = typeof LeaseId.Type

export const ClaimId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(512),
).pipe(Schema.brand('@yokai/core/EngagementClaimId'))

export type ClaimId = typeof ClaimId.Type

export const Options = Schema.Struct({
  enabled: Schema.Boolean,
  idleTtlMs: PositiveDurationMilliseconds,
  maxDurationMs: PositiveDurationMilliseconds,
  maxRounds: RoundCount,
  debounceMs: DurationMilliseconds,
  proposalTtlMs: PositiveDurationMilliseconds,
}).check(
  Schema.makeFilter((options) =>
    options.idleTtlMs <= options.maxDurationMs
      ? true
      : 'Expected engagement idleTtlMs at or below maxDurationMs',
  ),
  Schema.makeFilter((options) =>
    options.proposalTtlMs > options.debounceMs
      ? true
      : 'Expected engagement proposalTtlMs greater than debounceMs',
  ),
)

export interface Options extends Schema.Schema.Type<typeof Options> {}

export const Snapshot = Schema.Struct({
  id: LeaseId,
  scopeId: ScopeId,
  scope: CapabilityScope,
  threadId: ThreadScene.ThreadId,
  participants: Schema.Array(ThreadScene.ParticipantId).check(
    Schema.isMaxLength(ThreadScene.MAX_THREAD_PARTICIPANTS),
  ),
  anchorMessageId: ClaimId,
  startedAt: EpochMilliseconds,
  idleExpiresAt: EpochMilliseconds,
  absoluteExpiresAt: EpochMilliseconds,
  remainingRounds: RoundCount,
})

export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}

export const AdmissionToken = Schema.Struct({
  scopeId: ScopeId,
  leaseId: LeaseId,
  claimId: ClaimId,
  participantId: ThreadScene.ParticipantId,
})

export interface AdmissionToken extends Schema.Schema.Type<typeof AdmissionToken> {}

export interface Active extends Snapshot {
  readonly acceptedClaimIds: ReadonlyArray<ClaimId>
}
