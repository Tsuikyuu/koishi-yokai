import { Effect, Exit, Scope, type Cause } from 'effect'

import { type InitialGenerationResult, type ToolCallBatch } from '@yokai/protocol'

import type { AdapterConformanceControl, AdapterTestEvent } from '../conformance/index.js'

export type RequestStartedEvent = Extract<AdapterTestEvent, { readonly _tag: 'RequestStarted' }>

export const isRequestStarted = (event: AdapterTestEvent): event is RequestStartedEvent =>
  event._tag === 'RequestStarted'

export const requestStarts = (
  events: ReadonlyArray<AdapterTestEvent>,
  operation?: RequestStartedEvent['operation'],
): ReadonlyArray<RequestStartedEvent> =>
  events.filter(
    (event): event is RequestStartedEvent =>
      isRequestStarted(event) && (operation === undefined || event.operation === operation),
  )

export function takeStartedRequestId(
  control: AdapterConformanceControl,
  operation: RequestStartedEvent['operation'],
): Effect.Effect<number> {
  return control
    .takeEvent()
    .pipe(
      Effect.flatMap((event) =>
        isRequestStarted(event) && event.operation === operation
          ? Effect.succeed(event.requestId)
          : takeStartedRequestId(control, operation),
      ),
    )
}

export const makeTurnScope = Effect.gen(function* () {
  const scope = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
  return scope
})

export const requireToolCallBatch = (
  result: InitialGenerationResult,
): Effect.Effect<ToolCallBatch> =>
  result._tag === 'ToolCallBatch'
    ? Effect.succeed(result)
    : Effect.die('Expected a ToolCallBatch result')

export const requireFailureCause = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<Cause.Cause<E>> =>
  Exit.isFailure(exit) ? Effect.succeed(exit.cause) : Effect.die('Expected the fiber to fail')
