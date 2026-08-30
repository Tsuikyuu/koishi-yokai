import { expect, it } from '@effect/vitest'
import { Context, Deferred, Effect } from 'effect'

import { BackgroundTasks } from '../../src/index'

class CallerValue extends Context.Service<CallerValue, string>()(
  '@yokai/core/test/BackgroundTasks/CallerValue',
) {}

it.effect('freezes the caller environment for host-owned tasks', () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>()
    const observed = yield* Deferred.make<string>()

    yield* Effect.gen(function* () {
      const backgroundTasks = yield* BackgroundTasks.Service
      yield* backgroundTasks
        .fork(
          Deferred.await(release).pipe(
            Effect.andThen(CallerValue),
            Effect.flatMap((value) => Deferred.succeed(observed, value)),
            Effect.asVoid,
          ),
        )
        .pipe(Effect.provideService(CallerValue, 'frozen'))

      yield* Deferred.succeed(release, undefined)
      expect(yield* Deferred.await(observed)).toBe('frozen')
    }).pipe(Effect.provide(BackgroundTasks.layer))
  }),
)

it.effect('interrupts unfinished tasks when the owning Layer scope closes', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const interrupted = yield* Deferred.make<void>()

    yield* Effect.gen(function* () {
      const backgroundTasks = yield* BackgroundTasks.Service
      yield* backgroundTasks.fork(
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      )
      yield* Deferred.await(started)
    }).pipe(Effect.provide(BackgroundTasks.layer))

    expect(yield* Deferred.isDone(interrupted)).toBe(true)
  }),
)
