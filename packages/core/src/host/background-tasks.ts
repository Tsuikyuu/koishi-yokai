import { Context, Effect, FiberSet, Layer } from 'effect'

export type Fork = <R>(task: Effect.Effect<void, never, R>) => Effect.Effect<void, never, R>

export interface Interface {
  /** Fork a task with the caller's current environment into the host-owned Layer scope. */
  readonly fork: Fork
}

export class Service extends Context.Service<Service, Interface>()('@yokai/core/BackgroundTasks') {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fibers = yield* FiberSet.make<void, never>()

    const fork: Fork = Effect.fn('BackgroundTasks.fork')(<R>(task: Effect.Effect<void, never, R>) =>
      FiberSet.runtime(fibers)<R>().pipe(
        Effect.map((run) => {
          run(task)
        }),
      ),
    )

    return Service.of({ fork })
  }),
)

export * as BackgroundTasks from './background-tasks'
