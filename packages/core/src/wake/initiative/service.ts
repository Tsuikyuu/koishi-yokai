import { MessageArchiveEvent, Notebook, NotebookModel } from '@yokai-internal/memory'
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  FiberMap,
  HashMap,
  Layer,
  Option,
  Schema,
  SynchronizedRef,
} from 'effect'

import { HostConfiguration } from '../../host/configuration'
import { PresetRegistry } from '../../preset/registry'
import { RoleState } from '../../role-state/role-state'
import { WakeArbiter } from '../arbiter'
import {
  EpochMilliseconds,
  INITIATIVE_INTRINSIC_REASON_CODE,
  INITIATIVE_MECHANISM_ID,
  INITIATIVE_MERGE_KEY,
  INITIATIVE_RECENT_REASON_CODE,
  INITIATIVE_UNFINISHED_REASON_CODE,
  InitiativeAudit,
  Priority,
  Proposal,
  Reason,
  type ReasonCode,
  type ScopeId,
  scopeIdOf,
} from '../proposal'
import { InitiativeDelivery } from './delivery'
import { AdmissionToken, type Observation, type Options, Revision, Snapshot, Target } from './model'
import { InitiativePolicy, type Motivation } from './policy'

export const UNFINISHED_PRIORITY = Priority.make(3)
export const RECENT_PRIORITY = Priority.make(2)
export const INTRINSIC_PRIORITY = Priority.make(1)

interface ChannelState {
  readonly revision: Revision
  readonly observation: Option.Option<Observation>
  readonly focusMessageId: string
  readonly observedAt: EpochMilliseconds
  readonly lastIntrinsicAt: Option.Option<EpochMilliseconds>
  readonly acceptedRevision: Option.Option<Revision>
}

type State = HashMap.HashMap<ScopeId, ChannelState>

interface Evaluation {
  readonly motivation: Motivation
}

export interface Interface {
  readonly observe: (observation: Observation) => Effect.Effect<void>
  readonly snapshot: (scopeId: ScopeId) => Effect.Effect<Option.Option<Snapshot>>
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/core/InitiativeResponseMechanism',
) {}

const decodeChannelScope = Schema.decodeUnknownEffect(MessageArchiveEvent.ChannelScope)

const participantIds = (observation: Observation): ReadonlyArray<string> =>
  [observation.message.focus.authorId, ...observation.scene.thread.participants]
    .filter((participantId, index, participants) => participants.indexOf(participantId) === index)
    .slice(0, RoleState.MAX_SNAPSHOT_MEMBERS)

const budgetAvailable = (gate: WakeArbiter.GateStatus): boolean => {
  const minute = gate.budget.minute.usage.background
  const day = gate.budget.day.usage.background
  return minute.remaining > 0 && day.remaining > 0
}

const channelCooldownRemaining = (
  gate: WakeArbiter.GateStatus,
  now: number,
  options: Options,
): number =>
  Math.max(
    gate.cooldownRemainingMs,
    Option.match(gate.lastWakeAt, {
      onNone: () => 0,
      onSome: (lastWakeAt) =>
        Math.max(0, options.channelCooldownMs - Math.max(0, now - lastWakeAt)),
    }),
  )

const outsideChannelCooldown = (
  gate: WakeArbiter.GateStatus,
  now: number,
  options: Options,
): boolean => channelCooldownRemaining(gate, now, options) === 0

const reasonCode = (motivation: Motivation): ReasonCode => {
  switch (motivation._tag) {
    case 'UnfinishedTopic':
      return INITIATIVE_UNFINISHED_REASON_CODE
    case 'RelevantRecentContent':
      return INITIATIVE_RECENT_REASON_CODE
    case 'IntrinsicOpportunity':
      return INITIATIVE_INTRINSIC_REASON_CODE
  }
}

const priority = (motivation: Motivation): Priority => {
  switch (motivation._tag) {
    case 'UnfinishedTopic':
      return UNFINISHED_PRIORITY
    case 'RelevantRecentContent':
      return RECENT_PRIORITY
    case 'IntrinsicOpportunity':
      return INTRINSIC_PRIORITY
  }
}

