import { Effect, Redacted, Schema } from 'effect'

export const MAX_ADAPTER_CONTINUATION_TOKEN_LENGTH = 256

const CONTINUATION_LABEL = 'AdapterContinuation'

const AdapterContinuationToken = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_ADAPTER_CONTINUATION_TOKEN_LENGTH),
).pipe(Schema.brand('@yokai/protocol/AdapterContinuationToken'))

/**
 * A short-lived lookup handle. It must contain no provider history and cannot
 * be encoded through Effect's canonical JSON codec.
 */
export const AdapterContinuation = Schema.Redacted(AdapterContinuationToken, {
  label: CONTINUATION_LABEL,
  disallowJsonEncode: true,
})

export type AdapterContinuation = typeof AdapterContinuation.Type

/** Validate and redact an adapter-owned, random in-memory lookup key. */
export const makeAdapterContinuation = (
  token: string,
): Effect.Effect<AdapterContinuation, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(AdapterContinuationToken)(token).pipe(
    Effect.map((validated) =>
      AdapterContinuation.make(
        Redacted.make(validated, {
          label: CONTINUATION_LABEL,
        }),
      ),
    ),
  )
