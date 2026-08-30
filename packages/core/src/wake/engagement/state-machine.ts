import { ThreadScene } from '@yokai-internal/mind'
import { Data, Option } from 'effect'

import { EpochMilliseconds } from '../proposal'
import {
  type Active,
  type AdmissionToken,
  ClaimId,
  LeaseId,
  type Options,
  RoundCount,
  Snapshot,
} from './model'

export interface OpenInput {
  readonly id: number
  readonly scopeId: Active['scopeId']
  readonly scope: Active['scope']
  readonly threadId: Active['threadId']
  readonly participantId: Active['participants'][number]
  readonly anchorMessageId: string
  readonly now: number
}

export type AcceptResult = Data.TaggedEnum<{
  Accepted: { readonly next: Option.Option<Active> }
  Rejected: { readonly next: Option.Option<Active> }
}>

export const AcceptResult = Data.taggedEnum<AcceptResult>()

export const isActiveAt = (lease: Active, now: number): boolean =>
  now < lease.idleExpiresAt && now < lease.absoluteExpiresAt && lease.remainingRounds > 0

export const snapshotOf = (lease: Active): Snapshot =>
  Snapshot.make({
    id: lease.id,
    scopeId: lease.scopeId,
    scope: lease.scope,
    threadId: lease.threadId,
    participants: lease.participants,
    anchorMessageId: lease.anchorMessageId,
    startedAt: lease.startedAt,
    idleExpiresAt: lease.idleExpiresAt,
    absoluteExpiresAt: lease.absoluteExpiresAt,
    remainingRounds: lease.remainingRounds,
  })

export const open = (input: OpenInput, options: Options): Active => {
  const absoluteExpiresAt = EpochMilliseconds.make(input.now + options.maxDurationMs)
  return {
    id: LeaseId.make(input.id),
    scopeId: input.scopeId,
    scope: input.scope,
    threadId: input.threadId,
    participants: [input.participantId],
    anchorMessageId: ClaimId.make(input.anchorMessageId),
    startedAt: EpochMilliseconds.make(input.now),
    idleExpiresAt: EpochMilliseconds.make(
      Math.min(input.now + options.idleTtlMs, absoluteExpiresAt),
    ),
    absoluteExpiresAt,
    remainingRounds: options.maxRounds,
    acceptedClaimIds: [],
  }
}

export const addParticipant = (
  lease: Active,
  participantId: Active['participants'][number],
): Active =>
  lease.participants.includes(participantId)
    ? lease
    : {
        ...lease,
        participants: [...lease.participants, participantId].slice(
          -ThreadScene.MAX_THREAD_PARTICIPANTS,
        ),
      }

export const removeParticipant = (
  lease: Active,
  participantId: Active['participants'][number],
): Option.Option<Active> => {
  const participants = lease.participants.filter((candidate) => candidate !== participantId)
  return participants.length === 0 ? Option.none() : Option.some({ ...lease, participants })
}

export const accept = (
  lease: Active,
  token: AdmissionToken,
  options: Options,
  now: number,
): AcceptResult => {
  if (!isActiveAt(lease, now)) return AcceptResult.Rejected({ next: Option.none() })
  if (
    token.scopeId !== lease.scopeId ||
    token.leaseId !== lease.id ||
    !lease.participants.includes(token.participantId) ||
    lease.acceptedClaimIds.includes(token.claimId)
  ) {
    return AcceptResult.Rejected({ next: Option.some(lease) })
  }

  const remainingRounds = lease.remainingRounds - 1
  if (remainingRounds === 0) return AcceptResult.Accepted({ next: Option.none() })

  return AcceptResult.Accepted({
    next: Option.some({
      ...lease,
      idleExpiresAt: EpochMilliseconds.make(
        Math.min(now + options.idleTtlMs, lease.absoluteExpiresAt),
      ),
      remainingRounds: RoundCount.make(remainingRounds),
      acceptedClaimIds: [...lease.acceptedClaimIds, token.claimId],
    }),
  })
}
