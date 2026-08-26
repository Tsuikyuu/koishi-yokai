import { Clock, Context, Effect, Layer, SynchronizedRef } from 'effect'

import * as Ledger from './ledger'
import {
  type BudgetExceededError,
  type Category,
  type FailurePhase,
  type Options,
  type Reservation,
  type ReservationId,
  type Snapshot,
} from './model'

export interface Interface {
  /** Atomically occupies one unit in both the current minute and local-day windows. */
  readonly reserve: (category: Category) => Effect.Effect<Reservation, BudgetExceededError>
  /** Converts an active reservation into charged usage. Repeated settlement returns false. */
  readonly commit: (reservationId: ReservationId) => Effect.Effect<boolean>
  /** Returns an active reservation without charging usage. Repeated settlement returns false. */
  readonly release: (reservationId: ReservationId) => Effect.Effect<boolean>
  /** Releases failures before provider dispatch and charges failures after provider dispatch. */
  readonly fail: (reservationId: ReservationId, phase: FailurePhase) => Effect.Effect<boolean>
  readonly snapshot: () => Effect.Effect<Snapshot>
}

export class Service extends Context.Service<Service, Interface>()('@yokai/core/CallBudget') {}

export const layer = (options: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const initialNow = yield* Clock.currentTimeMillis
      const state = yield* SynchronizedRef.make(Ledger.initialState(options, initialNow))

      const modifyAtCurrentTime = <A>(
        transition: (state: Ledger.State, now: number) => readonly [A, Ledger.State],
      ): Effect.Effect<A> =>
        SynchronizedRef.modifyEffect(state, (current) =>
          Clock.currentTimeMillis.pipe(Effect.map((now) => transition(current, now))),
        )

      const settle = Effect.fn('CallBudget.settle')(function* (
        reservationId: ReservationId,
        disposition: Ledger.Disposition,
      ) {
        return yield* modifyAtCurrentTime((current, now) =>
          Ledger.settle(current, options, reservationId, disposition, now),
        )
      })

      const reserve = Effect.fn('CallBudget.reserve')(function* (category: Category) {
        const decision = yield* modifyAtCurrentTime((current, now) =>
          Ledger.reserve(current, options, category, now),
        )
        if (decision._tag === 'Denied') return yield* Effect.fail(decision.error)
        return decision.reservation
      })

      const commit = Effect.fn('CallBudget.commit')(function* (reservationId: ReservationId) {
        return yield* settle(reservationId, 'commit')
      })

      const release = Effect.fn('CallBudget.release')(function* (reservationId: ReservationId) {
        return yield* settle(reservationId, 'release')
      })

      const fail = Effect.fn('CallBudget.fail')(function* (
        reservationId: ReservationId,
        phase: FailurePhase,
      ) {
        return yield* phase === 'before-dispatch' ? release(reservationId) : commit(reservationId)
      })

      const snapshot = Effect.fn('CallBudget.snapshot')(function* () {
        return yield* modifyAtCurrentTime((current, now) => Ledger.snapshot(current, options, now))
      })

      return Service.of({ reserve, commit, release, fail, snapshot })
    }),
  )

export * from './model'
export * as CallBudget from './call-budget'
