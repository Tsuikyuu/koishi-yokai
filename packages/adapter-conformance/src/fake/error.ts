import { Option } from 'effect'

import {
  AdapterAuthenticationError,
  AdapterCancelledError,
  AdapterConfigurationError,
  AdapterInternalError,
  AdapterProtocolDecodeError,
  AdapterProviderResponseError,
  AdapterRateLimitError,
  AdapterTimeoutError,
  AdapterTransportError,
  AdapterUnsupportedError,
  type AdapterId,
  type AdapterInvocationError,
  type AdapterInvocationOperation,
  type AdapterModelId,
} from '@yokai/protocol'

import type { AdapterConformanceFailure } from '../index.js'

const errorFields = (
  adapterId: AdapterId,
  operation: AdapterInvocationOperation,
  modelId: Option.Option<AdapterModelId>,
  message: string,
) =>
  Option.match(modelId, {
    onNone: () => ({ adapterId, operation, message }),
    onSome: (value) => ({ adapterId, operation, modelId: value, message }),
  })

export const makeFakeInvocationError = (
  failure: AdapterConformanceFailure,
  adapterId: AdapterId,
  operation: AdapterInvocationOperation,
  modelId: Option.Option<AdapterModelId>,
): AdapterInvocationError => {
  switch (failure.category) {
    case 'configuration':
      return new AdapterConfigurationError(
        errorFields(adapterId, operation, modelId, 'Fake adapter configuration failure'),
      )
    case 'authentication':
      return new AdapterAuthenticationError(
        errorFields(adapterId, operation, modelId, 'Fake adapter authentication failure'),
      )
    case 'rate-limit': {
      const fields = errorFields(adapterId, operation, modelId, 'Fake adapter rate limit')
      return failure.retryAfterMs === undefined
        ? new AdapterRateLimitError(fields)
        : new AdapterRateLimitError({ ...fields, retryAfterMs: failure.retryAfterMs })
    }
    case 'timeout':
      return new AdapterTimeoutError(
        errorFields(adapterId, operation, modelId, 'Fake adapter timeout'),
      )
    case 'provider-cancelled':
      return new AdapterCancelledError(
        errorFields(adapterId, operation, modelId, 'Fake provider cancelled request'),
      )
    case 'transport':
      return new AdapterTransportError(
        errorFields(adapterId, operation, modelId, 'Fake adapter transport failure'),
      )
    case 'provider-response': {
      const fields = errorFields(adapterId, operation, modelId, 'Fake provider response failure')
      return failure.statusCode === undefined
        ? new AdapterProviderResponseError(fields)
        : new AdapterProviderResponseError({ ...fields, statusCode: failure.statusCode })
    }
    case 'protocol-decode':
      return new AdapterProtocolDecodeError(
        errorFields(adapterId, operation, modelId, 'Fake provider response was invalid'),
      )
    case 'internal':
      return new AdapterInternalError(
        errorFields(adapterId, operation, modelId, 'Fake adapter internal failure'),
      )
    case 'unsupported':
      return new AdapterUnsupportedError({
        ...errorFields(
          adapterId,
          operation,
          modelId,
          'Fake adapter does not support feedback tools',
        ),
        feature: 'feedback-tools',
      })
  }
}
