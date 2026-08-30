import {
  Cause,
  Clock,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  FiberMap,
  HashMap,
  Layer,
  Option,
  Ref,
  Semaphore,
  SynchronizedRef,
} from 'effect'

import { CallBudget } from '../call-budget/index'
import {
  type Batch,
  DurationMilliseconds,
  EpochMilliseconds,
  type Merged,
  type Proposal,
  type ScopeId,
  begin,
  identityOf,
  merge,
  resolve,
} from './proposal'

export const DEFAULT_COOLDOWN_MS = DurationMilliseconds.make(45_000)

export interface Options {
  readonly cooldownMs: DurationMilliseconds
}

export type Outcome = Data.TaggedEnum<{
  Executed: { readonly proposal: Merged }
  Skipped: { readonly proposal: Merged }
  Expired: { readonly proposal: Merged }
  CooldownDenied: { readonly proposal: Merged; readonly remainingMs: number }
  BudgetDenied: { readonly proposal: Merged }
  ExecutionFailed: { readonly proposal: Merged; readonly dispatched: boolean }
}>

export const Outcome = Data.taggedEnum<Outcome>()

export interface GateStatus {
  readonly lastWakeAt: Option.Option<EpochMilliseconds>
  readonly cooldownMs: DurationMilliseconds
  readonly cooldownRemainingMs: number
  readonly budget: CallBudget.Snapshot
}

export type MarkDispatched = () => Effect.Effect<boolean>

export type Admission<R = never> = (proposal: Merged) => Effect.Effect<boolean, never, R>