const auditOf = (motivation: Motivation): InitiativeAudit => {
  switch (motivation._tag) {
    case 'UnfinishedTopic':
      return InitiativeAudit.cases.UnfinishedTopic.make({
        threadId: motivation.threadId,
        stateUpdatedAt: motivation.stateUpdatedAt,
      })
    case 'RelevantRecentContent':
      return InitiativeAudit.cases.RelevantRecentContent.make({
        sourceMessageId: motivation.sourceMessageId,
        score: motivation.score,
      })
    case 'IntrinsicOpportunity':
      return InitiativeAudit.cases.IntrinsicOpportunity.make({
        sources: motivation.sources,
        presetVersion: motivation.presetVersion,
        stateUpdatedAt: motivation.stateUpdatedAt,
        selfNoteIds: motivation.selfNoteIds,
      })
  }
}

const makeProposal = (
  observation: Observation,
  motivation: Motivation,
  options: Options,
  now: number,
): Proposal =>
  Proposal.make({
    scopeId: scopeIdOf(observation.message.scope),
    scope: observation.message.scope,
    mergeKey: INITIATIVE_MERGE_KEY,
    kind: 'initiative',
    reason: Reason.make({
      mechanismId: INITIATIVE_MECHANISM_ID,
      code: reasonCode(motivation),
      priority: priority(motivation),
      initiativeAudit: auditOf(motivation),
    }),
    focus: observation.message.focus,
    submittedAt: EpochMilliseconds.make(now),
    expiresAt: EpochMilliseconds.make(
      Math.min(Number.MAX_SAFE_INTEGER, now + options.proposalTtlMs),
    ),
    debounceMs: options.debounceMs,
    budgetCategory: 'background',
    cooldownPolicy: 'enforce',
  })

const isEligibleObservation = (observation: Observation): boolean => {
  const message = observation.message
  return (
    !observation.isDirect &&
    !message.isDuplicate &&
    !message.isOtherBot &&
    !message.isSelf &&
    message.isEffective
  )
}

const tokenMatches = (
  channel: ChannelState,
  token: AdmissionToken,
  motivation: Motivation,
  now: number,
  options: Options,
): boolean =>
  channel.revision === token.revision &&
  channel.focusMessageId === token.focusMessageId &&
  Option.match(channel.acceptedRevision, {
    onNone: () => true,
    onSome: (accepted) => accepted !== token.revision,
  }) &&
  Math.max(0, now - channel.observedAt) >= options.quietPeriodMs &&
  (motivation._tag !== 'IntrinsicOpportunity' ||
    Option.match(channel.lastIntrinsicAt, {
      onNone: () => true,
      onSome: (lastIntrinsicAt) =>
        Math.max(0, now - lastIntrinsicAt) >= options.intrinsicIntervalMs,
    }))

const logFailure = <E>(message: string, cause: Cause.Cause<E>, scopeId: ScopeId) =>
  Effect.logError(message, cause).pipe(Effect.annotateLogs({ scopeId }))

const recoverWorker = <E, R>(
  effect: Effect.Effect<void, E, R>,
  scopeId: ScopeId,
): Effect.Effect<void, never, R> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : logFailure('InitiativeResponseMechanism.worker_failed', cause, scopeId),
    ),
  )

const recoverAdmission = <E, R>(
  effect: Effect.Effect<boolean, E, R>,
  scopeId: ScopeId,
): Effect.Effect<boolean, never, R> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : logFailure('InitiativeResponseMechanism.admission_failed', cause, scopeId).pipe(
            Effect.as(false),
          ),
    ),
  )

