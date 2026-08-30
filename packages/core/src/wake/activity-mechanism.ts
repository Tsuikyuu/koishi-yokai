import { Clock, Context, Effect, HashMap, Layer, Option, SynchronizedRef } from 'effect'

import {
  ActivityGateValue,
  ActivityScoring,
  DynamicThreshold,
  GatePressure,
  LocalRelevance,
} from '../activity-gating/index'
import { type Message } from './message'
import {
  ACTIVITY_MECHANISM_ID,
  CHANNEL_CONVERSATION_MERGE_KEY,
  DurationMilliseconds,
  EpochMilliseconds,
  type Proposal,
  Proposal as ProposalSchema,
  Priority,
  Reason,
  ReasonCode,
  type ScopeId,
  scopeIdOf,
} from './proposal'
import { WakeArbiter } from './arbiter'

export const DEFAULT_DEBOUNCE_MS = DurationMilliseconds.make(3_000)
export const DEFAULT_PROPOSAL_TTL_MS = DurationMilliseconds.make(15_000)
export const ACTIVITY_PRIORITY = Priority.make(10)

export interface Options {
  readonly debounceMs: DurationMilliseconds
  readonly proposalTtlMs: DurationMilliseconds
  readonly activityParameters: ActivityScoring.Parameters
  readonly activityThreshold: ActivityGateValue.Score
  readonly relevanceThreshold: ActivityGateValue.Score
}

export const DEFAULT_OPTIONS: Options = {
  debounceMs: DEFAULT_DEBOUNCE_MS,
  proposalTtlMs: DEFAULT_PROPOSAL_TTL_MS,
  activityParameters: ActivityScoring.DEFAULT_PARAMETERS,
  activityThreshold: DynamicThreshold.DEFAULT_ACTIVITY_THRESHOLD,
  relevanceThreshold: DynamicThreshold.DEFAULT_RELEVANCE_THRESHOLD,
}

interface ChannelState {
  readonly activity: ActivityGateValue.Score
  readonly lastObservedAt: number
  readonly participants: HashMap.HashMap<string, number>
}

type State = HashMap.HashMap<ScopeId, ChannelState>

export interface Snapshot {
  readonly activity: ActivityGateValue.Score
  readonly participantCount: number
}

export interface Interface {
  readonly observe: (message: Message) => Effect.Effect<Option.Option<Proposal>>
  readonly consume: (scopeId: ScopeId) => Effect.Effect<void>
  readonly snapshot: (scopeId: ScopeId) => Effect.Effect<Snapshot>
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/core/ActivityResponseMechanism',
) {}

const emptyChannelState = (now: number): ChannelState => ({
  activity: ActivityGateValue.Score.make(0),
  lastObservedAt: now,
  participants: HashMap.empty(),
})

const maximumPressure = (
  left: ActivityGateValue.Pressure,
  right: ActivityGateValue.Pressure,
): ActivityGateValue.Pressure => ActivityGateValue.Pressure.make(Math.max(left, right))

const proposal = (message: Message, options: Options, now: number): Proposal =>
  ProposalSchema.make({
    scopeId: scopeIdOf(message.scope),
    scope: message.scope,
    mergeKey: CHANNEL_CONVERSATION_MERGE_KEY,
    kind: 'activity',
    reason: Reason.make({
      mechanismId: ACTIVITY_MECHANISM_ID,
      code: ReasonCode.make('social-threshold'),
      priority: ACTIVITY_PRIORITY,
    }),
    focus: message.focus,
    submittedAt: EpochMilliseconds.make(now),
    expiresAt: EpochMilliseconds.make(now + options.proposalTtlMs),
    debounceMs: options.debounceMs,
    budgetCategory: 'normal',
    cooldownPolicy: 'enforce',
  })

