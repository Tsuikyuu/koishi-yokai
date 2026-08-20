import { Effect, Schema, type Scope } from 'effect'

import {
  AdapterInvocationOperation,
  AdapterModelId,
  ToolCallId,
  type YokaiAdapter,
} from '@yokai/protocol'

import type { AdapterConformanceSetup } from './setup.js'

export const AdapterTestProviderRequestKind = Schema.Literals([
  'model-list',
  'generation',
  'capability-probe',
])

export type AdapterTestProviderRequestKind = typeof AdapterTestProviderRequestKind.Type

const AdapterTestRequestId = Schema.Int.check(Schema.isGreaterThan(0))

export const AdapterTestEvent = Schema.TaggedUnion({
  RequestStarted: {
    requestId: AdapterTestRequestId,
    kind: AdapterTestProviderRequestKind,
    operation: AdapterInvocationOperation,
    modelId: Schema.optionalKey(AdapterModelId),
    resultCallIds: Schema.Array(ToolCallId),
  },
  RequestSucceeded: {
    requestId: AdapterTestRequestId,
  },
  RequestFailed: {
    requestId: AdapterTestRequestId,
  },
  RequestCancelled: {
    requestId: AdapterTestRequestId,
  },
})

export type AdapterTestEvent = typeof AdapterTestEvent.Type

/** Deterministic observation and release surface implemented by adapter test harnesses. */
export interface AdapterConformanceControl {
  readonly takeEvent: () => Effect.Effect<AdapterTestEvent>
  readonly events: () => Effect.Effect<ReadonlyArray<AdapterTestEvent>>
  readonly release: (requestId: number) => Effect.Effect<boolean>
  readonly activeRequests: () => Effect.Effect<number>
}

export interface AdapterConformanceSubject {
  readonly adapter: YokaiAdapter
  readonly control: AdapterConformanceControl
}

/**
 * Adapter-specific tests translate the provider-neutral script into their own
 * SDK or HTTP stub behavior and expose only the common subject surface.
 */
export interface AdapterConformanceFactory {
  readonly make: (
    setup: AdapterConformanceSetup,
  ) => Effect.Effect<AdapterConformanceSubject, never, Scope.Scope>
}
