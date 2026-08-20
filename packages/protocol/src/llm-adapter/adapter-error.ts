import { Schema } from 'effect'

import { AdapterId, AdapterModelId } from './identity'
import { AdapterProtocolVersion } from './protocol-version'

export const MAX_SAFE_ADAPTER_ERROR_MESSAGE_LENGTH = 1024

export const AdapterOperation = Schema.Literals([
  'register',
  'discoverModels',
  'generate',
  'continue',
])

export type AdapterOperation = typeof AdapterOperation.Type

export const AdapterInvocationOperation = Schema.Literals([
  'discoverModels',
  'generate',
  'continue',
])

export type AdapterInvocationOperation = typeof AdapterInvocationOperation.Type

const SafeErrorMessage = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_SAFE_ADAPTER_ERROR_MESSAGE_LENGTH),
)

const AdapterErrorFields = {
  adapterId: AdapterId,
  modelId: Schema.optionalKey(AdapterModelId),
  operation: AdapterInvocationOperation,
  message: SafeErrorMessage,
}

export class AdapterProtocolVersionMismatchError extends Schema.TaggedError<AdapterProtocolVersionMismatchError>(
  '@yokai/protocol/AdapterProtocolVersionMismatchError',
)('AdapterProtocolVersionMismatchError', {
  adapterId: AdapterId,
  operation: Schema.Literal('register'),
  supportedVersion: AdapterProtocolVersion,
  candidateVersion: AdapterProtocolVersion,
}) {}

export class AdapterConfigurationError extends Schema.TaggedError<AdapterConfigurationError>(
  '@yokai/protocol/AdapterConfigurationError',
)('AdapterConfigurationError', AdapterErrorFields) {}

export class AdapterAuthenticationError extends Schema.TaggedError<AdapterAuthenticationError>(
  '@yokai/protocol/AdapterAuthenticationError',
)('AdapterAuthenticationError', AdapterErrorFields) {}

export class AdapterRateLimitError extends Schema.TaggedError<AdapterRateLimitError>(
  '@yokai/protocol/AdapterRateLimitError',
)('AdapterRateLimitError', {
  ...AdapterErrorFields,
  retryAfterMs: Schema.optionalKey(Schema.Natural),
}) {}

export class AdapterTimeoutError extends Schema.TaggedError<AdapterTimeoutError>(
  '@yokai/protocol/AdapterTimeoutError',
)('AdapterTimeoutError', AdapterErrorFields) {}

/** Caller interruption must remain interruption; this represents provider-reported cancellation. */
export class AdapterCancelledError extends Schema.TaggedError<AdapterCancelledError>(
  '@yokai/protocol/AdapterCancelledError',
)('AdapterCancelledError', AdapterErrorFields) {}

export class AdapterTransportError extends Schema.TaggedError<AdapterTransportError>(
  '@yokai/protocol/AdapterTransportError',
)('AdapterTransportError', AdapterErrorFields) {}

export class AdapterProviderResponseError extends Schema.TaggedError<AdapterProviderResponseError>(
  '@yokai/protocol/AdapterProviderResponseError',
)('AdapterProviderResponseError', {
  ...AdapterErrorFields,
  statusCode: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  ),
}) {}

export class AdapterProtocolDecodeError extends Schema.TaggedError<AdapterProtocolDecodeError>(
  '@yokai/protocol/AdapterProtocolDecodeError',
)('AdapterProtocolDecodeError', AdapterErrorFields) {}

/** Unknown SDK rejections map here; violated code invariants remain Effect defects. */
export class AdapterInternalError extends Schema.TaggedError<AdapterInternalError>(
  '@yokai/protocol/AdapterInternalError',
)('AdapterInternalError', AdapterErrorFields) {}

export const UnsupportedAdapterFeature = Schema.Literals(['feedback-tools'])

export type UnsupportedAdapterFeature = typeof UnsupportedAdapterFeature.Type

export class AdapterUnsupportedError extends Schema.TaggedError<AdapterUnsupportedError>(
  '@yokai/protocol/AdapterUnsupportedError',
)('AdapterUnsupportedError', {
  ...AdapterErrorFields,
  feature: UnsupportedAdapterFeature,
}) {}

export const INVALID_ADAPTER_CONTINUATION_MESSAGE = 'Invalid adapter continuation'

/** Deliberately hides whether a handle is unknown, expired, consumed, or foreign. */
export const ContinuationFailureReason = Schema.Literal('invalid')

export type ContinuationFailureReason = typeof ContinuationFailureReason.Type

export class AdapterContinuationError extends Schema.TaggedError<AdapterContinuationError>(
  '@yokai/protocol/AdapterContinuationError',
)('AdapterContinuationError', {
  adapterId: AdapterId,
  operation: Schema.Literal('continue'),
  message: Schema.Literal(INVALID_ADAPTER_CONTINUATION_MESSAGE),
  reason: ContinuationFailureReason,
}) {}

export const makeAdapterContinuationError = (adapterId: AdapterId): AdapterContinuationError =>
  new AdapterContinuationError({
    adapterId,
    operation: 'continue',
    message: INVALID_ADAPTER_CONTINUATION_MESSAGE,
    reason: 'invalid',
  })

export const ProtocolViolationReason = Schema.Literals([
  'undeclared-tool-call',
  'duplicate-call-id',
  'result-set-mismatch',
  'unexpected-tool-call',
])

export type ProtocolViolationReason = typeof ProtocolViolationReason.Type

export class AdapterProtocolViolationError extends Schema.TaggedError<AdapterProtocolViolationError>(
  '@yokai/protocol/AdapterProtocolViolationError',
)('AdapterProtocolViolationError', {
  ...AdapterErrorFields,
  reason: ProtocolViolationReason,
}) {}

const AdapterInvocationErrorMembers = [
  AdapterConfigurationError,
  AdapterAuthenticationError,
  AdapterRateLimitError,
  AdapterTimeoutError,
  AdapterCancelledError,
  AdapterTransportError,
  AdapterProviderResponseError,
  AdapterProtocolDecodeError,
  AdapterInternalError,
  AdapterUnsupportedError,
  AdapterContinuationError,
  AdapterProtocolViolationError,
] as const

export const AdapterInvocationError = Schema.Union(AdapterInvocationErrorMembers).pipe(
  Schema.toTaggedUnion('_tag'),
)

export type AdapterInvocationError = typeof AdapterInvocationError.Type

/** All errors crossing registration or invocation boundaries. */
export const AdapterError = Schema.Union([
  AdapterProtocolVersionMismatchError,
  ...AdapterInvocationErrorMembers,
]).pipe(Schema.toTaggedUnion('_tag'))

export type AdapterError = typeof AdapterError.Type
