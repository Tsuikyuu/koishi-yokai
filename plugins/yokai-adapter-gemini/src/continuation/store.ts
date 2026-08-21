import type { Content, GenerateContentConfig } from '@google/genai'
import {
  type AdapterId,
  AdapterInternalError,
  type AdapterContinuation,
  type AdapterInvocationError,
  type AdapterModelId,
  type FeedbackToolId,
  type ToolCallId,
  type ToolCalls,
  makeAdapterContinuation,
  makeAdapterContinuationError,
} from '@yokai/protocol'
import { Context, Data, Effect, HashMap, Layer, Option, Redacted, Ref, Scope } from 'effect'

import { GeminiConnection } from '../connection/connection'
import { GeminiContinuationTokenGenerator } from './token-generator'

export interface PendingFunctionCall {
  readonly callId: ToolCallId
  readonly toolId: FeedbackToolId
  readonly providerCallId?: string
}

export interface ContinuationPayload {
  readonly modelId: AdapterModelId
  readonly contents: ReadonlyArray<Content>
  readonly config: GenerateContentConfig
  readonly modelContent: Content
  readonly calls: ToolCalls
  readonly providerCalls: ReadonlyArray<PendingFunctionCall>
}

type ContinuationState = Data.TaggedEnum<{
  readonly Pending: {
    readonly payload: ContinuationPayload
    readonly owningScope: Scope.Scope
  }
  readonly Claimed: {
    readonly payload: ContinuationPayload
    readonly owningScope: Scope.Scope
  }
}>

const ContinuationState = Data.taggedEnum<ContinuationState>()

export interface ClaimedContinuation extends ContinuationPayload {
  readonly adapterId: AdapterId
  readonly key: string
  readonly owningScope: Scope.Scope
}

export interface Interface {
  readonly create: (
    payload: ContinuationPayload,
  ) => Effect.Effect<AdapterContinuation, AdapterInvocationError, Scope.Scope>
  readonly claim: (
    continuation: AdapterContinuation,
  ) => Effect.Effect<ClaimedContinuation, ReturnType<typeof makeAdapterContinuationError>>
  readonly remove: (key: string) => Effect.Effect<void>
  readonly size: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/koishi-plugin-yokai-adapter-gemini/ContinuationStore',
) {}

const makeInternalError = (
  adapterId: GeminiConnection.Interface['adapterId'],
  modelId: AdapterModelId,
) =>
  new AdapterInternalError({
    adapterId,
    modelId,
    operation: 'generate',
    message: 'Unable to create a Gemini continuation',
  })

const make = Effect.fn('GeminiContinuationStore.make')(function* () {
  const connection = yield* GeminiConnection.Service
  const tokenGenerator = yield* GeminiContinuationTokenGenerator.Service
  const states = yield* Ref.make(HashMap.empty<string, ContinuationState>())
  const nextSequence = yield* Ref.make(1)

  const remove = Effect.fn('GeminiContinuationStore.remove')(function* (key: string) {
    yield* Ref.update(states, (current) => HashMap.remove(current, key))
  })

  const create = Effect.fn('GeminiContinuationStore.create')(function* (
    payload: ContinuationPayload,
  ) {
    const owningScope = yield* Effect.scope
    const resource = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const random = yield* tokenGenerator
          .next()
          .pipe(Effect.mapError(() => makeInternalError(connection.adapterId, payload.modelId)))
        const sequence = yield* Ref.getAndUpdate(nextSequence, (current) => current + 1)
        const continuation = yield* makeAdapterContinuation(`gemini:${random}:${sequence}`).pipe(
          Effect.mapError(() => makeInternalError(connection.adapterId, payload.modelId)),
        )
        const key = Redacted.value(continuation)
        yield* Ref.update(states, (current) =>
          HashMap.set(current, key, ContinuationState.Pending({ payload, owningScope })),
        )
        return { continuation, key }
      }),
      (entry) => remove(entry.key),
    )
    return resource.continuation
  })

  const continuationKey = Effect.fn('GeminiContinuationStore.key')(
    (continuation: AdapterContinuation) =>
      Effect.try({
        try: () => Redacted.value(continuation),
        catch: () => makeAdapterContinuationError(connection.adapterId),
      }),
  )

  const claim = Effect.fn('GeminiContinuationStore.claim')(function* (
    continuation: AdapterContinuation,
  ) {
    const key = yield* continuationKey(continuation)
    const pending = yield* Ref.modify(states, (current) => {
      const candidate = HashMap.get(current, key)
      if (Option.isNone(candidate) || candidate.value._tag === 'Claimed') {
        return [Option.none<ContinuationState>(), current]
      }
      const value = candidate.value
      return [
        Option.some(value),
        HashMap.set(
          current,
          key,
          ContinuationState.Claimed({
            payload: value.payload,
            owningScope: value.owningScope,
          }),
        ),
      ]
    })

    if (Option.isNone(pending)) {
      return yield* Effect.fail(makeAdapterContinuationError(connection.adapterId))
    }

    return {
      adapterId: connection.adapterId,
      key,
      owningScope: pending.value.owningScope,
      ...pending.value.payload,
    }
  })

  yield* Effect.addFinalizer(() => Ref.set(states, HashMap.empty()))

  return Service.of({
    create,
    claim,
    remove,
    size: Effect.fn('GeminiContinuationStore.size')(function* () {
      return HashMap.size(yield* Ref.get(states))
    }),
  })
})

export const layer = Layer.effect(Service, make())

export * as GeminiContinuationStore from './store'
