import {
  AdapterProtocolDecodeError,
  AdapterUnsupportedError,
  GenerateRequest,
  type AdapterId,
  type AdapterInvocationError,
  type FinalTextResult,
  type GenerateRequest as GenerateRequestType,
} from '@yokai/protocol'
import { Context, Effect, Layer, Schema } from 'effect'

import { GeminiConnection } from '../connection/connection'
import { encodeRequest } from './request'
import { decodeResponse } from './response'

export interface Interface {
  readonly adapterId: AdapterId
  readonly generate: (
    request: GenerateRequestType,
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

const unsupportedToolsError = (adapterId: AdapterId, request: GenerateRequestType) =>
  new AdapterUnsupportedError({
    adapterId,
    modelId: request.modelId,
    operation: 'generate',
    message: 'Gemini feedback tools are not enabled',
    feature: 'feedback-tools',
  })

const make = Effect.fn('GeminiTextGeneration.make')(function* () {
  const connection = yield* GeminiConnection.Service

  const generate = Effect.fn('GeminiTextGeneration.generate')(function* (
    input: GenerateRequestType,
  ) {
    const request = yield* Schema.decodeUnknownEffect(GenerateRequest)(input).pipe(
      Effect.mapError(() => invalidRequestError(connection.adapterId)),
    )
    if (request.feedbackTools.length > 0) {
      return yield* Effect.fail(unsupportedToolsError(connection.adapterId, request))
    }

    return yield* connection.generateContent(request.modelId, encodeRequest(request), (response) =>
      decodeResponse(connection.adapterId, request.modelId, response),
    )
  })

  return Service.of({
    adapterId: connection.adapterId,
    generate,
  })
})

export const layer = Layer.effect(Service, make())

export * as GeminiTextGeneration from './generation'