export const layer = (options: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const configuration = yield* HostConfiguration.Service
      const delivery = yield* InitiativeDelivery.Service
      const notebook = yield* Notebook.Service
      const presets = yield* PresetRegistry.Service
      const roleState = yield* RoleState.Service
      const arbiter = yield* WakeArbiter.Service
      const state = yield* SynchronizedRef.make<State>(HashMap.empty())
      const workers = yield* FiberMap.make<ScopeId>()

      const evaluate = Effect.fn('InitiativeResponseMechanism.evaluate')(function* (
        observation: Observation,
        budgetAlreadyReserved: boolean,
      ) {
        if (Option.isNone(configuration.presetId)) return Option.none<Evaluation>()
        const preset = yield* presets.snapshot(configuration.presetId.value)
        if (Option.isNone(preset)) return Option.none<Evaluation>()

        const now = yield* Clock.currentTimeMillis
        const scopeId = scopeIdOf(observation.message.scope)
        const gate = yield* arbiter.gateStatus(scopeId)
        if (
          (!budgetAlreadyReserved && !budgetAvailable(gate)) ||
          !outsideChannelCooldown(gate, now, options)
        ) {
          return Option.none<Evaluation>()
        }

        const snapshot = yield* roleState.snapshot(
          observation.message.scope,
          participantIds(observation),
        )
        const channelScope = yield* decodeChannelScope(observation.message.scope)
        const selfMemory = yield* notebook.findRecallableEvidence(
          NotebookModel.EvidenceRequest.make({
            scope: channelScope,
            kind: 'self',
            limit: NotebookModel.RecallLimit.make(1),
          }),
        )
        return Option.map(
          InitiativePolicy.decide(
            {
              observation,
              roleState: snapshot,
              preset: preset.value,
              selfMemory,
              now,
            },
            options,
          ),
          (motivation) => ({ motivation }),
        )
      })

      const admit = Effect.fn('InitiativeResponseMechanism.admit')(function* (
        token: AdmissionToken,
        expected: Motivation,
      ) {
        const before = yield* SynchronizedRef.get(state)
        const stored = HashMap.get(before, token.scopeId)
        const now = yield* Clock.currentTimeMillis
        if (
          Option.isNone(stored) ||
          Option.isNone(stored.value.observation) ||
          !tokenMatches(stored.value, token, expected, now, options)
        ) {
          return false
        }

        const evaluated = yield* evaluate(stored.value.observation.value, true)
        if (
          Option.isNone(evaluated) ||
          !InitiativePolicy.sameAdmissionEvidence(evaluated.value.motivation, expected)
        ) {
          return false
        }

        const acceptedAt = EpochMilliseconds.make(yield* Clock.currentTimeMillis)
        return yield* SynchronizedRef.modify(state, (current) => {
          const latest = HashMap.get(current, token.scopeId)
          if (
            Option.isNone(latest) ||
            !tokenMatches(latest.value, token, expected, acceptedAt, options)
          ) {
            return [false, current]
          }
          const updated: ChannelState = {
            ...latest.value,
            acceptedRevision: Option.some(token.revision),
            lastIntrinsicAt:
              expected._tag === 'IntrinsicOpportunity'
                ? Option.some(acceptedAt)
                : latest.value.lastIntrinsicAt,
          }
          return [true, HashMap.set(current, token.scopeId, updated)]
        })
      })

      const attempt = Effect.fn('InitiativeResponseMechanism.attempt')(function* (
        scopeId: ScopeId,
        revision: Revision,
      ) {
        const current = yield* SynchronizedRef.get(state)
        const stored = HashMap.get(current, scopeId)
        if (
          Option.isNone(stored) ||
          stored.value.revision !== revision ||
          Option.isNone(stored.value.observation)
        ) {
          return
        }
        const observation = stored.value.observation.value

        const target = Target.make({
          scope: observation.message.scope,
          selfId: observation.selfId,
        })
        if (!(yield* delivery.isAvailable(target))) return

        const evaluated = yield* evaluate(observation, false)
        if (Option.isNone(evaluated)) return
        const now = yield* Clock.currentTimeMillis
        const token = AdmissionToken.make({
          scopeId,
          revision,
          focusMessageId: stored.value.focusMessageId,
        })
        if (!tokenMatches(stored.value, token, evaluated.value.motivation, now, options)) return

        const proposal = makeProposal(observation, evaluated.value.motivation, options, now)
        const outcome = yield* delivery.dispatch({
          target,
          proposal,
          admission: () => recoverAdmission(admit(token, evaluated.value.motivation), scopeId),
        })
        yield* Effect.logDebug('InitiativeResponseMechanism.completed').pipe(
          Effect.annotateLogs({
            scopeId,
            outcome: outcome._tag,
            motivation: evaluated.value.motivation._tag,
            initiativeAudit: JSON.stringify(proposal.reason.initiativeAudit),
          }),
        )
      })

      const attemptAfterCooldown = Effect.fn('InitiativeResponseMechanism.awaitCooldown')(
        function* (scopeId: ScopeId, revision: Revision) {
          while (true) {
            const current = yield* SynchronizedRef.get(state)
            const stored = HashMap.get(current, scopeId)
            if (Option.isNone(stored) || stored.value.revision !== revision) return

            const now = yield* Clock.currentTimeMillis
            const gate = yield* arbiter.gateStatus(scopeId)
            if (!budgetAvailable(gate)) return
            const remainingMs = channelCooldownRemaining(gate, now, options)
            if (remainingMs === 0) return yield* attempt(scopeId, revision)
            yield* Effect.sleep(Duration.millis(remainingMs))
          }
        },
      )

      const releaseObservation = Effect.fn('InitiativeResponseMechanism.releaseObservation')(
        function* (scopeId: ScopeId, revision: Revision) {
          yield* SynchronizedRef.update(state, (current) => {
            const stored = HashMap.get(current, scopeId)
            if (Option.isNone(stored) || stored.value.revision !== revision) return current
            return HashMap.set(current, scopeId, {
              ...stored.value,
              observation: Option.none(),
            })
          })
        },
      )

      const observe = Effect.fn('InitiativeResponseMechanism.observe')(function* (
        observation: Observation,
      ) {
        if (!options.enabled || !isEligibleObservation(observation)) return
        const now = EpochMilliseconds.make(yield* Clock.currentTimeMillis)
        const scopeId = scopeIdOf(observation.message.scope)
        const revision = yield* SynchronizedRef.modify(state, (current) => {
          const previous = HashMap.get(current, scopeId)
          const nextRevision = Revision.make(
            Option.match(previous, {
              onNone: () => 1,
              onSome: (channel) => channel.revision + 1,
            }),
          )
          const channel: ChannelState = {
            revision: nextRevision,
            observation: Option.some(observation),
            focusMessageId: observation.message.focus.messageId,
            observedAt: now,
            lastIntrinsicAt: Option.match(previous, {
              onNone: () => Option.none<EpochMilliseconds>(),
              onSome: (value) => value.lastIntrinsicAt,
            }),
            acceptedRevision: Option.none(),
          }
          return [nextRevision, HashMap.set(current, scopeId, channel)]
        })

        yield* FiberMap.run(
          workers,
          scopeId,
          recoverWorker(
            Effect.sleep(Duration.millis(options.quietPeriodMs)).pipe(
              Effect.andThen(attemptAfterCooldown(scopeId, revision)),
            ),
            scopeId,
          ).pipe(Effect.ensuring(releaseObservation(scopeId, revision))),
          { startImmediately: true },
        )
      })

      const snapshot = Effect.fn('InitiativeResponseMechanism.snapshot')(function* (
        scopeId: ScopeId,
      ) {
        const current = yield* SynchronizedRef.get(state)
        return Option.map(HashMap.get(current, scopeId), (channel) =>
          Snapshot.make({
            scopeId,
            revision: channel.revision,
            focusMessageId: channel.focusMessageId,
            observedAt: channel.observedAt,
            lastIntrinsicAt: channel.lastIntrinsicAt,
            acceptedRevision: channel.acceptedRevision,
          }),
        )
      })

      return Service.of({ observe, snapshot })
    }),
  )

export {
  AdmissionToken,
  Observation,
  Options,
  PositiveDurationMilliseconds,
  Revision,
  SelfId,
  Snapshot,
  Target,
} from './model'
export { InitiativePolicy } from './policy'
export { InitiativeDelivery } from './delivery'

export * as InitiativeResponseMechanism from './service'
