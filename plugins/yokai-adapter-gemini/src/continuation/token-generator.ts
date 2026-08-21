import { Context, Effect, Layer, Schema } from 'effect'
import { randomUUID } from 'node:crypto'

export class TokenGenerationError extends Schema.TaggedError<TokenGenerationError>(
  '@yokai/koishi-plugin-yokai-adapter-gemini/ContinuationTokenGenerationError',
)('GeminiContinuationTokenGenerationError', {
  message: Schema.Literal('Unable to generate a Gemini continuation token'),
}) {}

export interface Interface {
  readonly next: () => Effect.Effect<string, TokenGenerationError>
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/koishi-plugin-yokai-adapter-gemini/ContinuationTokenGenerator',
) {}

const next = Effect.fn('GeminiContinuationTokenGenerator.next')(() =>
  Effect.try({
    try: randomUUID,
    catch: () =>
      new TokenGenerationError({
        message: 'Unable to generate a Gemini continuation token',
      }),
  }),
)

export const layer = Layer.succeed(Service, Service.of({ next }))

export * as GeminiContinuationTokenGenerator from './token-generator'
