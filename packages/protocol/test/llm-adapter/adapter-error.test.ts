import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'

import {
  AdapterError,
  AdapterInvocationError,
  makeAdapterContinuationError,
} from '../../src/llm-adapter/adapter-error'
import { AdapterId } from '../../src/llm-adapter/identity'

it.effect('round-trips a typed adapter error without retaining provider internals', () =>
  Effect.gen(function* () {
    const encoded = {
      _tag: 'AdapterRateLimitError',
      adapterId: 'gemini',
      modelId: 'connection-a/models/flash',
      operation: 'generate',
      message: 'Provider rate limit reached',
      retryAfterMs: 1_000,
      rawBody: 'secret provider response',
      headers: { authorization: 'secret' },
    }

    const error = yield* Schema.decodeUnknownEffect(AdapterError)(encoded)
    expect(yield* Schema.encodeEffect(AdapterError)(error)).toEqual({
      _tag: 'AdapterRateLimitError',
      adapterId: 'gemini',
      modelId: 'connection-a/models/flash',
      operation: 'generate',
      message: 'Provider rate limit reached',
      retryAfterMs: 1_000,
    })
  }),
)

it.effect('keeps invalid continuation diagnostics uniform and scoped to continue', () =>
  Effect.gen(function* () {
    const adapterId = yield* Schema.decodeUnknownEffect(AdapterId)('gemini')
    const error = makeAdapterContinuationError(adapterId)

    expect(yield* Schema.encodeEffect(AdapterInvocationError)(error)).toEqual({
      _tag: 'AdapterContinuationError',
      adapterId: 'gemini',
      operation: 'continue',
      message: 'Invalid adapter continuation',
      reason: 'invalid',
    })
  }),
)

it.effect('rejects unknown errors and invalid safe metadata', () =>
  Effect.gen(function* () {
    const errors = yield* Effect.all(
      [
        {
          _tag: 'VendorSpecificError',
          adapterId: 'gemini',
          operation: 'generate',
          message: 'failure',
        },
        {
          _tag: 'AdapterProviderResponseError',
          adapterId: 'gemini',
          operation: 'generate',
          message: 'failure',
          statusCode: 999,
        },
      ].map((input) => Schema.decodeUnknownEffect(AdapterError)(input).pipe(Effect.flip)),
    )
    const registrationOperationError = yield* Schema.decodeUnknownEffect(AdapterInvocationError)({
      _tag: 'AdapterRateLimitError',
      adapterId: 'gemini',
      operation: 'register',
      message: 'Invalid invocation operation',
    }).pipe(Effect.flip)

    expect(errors.every(Schema.isSchemaError)).toBe(true)
    expect(Schema.isSchemaError(registrationOperationError)).toBe(true)
  }),
)