export type WithLogicalCallReservation = <A, E, R>(
  use: (markDispatched: MarkDispatched) => Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | CallBudget.BudgetExceededError, R>

export type Executor<R = never, E = never> = (
  proposal: Merged,
  markDispatched: MarkDispatched,
  withLogicalCallReservation: WithLogicalCallReservation,
) => Effect.Effect<void, E, R>

export interface Interface {
  readonly submit: <R, E>(
    proposal: Proposal,
    execute: Executor<R, E>,
  ) => Effect.Effect<Outcome, never, R>
  readonly submitWithAdmission: <R, E>(
    proposal: Proposal,
    admission: Admission<R>,
    execute: Executor<R, E>,
  ) => Effect.Effect<Outcome, never, R>
  readonly gateStatus: (scopeId: ScopeId) => Effect.Effect<GateStatus>
}

export class Service extends Context.Service<Service, Interface>()('@yokai/core/WakeArbiter') {}

interface PendingEntry {
  readonly sequence: number
  readonly revision: number
  readonly batch: Batch
  readonly admission: Admission
  readonly executor: Executor
  readonly completion: Deferred.Deferred<Outcome>
}

interface State {
  readonly nextSequence: number
  readonly pending: HashMap.HashMap<string, PendingEntry>
  readonly lastWake: HashMap.HashMap<ScopeId, EpochMilliseconds>
}

const initialState = (): State => ({
  nextSequence: 1,
  pending: HashMap.empty(),
  lastWake: HashMap.empty(),
})

const workerKey = (identity: string, sequence: number): string =>
  JSON.stringify([identity, sequence])

const remainingCooldown = (
  now: number,
  lastWakeAt: Option.Option<EpochMilliseconds>,
  cooldownMs: DurationMilliseconds,
): number =>
  Option.match(lastWakeAt, {
    onNone: () => 0,
    onSome: (lastWake) => Math.max(0, cooldownMs - Math.max(0, now - lastWake)),
  })

export const layer = (options: Options = { cooldownMs: DEFAULT_COOLDOWN_MS }) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const budget = yield* CallBudget.Service
      const state = yield* SynchronizedRef.make(initialState())
      const workers = yield* FiberMap.make<string>()
      const enqueueGate = yield* Semaphore.make(1)
      const channelLocks = yield* SynchronizedRef.make<
        HashMap.HashMap<ScopeId, Semaphore.Semaphore>
      >(HashMap.empty())

      const channelLock = Effect.fn('WakeArbiter.channelLock')(function* (scopeId: ScopeId) {
        return yield* SynchronizedRef.modifyEffect(channelLocks, (current) => {
          const existing = HashMap.get(current, scopeId)
          if (Option.isSome(existing)) return Effect.succeed([existing.value, current])
          return Semaphore.make(1).pipe(
            Effect.map((created) => [created, HashMap.set(current, scopeId, created)]),
          )
        })
      })

      const claim = Effect.fn('WakeArbiter.claim')(function* (
        identity: string,
        sequence: number,
        revision: number,
      ) {
        return yield* SynchronizedRef.modify(state, (current) => {
          const pending = HashMap.get(current.pending, identity)
          if (
            Option.isNone(pending) ||
            pending.value.sequence !== sequence ||
            pending.value.revision !== revision
          ) {
            return [Option.none<PendingEntry>(), current]
          }
          return [
            Option.some(pending.value),
            { ...current, pending: HashMap.remove(current.pending, identity) },
          ]
        })
      })

      const markWake = Effect.fn('WakeArbiter.markWake')(function* (scopeId: ScopeId) {
        const now = yield* Clock.currentTimeMillis
        yield* SynchronizedRef.update(state, (current) => ({
          ...current,
          lastWake: HashMap.set(current.lastWake, scopeId, EpochMilliseconds.make(now)),
        }))
      })

      const executeClaimed = (
        proposal: Merged,
        admission: Admission,
        execute: Executor,
      ): Effect.Effect<Outcome> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          if (proposal.expiresAt <= now) return Outcome.Expired({ proposal })

          if (proposal.cooldownPolicy === 'enforce') {
            const current = yield* SynchronizedRef.get(state)
            const remainingMs = remainingCooldown(
              now,
              HashMap.get(current.lastWake, proposal.scopeId),
              options.cooldownMs,
            )
            if (remainingMs > 0) return Outcome.CooldownDenied({ proposal, remainingMs })
          }

          const reservation = yield* budget.reserve(proposal.budgetCategory).pipe(Effect.option)
          if (Option.isNone(reservation)) return Outcome.BudgetDenied({ proposal })

          return yield* Effect.gen(function* () {
            const admitted = yield* admission(proposal).pipe(
              Effect.map(Option.some),
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.interrupt
                  : Effect.logError('WakeArbiter.admission_failed', cause).pipe(
                      Effect.as(Option.none<boolean>()),
                    ),
              ),
            )
            if (Option.isNone(admitted)) {
              return Outcome.ExecutionFailed({ proposal, dispatched: false })
            }
            if (!admitted.value) return Outcome.Skipped({ proposal })

            const dispatched = yield* Ref.make(false)
            const markDispatched = Effect.fn('WakeArbiter.markDispatched')(function* () {
              const alreadyDispatched = yield* Ref.getAndSet(dispatched, true)
              if (alreadyDispatched) return false
              return yield* budget.commit(reservation.value.id)
            })

            const withLogicalCallReservation: WithLogicalCallReservation = (use) =>
              Effect.acquireUseRelease(
                Effect.gen(function* () {
                  const logicalCallReservation = yield* budget.reserve(proposal.budgetCategory)
                  const logicalCallDispatched = yield* Ref.make(false)
                  const markLogicalCallDispatched = Effect.fn(
                    'WakeArbiter.markLogicalCallDispatched',
                  )(function* () {
                    const alreadyDispatched = yield* Ref.getAndSet(logicalCallDispatched, true)
                    if (alreadyDispatched) return false
                    return yield* budget.commit(logicalCallReservation.id)
                  })
                  return { logicalCallReservation, markLogicalCallDispatched }
                }),
                ({ markLogicalCallDispatched }) => use(markLogicalCallDispatched),
                ({ logicalCallReservation }) =>
                  budget.release(logicalCallReservation.id).pipe(Effect.asVoid),
              )

            const executionFailed = yield* execute(
              proposal,
              markDispatched,
              withLogicalCallReservation,
            ).pipe(
              Effect.as(false),
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.interrupt
                  : Effect.logError('WakeArbiter.turn_failed', cause).pipe(Effect.as(true)),
              ),
            )
            const wasDispatched = yield* Ref.get(dispatched)
            if (wasDispatched) yield* markWake(proposal.scopeId)
            if (executionFailed) {
              return Outcome.ExecutionFailed({ proposal, dispatched: wasDispatched })
            }
            return wasDispatched ? Outcome.Executed({ proposal }) : Outcome.Skipped({ proposal })
          }).pipe(Effect.ensuring(budget.release(reservation.value.id).pipe(Effect.asVoid)))
        }).pipe(Effect.withSpan('WakeArbiter.executeClaimed'))

      const runPending = (identity: string, entry: PendingEntry): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* Effect.sleep(Duration.millis(entry.batch.primary.debounceMs))
          const claimed = yield* claim(identity, entry.sequence, entry.revision)
          if (Option.isNone(claimed)) return

          const merged = resolve(claimed.value.batch)
          const lock = yield* channelLock(merged.scopeId)
          const outcome = yield* lock.withPermit(
            executeClaimed(merged, claimed.value.admission, claimed.value.executor),
          )
          yield* Deferred.succeed(claimed.value.completion, outcome)
        }).pipe(Effect.withSpan('WakeArbiter.runPending'))

      const submitWithAdmission = <R, E>(
        proposal: Proposal,
        admission: Admission<R>,
        execute: Executor<R, E>,
      ): Effect.Effect<Outcome, never, R> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          if (proposal.expiresAt <= now) {
            return Outcome.Expired({ proposal: resolve(begin(proposal)) })
          }

          const environment = yield* Effect.context<R>()
          const providedAdmission: Admission = (merged) =>
            admission(merged).pipe(Effect.provide(environment))
          const providedExecutor: Executor = (merged, markDispatched, withLogicalCallReservation) =>
            execute(merged, markDispatched, withLogicalCallReservation).pipe(
              Effect.provide(environment),
              Effect.orDie,
            )
          const candidateCompletion = yield* Deferred.make<Outcome>()
          const identity = identityOf(proposal)

          const entry = yield* enqueueGate.withPermit(
            Effect.gen(function* () {
              const pending = yield* SynchronizedRef.modify(state, (current) => {
                const existing = HashMap.get(current.pending, identity)
                if (Option.isSome(existing)) {
                  const batch = merge(existing.value.batch, proposal)
                  const updated: PendingEntry = {
                    ...existing.value,
                    revision: existing.value.revision + 1,
                    batch,
                    admission:
                      batch.primary === proposal ? providedAdmission : existing.value.admission,
                    executor:
                      batch.primary === proposal ? providedExecutor : existing.value.executor,
                  }
                  return [
                    updated,
                    { ...current, pending: HashMap.set(current.pending, identity, updated) },
                  ]
                }

                const created: PendingEntry = {
                  sequence: current.nextSequence,
                  revision: 1,
                  batch: begin(proposal),
                  admission: providedAdmission,
                  executor: providedExecutor,
                  completion: candidateCompletion,
                }
                return [
                  created,
                  {
                    ...current,
                    nextSequence: current.nextSequence + 1,
                    pending: HashMap.set(current.pending, identity, created),
                  },
                ]
              })

              yield* FiberMap.run(
                workers,
                workerKey(identity, pending.sequence),
                runPending(identity, pending),
              )
              return pending
            }),
          )

          return yield* Deferred.await(entry.completion)
        })

      const submit = <R, E>(
        proposal: Proposal,
        execute: Executor<R, E>,
      ): Effect.Effect<Outcome, never, R> =>
        submitWithAdmission(proposal, () => Effect.succeed(true), execute)

      const gateStatus = Effect.fn('WakeArbiter.gateStatus')(function* (scopeId: ScopeId) {
        const now = yield* Clock.currentTimeMillis
        const current = yield* SynchronizedRef.get(state)
        const lastWakeAt = HashMap.get(current.lastWake, scopeId)
        return {
          lastWakeAt,
          cooldownMs: options.cooldownMs,
          cooldownRemainingMs: remainingCooldown(now, lastWakeAt, options.cooldownMs),
          budget: yield* budget.snapshot(),
        } satisfies GateStatus
      })

      return Service.of({ submit, submitWithAdmission, gateStatus })
    }),
  )

export * as WakeArbiter from './arbiter'
