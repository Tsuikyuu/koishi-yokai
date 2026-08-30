import { CapabilityScope, FocusMessage, ResponseMechanismId } from 'yokai-protocol'
import { Schema } from 'effect'

import { Category } from '../call-budget/model'

export const ScopeId = Schema.NonEmptyString.pipe(Schema.brand('@yokai/core/WakeScopeId'))

export type ScopeId = typeof ScopeId.Type

export const MergeKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(256),
).pipe(Schema.brand('@yokai/core/WakeMergeKey'))

export type MergeKey = typeof MergeKey.Type

export const ReasonCode = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
).pipe(Schema.brand('@yokai/core/WakeReasonCode'))

export type ReasonCode = typeof ReasonCode.Type

export const Priority = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000 })).pipe(
  Schema.brand('@yokai/core/WakePriority'),
)

export type Priority = typeof Priority.Type

export const EpochMilliseconds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand('@yokai/core/WakeEpochMilliseconds'),
)

export type EpochMilliseconds = typeof EpochMilliseconds.Type

export const DurationMilliseconds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand('@yokai/core/WakeDurationMilliseconds'),
)

export type DurationMilliseconds = typeof DurationMilliseconds.Type

export const CooldownPolicy = Schema.Literals(['bypass', 'enforce'])

export type CooldownPolicy = typeof CooldownPolicy.Type

export const Kind = Schema.Literals(['direct', 'activity', 'engagement', 'schedule', 'initiative'])

export type Kind = typeof Kind.Type

export const Reason = Schema.Struct({
  mechanismId: ResponseMechanismId,
  code: ReasonCode,
  priority: Priority,
})

export interface Reason extends Schema.Schema.Type<typeof Reason> {}

export const Proposal = Schema.Struct({
  scopeId: ScopeId,
  scope: CapabilityScope,
  mergeKey: MergeKey,
  kind: Kind,
  reason: Reason,
  focus: FocusMessage,
  submittedAt: EpochMilliseconds,
  expiresAt: EpochMilliseconds,
  debounceMs: DurationMilliseconds,
  budgetCategory: Category,
  cooldownPolicy: CooldownPolicy,
}).check(
  Schema.makeFilter((proposal) =>
    proposal.expiresAt >= proposal.submittedAt
      ? true
      : 'Expected wake proposal expiry at or after submission',
  ),
  Schema.makeFilter((proposal) =>
    proposal.scopeId === scopeIdOf(proposal.scope)
      ? true
      : 'Expected wake proposal scopeId to match scope',
  ),
)

export interface Proposal extends Schema.Schema.Type<typeof Proposal> {}

export const Merged = Schema.Struct({
  scopeId: ScopeId,
  scope: CapabilityScope,
  mergeKey: MergeKey,
  kind: Kind,
  primaryReason: Reason,
  additionalReasons: Schema.Array(Reason),
  focus: FocusMessage,
  submittedAt: EpochMilliseconds,
  expiresAt: EpochMilliseconds,
  debounceMs: DurationMilliseconds,
  budgetCategory: Category,
  cooldownPolicy: CooldownPolicy,
  mergedCount: Schema.Int.check(Schema.isGreaterThan(0)),
})

export interface Merged extends Schema.Schema.Type<typeof Merged> {}

export interface Batch {
  readonly primary: Proposal
  readonly reasons: ReadonlyArray<Reason>
  readonly updatedAt: EpochMilliseconds
  readonly expiresAt: EpochMilliseconds
  readonly mergedCount: number
}

export const DIRECT_MECHANISM_ID = ResponseMechanismId.make('direct')
export const ACTIVITY_MECHANISM_ID = ResponseMechanismId.make('activity')
export const ENGAGEMENT_MECHANISM_ID = ResponseMechanismId.make('engagement')
export const ACTION_COMPLETION_MECHANISM_ID = ResponseMechanismId.make('action-completion')
export const CHANNEL_CONVERSATION_MERGE_KEY = MergeKey.make('channel-conversation')
export const ACTION_COMPLETION_MERGE_KEY = MergeKey.make('action-completion')
export const ACTION_COMPLETION_REASON_CODE = ReasonCode.make('deferred-complete')
export const ACTION_COMPLETION_PRIORITY = Priority.make(5)
export const ACTION_COMPLETION_DEBOUNCE_MS = DurationMilliseconds.make(250)
export const ACTION_COMPLETION_TTL_MS = DurationMilliseconds.make(10_000)

export const scopeIdOf = (scope: CapabilityScope): ScopeId =>
  ScopeId.make(JSON.stringify([scope.instanceId, scope.platform, scope.guildId, scope.channelId]))

export const identityOf = (proposal: Proposal): string =>
  JSON.stringify([proposal.scopeId, proposal.mergeKey])

/** Create a separate low-priority turn after deferred actions complete. */
export const deferredCompletion = (turn: Merged, now: number): Proposal =>
  Proposal.make({
    scopeId: turn.scopeId,
    scope: turn.scope,
    mergeKey: ACTION_COMPLETION_MERGE_KEY,
    kind: 'engagement',
    reason: Reason.make({
      mechanismId: ACTION_COMPLETION_MECHANISM_ID,
      code: ACTION_COMPLETION_REASON_CODE,
      priority: ACTION_COMPLETION_PRIORITY,
    }),
    focus: turn.focus,
    submittedAt: EpochMilliseconds.make(now),
    expiresAt: EpochMilliseconds.make(now + ACTION_COMPLETION_TTL_MS),
    debounceMs: ACTION_COMPLETION_DEBOUNCE_MS,
    budgetCategory: 'background',
    cooldownPolicy: 'enforce',
  })

const sameReason = (left: Reason, right: Reason): boolean =>
  left.mechanismId === right.mechanismId && left.code === right.code

const winsPriority = (candidate: Proposal, current: Proposal): boolean =>
  candidate.reason.priority > current.reason.priority ||
  (candidate.reason.priority === current.reason.priority &&
    candidate.submittedAt >= current.submittedAt)

export const begin = (proposal: Proposal): Batch => ({
  primary: proposal,
  reasons: [proposal.reason],
  updatedAt: proposal.submittedAt,
  expiresAt: proposal.expiresAt,
  mergedCount: 1,
})

export const merge = (batch: Batch, proposal: Proposal): Batch => ({
  primary: winsPriority(proposal, batch.primary) ? proposal : batch.primary,
  reasons: batch.reasons.some((reason) => sameReason(reason, proposal.reason))
    ? batch.reasons
    : [...batch.reasons, proposal.reason],
  updatedAt: proposal.submittedAt >= batch.updatedAt ? proposal.submittedAt : batch.updatedAt,
  expiresAt: proposal.expiresAt >= batch.expiresAt ? proposal.expiresAt : batch.expiresAt,
  mergedCount: batch.mergedCount + 1,
})

export const resolve = (batch: Batch): Merged =>
  Merged.make({
    scopeId: batch.primary.scopeId,
    scope: batch.primary.scope,
    mergeKey: batch.primary.mergeKey,
    kind: batch.primary.kind,
    primaryReason: batch.primary.reason,
    additionalReasons: batch.reasons.filter((reason) => !sameReason(reason, batch.primary.reason)),
    focus: batch.primary.focus,
    submittedAt: batch.updatedAt,
    expiresAt: batch.expiresAt,
    debounceMs: batch.primary.debounceMs,
    budgetCategory: batch.primary.budgetCategory,
    cooldownPolicy: batch.primary.cooldownPolicy,
    mergedCount: batch.mergedCount,
  })

export * as WakeProposal from './proposal'
