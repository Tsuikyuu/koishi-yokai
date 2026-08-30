import { Clock, Context, Effect, HashMap, Layer, Option, SynchronizedRef } from 'effect'

import { type Message, isHardTrigger } from './message'
import {
  CHANNEL_CONVERSATION_MERGE_KEY,
  DIRECT_MECHANISM_ID,
  DurationMilliseconds,
  EpochMilliseconds,
  type Proposal,
  Proposal as ProposalSchema,
  Priority,
  Reason,
  ReasonCode,
  scopeIdOf,
} from './proposal'

export const DEFAULT_DEBOUNCE_MS = DurationMilliseconds.make(500)
export const DEFAULT_PROPOSAL_TTL_MS = DurationMilliseconds.make(10_000)
export const DIRECT_PRIORITY = Priority.make(100)
export const SUPPLEMENT_PRIORITY = Priority.make(90)

export interface Options {
  readonly debounceMs: DurationMilliseconds
  readonly proposalTtlMs: DurationMilliseconds
}

interface OpenConversation {
  readonly authorId: string
  readonly until: EpochMilliseconds
}

type State = HashMap.HashMap<string, OpenConversation>

export interface Interface {
  readonly observe: (message: Message) => Effect.Effect<Option.Option<Proposal>>
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/core/DirectResponseMechanism',
) {}

const reasonCode = (message: Message): ReasonCode => {
  switch (message.hardReplyKind) {
    case 'explicit-mention':
      return ReasonCode.make('explicit-mention')
    case 'reply-to-self':
      return ReasonCode.make('reply-to-self')
    case 'role-name-prefix':
      return ReasonCode.make('role-name-prefix')
    case 'role-name-contains':
      return ReasonCode.make('role-name-contains')
    case 'none':
      return ReasonCode.make('supplement')
  }
}

const proposal = (message: Message, options: Options, now: number, priority: Priority): Proposal =>
  ProposalSchema.make({
    scopeId: scopeIdOf(message.scope),
    scope: message.scope,
    mergeKey: CHANNEL_CONVERSATION_MERGE_KEY,
    kind: 'direct',
    reason: Reason.make({
      mechanismId: DIRECT_MECHANISM_ID,
      code: reasonCode(message),
      priority,
    }),
    focus: message.focus,
    submittedAt: EpochMilliseconds.make(now),
    expiresAt: EpochMilliseconds.make(now + options.proposalTtlMs),
    debounceMs: options.debounceMs,
    budgetCategory: 'reserved',
    cooldownPolicy: 'bypass',
  })

export const layer = (
  options: Options = {
    debounceMs: DEFAULT_DEBOUNCE_MS,
    proposalTtlMs: DEFAULT_PROPOSAL_TTL_MS,
  },
) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const state = yield* SynchronizedRef.make<State>(HashMap.empty())

      const observe = Effect.fn('DirectResponseMechanism.observe')(function* (message: Message) {
        const now = yield* Clock.currentTimeMillis
        const scopeId = scopeIdOf(message.scope)
        return yield* SynchronizedRef.modify(state, (current) => {
          if (isHardTrigger(message)) {
            const next = HashMap.set(current, scopeId, {
              authorId: message.focus.authorId,
              until: EpochMilliseconds.make(now + options.debounceMs),
            })
            return [Option.some(proposal(message, options, now, DIRECT_PRIORITY)), next]
          }

          const open = HashMap.get(current, scopeId)
          const supplement =
            Option.isSome(open) &&
            open.value.authorId === message.focus.authorId &&
            open.value.until >= now &&
            !message.isDuplicate &&
            !message.isOtherBot &&
            !message.isSelf &&
            message.isEffective
          if (!supplement) return [Option.none<Proposal>(), current]

          const next = HashMap.set(current, scopeId, {
            authorId: open.value.authorId,
            until: EpochMilliseconds.make(now + options.debounceMs),
          })
          return [Option.some(proposal(message, options, now, SUPPLEMENT_PRIORITY)), next]
        })
      })

      return Service.of({ observe })
    }),
  )

export * as DirectResponseMechanism from './direct-mechanism'
