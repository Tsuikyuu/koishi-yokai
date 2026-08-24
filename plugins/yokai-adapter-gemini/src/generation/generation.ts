import {
  AdapterProtocolDecodeError,
  ContinueRequest,
  GenerateRequest,
  ToolCallBatch,
  type AdapterId,
  type AdapterInvocationError,
  type ContinueRequest as ContinueRequestType,
  type FinalTextResult,
  type GenerateRequest as GenerateRequestType,
  type InitialGenerationResult,
  makeAdapterContinuationError,
} from 'yokai-protocol'
import { Context, Effect, Fiber, Layer, Option, Schema, Scope } from 'effect'

import { GeminiConnection } from '../connection/connection'
import { GeminiContinuationStore } from '../continuation/store'
import { recordGenerationUsage } from '../observability/observability'
import { encodeContinuationRequest, encodeRequest } from './request'
import { decodeFinalResponse, decodeInitialResponse } from './response'

export interface Interface {
  readonly adapterId: AdapterId
  readonly generate: (
    request: GenerateRequestType,
  ) => Effect.Effect<InitialGenerationResult, AdapterInvocationError, Scope.Scope>
  readonly continue: (
    request: ContinueRequestType,
  ) => Effect.Effect<FinalTextResult, AdapterInvocationError>
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/koishi-plugin-yokai-adapter-gemini/TextGeneration',
) {}

const invalidRequestError = (adapterId: AdapterId) =>
  new AdapterProtocolDecodeError({
    adapterId,
    operation: 'generate',
    message: 'Invalid Gemini generation request',
  })

const responseDecodeError = (adapterId: AdapterId, modelId: GenerateRequestType['modelId']) =>
  new AdapterProtocolDecodeError({
    adapterId,
    modelId,
    operation: 'generate',
    message: 'Gemini returned an invalid generation response',
  })

const make = Effect.fn('GeminiTextGeneration.make')(function* () {
  const connection = yield* GeminiConnection.Service
  const continuations = yield* GeminiContinuationStore.Service

  const generate = Effect.fn('GeminiTextGeneration.generate')(function* (
    input: GenerateRequestType,
  ) {
    const request = yield* Schema.decodeUnknownEffect(GenerateRequest)(input).pipe(
      Effect.mapError(() => invalidRequestError(connection.adapterId)),
    )
    const encoded = encodeRequest(request)

    const result = yield* connection.generateContent(
      'generate',
      request.modelId,
      encoded,
      (response) =>
        Effect.gen(function* () {
          const decoded = yield* decodeInitialResponse(
            connection.adapterId,
            request.modelId,
            request.feedbackTools,
            response,
          )
          if (decoded._tag === 'Text') return decoded.result

          const continuation = yield* continuations.create({
            modelId: request.modelId,
            contents: encoded.contents,
            config: encoded.config,
            modelContent: decoded.modelContent,
            calls: decoded.calls,
            providerCalls: decoded.providerCalls,
          })
          return yield* ToolCallBatch.makeEffect({
            _tag: 'ToolCallBatch',
            calls: decoded.calls,
            continuation,
            usage: decoded.usage,
          }).pipe(Effect.mapError(() => responseDecodeError(connection.adapterId, request.modelId)))
        }),
    )
    yield* recordGenerationUsage(
      {
        adapterId: connection.adapterId,
        operation: 'generate',
        modelId: Option.some(request.modelId),
      },
      result.usage,
    )
    return result
  })

  const continueGeneration = Effect.fn('GeminiTextGeneration.continue')(function* (
    input: ContinueRequestType,
  ) {
    const request = yield* Schema.decodeUnknownEffect(ContinueRequest)(input).pipe(
      Effect.mapError(() => makeAdapterContinuationError(connection.adapterId)),
    )

    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const claimed = yield* continuations.claim(request.continuation)
        const work = Effect.gen(function* () {
          const encoded = yield* encodeContinuationRequest(claimed, request.results)
          const result = yield* connection.generateContent(
            'continue',
            claimed.modelId,
            encoded,
            (response) =>
              decodeFinalResponse(connection.adapterId, claimed.modelId, 'continue', response),
          )
          yield* recordGenerationUsage(
            {
              adapterId: connection.adapterId,
              operation: 'continue',
              modelId: Option.some(claimed.modelId),
            },
            result.usage,
          )
          return result
        })
        const fiber = yield* Effect.forkIn(restore(work), claimed.owningScope, {
          uninterruptible: false,
        })
        const exit = yield* restore(Fiber.await(fiber)).pipe(
          Effect.ensuring(Fiber.interrupt(fiber)),
          Effect.ensuring(continuations.remove(claimed.key)),
        )
        return yield* exit
      }),
    )
  })

  return Service.of({
    adapterId: connection.adapterId,
    generate,
    continue: continueGeneration,
  })
})

export const layer = Layer.effect(Service, make())

export * as GeminiTextGeneration from './generation'
