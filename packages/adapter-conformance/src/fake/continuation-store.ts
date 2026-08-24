import { Data, Effect, HashMap, Option, Redacted, Ref, Scope } from 'effect'

import {
  type AdapterContinuation,
  type AdapterId,
  type AdapterModelId,
  type ToolCalls,
  makeAdapterContinuation,
  makeAdapterContinuationError,
} from 'yokai-protocol'

type ContinuationState = Data.TaggedEnum<{
  readonly Pending: {
    readonly modelId: AdapterModelId
    readonly calls: ToolCalls
    readonly owningScope: Scope.Scope
  }
  readonly Claimed: {
    readonly modelId: AdapterModelId
    readonly calls: ToolCalls
    readonly owningScope: Scope.Scope
  }
}>

const ContinuationState = Data.taggedEnum<ContinuationState>()

export interface ClaimedContinuation {
  readonly key: string
  readonly modelId: AdapterModelId
  readonly calls: ToolCalls
  readonly owningScope: Scope.Scope
}

export interface FakeContinuationStore {
  readonly create: (
    modelId: AdapterModelId,
    calls: ToolCalls,
  ) => Effect.Effect<AdapterContinuation, never, Scope.Scope>
  readonly claim: (
    continuation: AdapterContinuation,
  ) => Effect.Effect<ClaimedContinuation, ReturnType<typeof makeAdapterContinuationError>>
  readonly remove: (key: string) => Effect.Effect<void>
  readonly clear: () => Effect.Effect<void>
  readonly size: () => Effect.Effect<number>
}

export const makeFakeContinuationStore = Effect.fn('FakeAdapter.ContinuationStore.make')(function* (
  adapterId: AdapterId,
  tokenNamespace: string,
) {
  const states = yield* Ref.make(HashMap.empty<string, ContinuationState>())
  const nextToken = yield* Ref.make(1)

  const remove = Effect.fn('FakeAdapter.ContinuationStore.remove')(function* (key: string) {
    yield* Ref.update(states, (current) => HashMap.remove(current, key))
  })

  const create = Effect.fn('FakeAdapter.ContinuationStore.create')(function* (
    modelId: AdapterModelId,
    calls: ToolCalls,
  ) {
    const owningScope = yield* Effect.scope
    const resource = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const sequence = yield* Ref.getAndUpdate(nextToken, (value) => value + 1)
        const continuation = yield* makeAdapterContinuation(
          `fake:${adapterId}:${tokenNamespace}:${sequence}`,
        ).pipe(Effect.orDie)
        const key = Redacted.value(continuation)
        yield* Ref.update(states, (current) =>
          HashMap.set(current, key, ContinuationState.Pending({ modelId, calls, owningScope })),
        )
        return { continuation, key }
      }),
      (entry) => remove(entry.key),
    )
    return resource.continuation
  })

  const continuationKey = Effect.fn('FakeAdapter.ContinuationStore.key')(
    (continuation: AdapterContinuation) =>
      Effect.try({
        try: () => Redacted.value(continuation),
        catch: () => makeAdapterContinuationError(adapterId),
      }),
  )

  const claim = Effect.fn('FakeAdapter.ContinuationStore.claim')(function* (
    continuation: AdapterContinuation,
  ) {
    const key = yield* continuationKey(continuation)
    const state = yield* Ref.modify(states, (current) => {
      const candidate = HashMap.get(current, key)
      if (Option.isNone(candidate) || candidate.value._tag === 'Claimed') {
        return [Option.none<ContinuationState>(), current]
      }
      const pending = candidate.value
      return [
        Option.some(pending),
        HashMap.set(
          current,
          key,
          ContinuationState.Claimed({
            modelId: pending.modelId,
            calls: pending.calls,
            owningScope: pending.owningScope,
          }),
        ),
      ]
    })

    if (Option.isNone(state)) {
      return yield* Effect.fail(makeAdapterContinuationError(adapterId))
    }

    return {
      key,
      modelId: state.value.modelId,
      calls: state.value.calls,
      owningScope: state.value.owningScope,
    }
  })

  return {
    create,
    claim,
    remove,
    clear: Effect.fn('FakeAdapter.ContinuationStore.clear')(function* () {
      yield* Ref.set(states, HashMap.empty())
    }),
    size: Effect.fn('FakeAdapter.ContinuationStore.size')(function* () {
      return HashMap.size(yield* Ref.get(states))
    }),
  } satisfies FakeContinuationStore
})