export const layer = (options: Options = DEFAULT_OPTIONS) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const arbiter = yield* WakeArbiter.Service
      const state = yield* SynchronizedRef.make<State>(HashMap.empty())

      const observe = Effect.fn('ActivityResponseMechanism.observe')(function* (message: Message) {
        const now = yield* Clock.currentTimeMillis
        const scopeId = scopeIdOf(message.scope)
        const gate = yield* arbiter.gateStatus(scopeId)
        const minuteUsage = gate.budget.minute.usage.normal
        const dayUsage = gate.budget.day.usage.normal
        const recentCallPressure = GatePressure.budget(
          GatePressure.BudgetInput.make({
            used: ActivityGateValue.UsageCount.make(minuteUsage.pending + minuteUsage.committed),
            limit: ActivityGateValue.UsageCount.make(minuteUsage.limit),
          }),
        )
        const dailyBudgetPressure = GatePressure.budget(
          GatePressure.BudgetInput.make({
            used: ActivityGateValue.UsageCount.make(dayUsage.pending + dayUsage.committed),
            limit: ActivityGateValue.UsageCount.make(dayUsage.limit),
          }),
        )
        const cooldownPressure = GatePressure.cooldown(
          GatePressure.CooldownInput.make({
            elapsedSinceWakeMs: ActivityGateValue.Milliseconds.make(
              Math.max(0, gate.cooldownMs - gate.cooldownRemainingMs),
            ),
            cooldownMs: ActivityGateValue.Milliseconds.make(gate.cooldownMs),
          }),
        )
        const budgetPressure = maximumPressure(recentCallPressure, dailyBudgetPressure)

        return yield* SynchronizedRef.modify(state, (current) => {
          const previous = Option.getOrElse(HashMap.get(current, scopeId), () =>
            emptyChannelState(now),
          )
          const participantCutoff = now - ActivityScoring.NEW_PARTICIPANT_WINDOW_MS
          const activeParticipants = HashMap.filter(
            previous.participants,
            (lastSeen) => lastSeen >= participantCutoff,
          )
          const firstParticipant = Option.isNone(
            HashMap.get(activeParticipants, message.focus.authorId),
          )
          const elapsedMs = Math.max(0, now - previous.lastObservedAt)
          const update = ActivityScoring.update(
            ActivityScoring.UpdateInput.make({
              previousActivity: previous.activity,
              elapsedMs: ActivityGateValue.Milliseconds.make(elapsedMs),
              message: ActivityScoring.Message.make({
                isDuplicate: message.isDuplicate,
                isOtherBot: message.isOtherBot,
                isSelf: message.isSelf,
                isEffective: message.isEffective,
                isFirstParticipantInWindow: firstParticipant,
                isQuestion: message.isQuestionOrHelp,
                hasQuote: message.hasQuote,
                hasMedia: message.hasMedia,
              }),
            }),
            options.activityParameters,
          )
          const participants =
            message.isDuplicate || message.isOtherBot || message.isSelf || !message.isEffective
              ? activeParticipants
              : HashMap.set(activeParticipants, message.focus.authorId, now)
          const nextChannel: ChannelState = {
            activity: update.activity,
            lastObservedAt: now,
            participants,
          }
          const next = HashMap.set(current, scopeId, nextChannel)

          const relevance = LocalRelevance.calculate(
            LocalRelevance.Signals.make({
              isDuplicate: message.isDuplicate,
              isOtherBot: message.isOtherBot,
              isSelf: message.isSelf,
              explicitMention: message.explicitMention,
              replyToSelf: message.replyToSelf,
              mentionDegree: ActivityGateValue.Score.make(message.explicitMention ? 10 : 0),
              nameOrAliasEvidence: ActivityGateValue.Score.make(message.nameHit ? 2 : 0),
              questionOrHelpEvidence: ActivityGateValue.Score.make(
                message.isQuestionOrHelp ? 2 : 0,
              ),
              unfinishedItemEvidence: message.localState.unfinishedItemEvidence,
              threadOrInterestEvidence: message.localState.threadOrInterestEvidence,
              recentParticipationPressure: message.localState.recentParticipationPressure,
              sufficientResponsePressure: message.localState.sufficientResponsePressure,
              cooldownPressure,
              budgetPressure,
            }),
          )
          const activityThreshold = DynamicThreshold.calculate(
            DynamicThreshold.Input.make({
              baseThreshold: options.activityThreshold,
              recentCallPressure,
              dailyBudgetPressure,
              recentParticipationPressure: message.localState.recentParticipationPressure,
            }),
          )
          const relevanceThreshold = DynamicThreshold.calculate(
            DynamicThreshold.Input.make({
              baseThreshold: options.relevanceThreshold,
              recentCallPressure,
              dailyBudgetPressure,
              recentParticipationPressure: message.localState.recentParticipationPressure,
            }),
          )
          const budgetAvailable = minuteUsage.remaining > 0 && dayUsage.remaining > 0
          const eligible =
            !relevance.hardTrigger &&
            update.activity >= activityThreshold &&
            relevance.relevance >= relevanceThreshold &&
            gate.cooldownRemainingMs === 0 &&
            budgetAvailable

          return [eligible ? Option.some(proposal(message, options, now)) : Option.none(), next]
        })
      })

      const consume = Effect.fn('ActivityResponseMechanism.consume')(function* (scopeId: ScopeId) {
        yield* SynchronizedRef.update(state, (current) => {
          const channel = HashMap.get(current, scopeId)
          return Option.isNone(channel)
            ? current
            : HashMap.set(current, scopeId, {
                ...channel.value,
                activity: ActivityGateValue.Score.make(0),
              })
        })
      })

      const snapshot = Effect.fn('ActivityResponseMechanism.snapshot')(function* (
        scopeId: ScopeId,
      ) {
        const current = yield* SynchronizedRef.get(state)
        const channel = HashMap.get(current, scopeId)
        return Option.match(channel, {
          onNone: () => ({ activity: ActivityGateValue.Score.make(0), participantCount: 0 }),
          onSome: (value) => ({
            activity: value.activity,
            participantCount: HashMap.size(value.participants),
          }),
        })
      })

      return Service.of({ observe, consume, snapshot })
    }),
  )

export * as ActivityResponseMechanism from './activity-mechanism'
