import { ThreadScene } from '@yokai-internal/mind'
import { Clock, Context, Effect, HashMap, Layer, Option, SynchronizedRef } from 'effect'

import { type Message, isHardTrigger, isLeaseAnchorTrigger } from '../message'
import {
  CHANNEL_CONVERSATION_MERGE_KEY,
  ENGAGEMENT_MECHANISM_ID,
  EpochMilliseconds,
  type Proposal,
  Proposal as ProposalSchema,
  Priority,
  Reason,
  ReasonCode,
  type ScopeId,
  scopeIdOf,
} from '../proposal'
import { type Active, AdmissionToken, ClaimId, type Options, type Snapshot } from './model'
import {
  AcceptResult,
  accept as acceptLease,
  addParticipant,
  isActiveAt,
  open,
  removeParticipant,
  snapshotOf,
} from './state-machine'

export {
  AdmissionToken,
  ClaimId,
  LeaseId,
  Options,
  PositiveDurationMilliseconds,
  RoundCount,
  Snapshot,
} from './model'

export const ENGAGEMENT_PRIORITY = Priority.make(80)
export const ENGAGEMENT_REASON_CODE = ReasonCode.make('continued-discussion')

export interface Candidate {
  readonly proposal: Proposal
  readonly token: AdmissionToken
  readonly admission: () => Effect.Effect<boolean>
}

export interface Interface {
  readonly observe: (
    message: Message,
    scene: ThreadScene.Scene,
  ) => Effect.Effect<Option.Option<Candidate>>
  readonly accept: (token: AdmissionToken) => Effect.Effect<boolean>
  readonly close: (scopeId: ScopeId) => Effect.Effect<boolean>
  readonly snapshot: (scopeId: ScopeId) => Effect.Effect<Option.Option<Snapshot>>
}

export class Service extends Context.Service<Service, Interface>()('@yokai/core/EngagementLease') {}

interface State {
  readonly nextLeaseId: number
  readonly leases: HashMap.HashMap<ScopeId, Active>
}

const initialState = (): State => ({ nextLeaseId: 1, leases: HashMap.empty() })

const isEligibleHumanMessage = (message: Message): boolean =>
  !message.isDuplicate && !message.isOtherBot && !message.isSelf && message.isEffective

const opensLease = (message: Message): boolean => isLeaseAnchorTrigger(message)

const proposal = (message: Message, lease: Active, options: Options, now: number): Proposal =>
  ProposalSchema.make({
    scopeId: lease.scopeId,
    scope: lease.scope,
    mergeKey: CHANNEL_CONVERSATION_MERGE_KEY,
    kind: 'engagement',
    reason: Reason.make({
      mechanismId: ENGAGEMENT_MECHANISM_ID,
      code: ENGAGEMENT_REASON_CODE,
      priority: ENGAGEMENT_PRIORITY,
    }),
    focus: message.focus,
    submittedAt: EpochMilliseconds.make(now),
    expiresAt: EpochMilliseconds.make(
      Math.min(now + options.proposalTtlMs, lease.idleExpiresAt, lease.absoluteExpiresAt),
    ),
    debounceMs: options.debounceMs,
    budgetCategory: 'reserved',
    cooldownPolicy: 'bypass',
  })

