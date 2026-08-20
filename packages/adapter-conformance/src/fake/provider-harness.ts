import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  HashMap,
  Option,
  Queue,
  Ref,
  Scope,
} from 'effect'

import type {
  AdapterInvocationError,
  AdapterInvocationOperation,
  AdapterModelId,
  ToolCallId,
} from '@yokai/protocol'

import type {
  AdapterConformanceControl,
  AdapterDiscoveryStep,
  AdapterGenerationStep,
  AdapterTestEvent,
  AdapterTestProviderRequestKind,
} from '../index'

type FakeProviderResponse = AdapterDiscoveryStep | AdapterGenerationStep

export interface FakeProviderRequest {
  readonly kind: AdapterTestProviderRequestKind
  readonly operation: AdapterInvocationOperation
  readonly modelId: Option.Option<AdapterModelId>
  readonly resultCallIds: ReadonlyArray<ToolCallId>
  readonly owningScope: Option.Option<Scope.Scope>
}

export interface FakeProviderHarness {
  readonly control: AdapterConformanceControl
  readonly run: <A extends FakeProviderResponse>(
    request: FakeProviderRequest,
    blocked: boolean,
    response: Effect.Effect<A, AdapterInvocationError>,
  ) => Effect.Effect<A, AdapterInvocationError>
}

const makeStartedEvent = (requestId: number, request: FakeProviderRequest): AdapterTestEvent =>
  Option.match(request.modelId, {
    onNone: () => ({
      _tag: 'RequestStarted',
      requestId,
      kind: request.kind,
      operation: request.operation,
      resultCallIds: request.resultCallIds,
    }),
    onSome: (modelId) => ({
      _tag: 'RequestStarted',
      requestId,
      kind: request.kind,
      operation: request.operation,
      modelId,
      resultCallIds: request.resultCallIds,
    }),
  })

const makeTerminalEvent = (
  requestId: number,
  exit: Exit.Exit<FakeProviderResponse, AdapterInvocationError>,
): AdapterTestEvent => {
  if (Exit.isSuccess(exit)) {
    return { _tag: 'RequestSucceeded', requestId }
  }
  return Cause.hasInterrupts(exit.cause)
    ? { _tag: 'RequestCancelled', requestId }
    : { _tag: 'RequestFailed', requestId }
}

export const makeFakeProviderHarness = Effect.fn('FakeAdapter.ProviderHarness.make')(function* () {
  const events = yield* Ref.make<ReadonlyArray<AdapterTestEvent>>([])
  const eventQueue = yield* Queue.unbounded<AdapterTestEvent>()
  const gates = yield* Ref.make(HashMap.empty<number, Deferred.Deferred<void>>())
  const nextRequestId = yield* Ref.make(1)
  const active = yield* Ref.make(0)
  const providerFibers = yield* FiberSet.make<FakeProviderResponse, AdapterInvocationError>()

  const publish = Effect.fn('FakeAdapter.ProviderHarness.publish')(function* (
    event: AdapterTestEvent,
  ) {
    yield* Ref.update(events, (history) => [...history, event])
    yield* Queue.offer(eventQueue, event)
  })

  const release = Effect.fn('FakeAdapter.ProviderHarness.release')(function* (requestId: number) {
    const gate = yield* Ref.get(gates).pipe(
      Effect.map((current) => HashMap.get(current, requestId)),
    )
    return yield* Option.match(gate, {
      onNone: () => Effect.succeed(false),
      onSome: (deferred) => Deferred.succeed(deferred, undefined),
    })
  })

  const run = Effect.fn('FakeAdapter.ProviderHarness.run')(function* <
    A extends FakeProviderResponse,
  >(
    request: FakeProviderRequest,
    blocked: boolean,
    response: Effect.Effect<A, AdapterInvocationError>,
  ) {
    const observed = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const requestId = yield* Ref.getAndUpdate(nextRequestId, (value) => value + 1)
        const gate = blocked
          ? Option.some(yield* Deferred.make<void>())
          : Option.none<Deferred.Deferred<void>>()

        if (Option.isSome(gate)) {
          yield* Ref.update(gates, (current) => HashMap.set(current, requestId, gate.value))
        }

        yield* Ref.update(active, (count) => count + 1)
        yield* publish(makeStartedEvent(requestId, request))

        const waitForRelease = Option.match(gate, {
          onNone: () => Effect.void,
          onSome: Deferred.await,
        })

        return yield* restore(waitForRelease.pipe(Effect.andThen(response))).pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              yield* Ref.update(gates, (current) => HashMap.remove(current, requestId))
              yield* Ref.update(active, (count) => count - 1)
              yield* publish(makeTerminalEvent(requestId, exit))
            }),
          ),
        )
      }),
    )

    const acquireFiber = Effect.gen(function* () {
      const fiber = yield* FiberSet.run(providerFibers, observed)
      if (Option.isSome(request.owningScope)) {
        yield* Scope.addFinalizer(request.owningScope.value, Fiber.interrupt(fiber))
      }
      return fiber
    })

    return yield* Effect.acquireUseRelease(acquireFiber, Fiber.join, Fiber.interrupt)
  })

  return {
    control: {
      takeEvent: Effect.fn('FakeAdapter.Control.takeEvent')(function* () {
        return yield* Queue.take(eventQueue)
      }),
      events: Effect.fn('FakeAdapter.Control.events')(function* () {
        return yield* Ref.get(events)
      }),
      release,
      activeRequests: Effect.fn('FakeAdapter.Control.activeRequests')(function* () {
        return yield* Ref.get(active)
      }),
    },
    run,
  } satisfies FakeProviderHarness
})