export const layer = (options: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const state = yield* SynchronizedRef.make(initialState())

      const accept = Effect.fn('EngagementLease.accept')(function* (token: AdmissionToken) {
        const now = yield* Clock.currentTimeMillis
        return yield* SynchronizedRef.modify(state, (current) => {
          const stored = HashMap.get(current.leases, token.scopeId)
          if (Option.isNone(stored)) return [false, current]
          const result = acceptLease(stored.value, token, options, now)
          return AcceptResult.$match(result, {
            Accepted: ({ next }): readonly [boolean, State] => [
              true,
              {
                ...current,
                leases: Option.match(next, {
                  onNone: () => HashMap.remove(current.leases, token.scopeId),
                  onSome: (lease) => HashMap.set(current.leases, token.scopeId, lease),
                }),
              },
            ],
            Rejected: ({ next }): readonly [boolean, State] => [
              false,
              {
                ...current,
                leases: Option.match(next, {
                  onNone: () => HashMap.remove(current.leases, token.scopeId),
                  onSome: (lease) => HashMap.set(current.leases, token.scopeId, lease),
                }),
              },
            ],
          })
        })
      })

      const observe = Effect.fn('EngagementLease.observe')(function* (
        message: Message,
        scene: ThreadScene.Scene,
      ) {
        if (!options.enabled) return Option.none<Candidate>()
        const now = yield* Clock.currentTimeMillis
        const scopeId = scopeIdOf(message.scope)
        const participantId = ThreadScene.ParticipantId.make(message.focus.authorId)

        return yield* SynchronizedRef.modify(state, (current) => {
          const activeLeases = HashMap.filter(current.leases, (lease) => isActiveAt(lease, now))
          const active = HashMap.get(activeLeases, scopeId)
          const pruned: State = { ...current, leases: activeLeases }

          if (!isEligibleHumanMessage(message)) {
            return [Option.none<Candidate>(), pruned]
          }

          if (opensLease(message)) {
            if (Option.isSome(active) && active.value.threadId === scene.thread.id) {
              const lease = addParticipant(active.value, participantId)
              return [
                Option.none<Candidate>(),
                { ...pruned, leases: HashMap.set(pruned.leases, scopeId, lease) },
              ]
            }

            const lease = open(
              {
                id: pruned.nextLeaseId,
                scopeId,
                scope: message.scope,
                threadId: scene.thread.id,
                participantId,
                anchorMessageId: message.focus.messageId,
                now,
              },
              options,
            )
            return [
              Option.none<Candidate>(),
              {
                nextLeaseId: pruned.nextLeaseId + 1,
                leases: HashMap.set(pruned.leases, scopeId, lease),
              },
            ]
          }

          if (Option.isNone(active)) return [Option.none<Candidate>(), pruned]
          if (!active.value.participants.includes(participantId)) {
            return [Option.none<Candidate>(), pruned]
          }

          if (active.value.threadId !== scene.thread.id || scene.direction.kind === 'participant') {
            const retained = removeParticipant(active.value, participantId)
            return [
              Option.none<Candidate>(),
              {
                ...pruned,
                leases: Option.match(retained, {
                  onNone: () => HashMap.remove(pruned.leases, scopeId),
                  onSome: (lease) => HashMap.set(pruned.leases, scopeId, lease),
                }),
              },
            ]
          }

          if (isHardTrigger(message)) return [Option.none<Candidate>(), pruned]

          const token = AdmissionToken.make({
            scopeId,
            leaseId: active.value.id,
            claimId: ClaimId.make(message.focus.messageId),
            participantId,
          })
          const candidate: Candidate = {
            proposal: proposal(message, active.value, options, now),
            token,
            admission: () => accept(token),
          }
          return [Option.some(candidate), pruned]
        })
      })

      const close = Effect.fn('EngagementLease.close')(function* (scopeId: ScopeId) {
        return yield* SynchronizedRef.modify(state, (current) => {
          const existed = Option.isSome(HashMap.get(current.leases, scopeId))
          return [existed, { ...current, leases: HashMap.remove(current.leases, scopeId) }]
        })
      })

      const snapshot = Effect.fn('EngagementLease.snapshot')(function* (scopeId: ScopeId) {
        const now = yield* Clock.currentTimeMillis
        return yield* SynchronizedRef.modify(state, (current) => {
          const stored = HashMap.get(current.leases, scopeId)
          if (Option.isNone(stored)) return [Option.none<Snapshot>(), current]
          if (!isActiveAt(stored.value, now)) {
            return [
              Option.none<Snapshot>(),
              { ...current, leases: HashMap.remove(current.leases, scopeId) },
            ]
          }
          return [Option.some(snapshotOf(stored.value)), current]
        })
      })

      return Service.of({ observe, accept, close, snapshot })
    }),
  )

export * as EngagementLease from './service'
