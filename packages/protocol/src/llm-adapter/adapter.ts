import type { Scope } from 'effect'
import { Effect, Schema } from 'effect'

import {
  type AdapterInvocationError,
  AdapterProtocolVersionMismatchError,
} from './adapter-error.js'
import type { AdapterModelSnapshot } from './model.js'
import type {
  ContinueRequest,
  FinalTextResult,
  GenerateRequest,
  InitialGenerationResult,
} from './generation.js'
import { AdapterId } from './identity.js'
import {
  AdapterProtocolVersion,
  CURRENT_ADAPTER_PROTOCOL_VERSION,
  isAdapterProtocolVersionCompatible,
} from './protocol-version.js'

export const AdapterCapabilities = Schema.Struct({
  /** Transport support only; it is not a per-model capability claim. */
  feedbackTools: Schema.Boolean,
})

export interface AdapterCapabilities extends Schema.Schema.Type<typeof AdapterCapabilities> {}

export const AdapterDescriptor = Schema.Struct({
  id: AdapterId,
  protocolVersion: AdapterProtocolVersion,
  capabilities: AdapterCapabilities,
})

export interface AdapterDescriptor extends Schema.Schema.Type<typeof AdapterDescriptor> {}

/**
 * A dynamically registered, provider-neutral adapter value. Implementations
 * capture their provider services when built; method effects expose no provider
 * requirements. `generate` requires the owning turn Scope so a handle can be
 * invalidated when that turn ends; `continue` recovers that lifetime by handle.
 */
export interface YokaiAdapter {
  readonly descriptor: AdapterDescriptor
  readonly discoverModels: () => Effect.Effect<AdapterModelSnapshot, AdapterInvocationError>
  readonly generate: (
    request: GenerateRequest,
  ) => Effect.Effect<InitialGenerationResult, AdapterInvocationError, Scope.Scope>
  readonly continue: (
    request: ContinueRequest,
  ) => Effect.Effect<FinalTextResult, AdapterInvocationError>
}

/**
 * Registration-time handshake. Hosts must negotiate before storing or invoking
 * an adapter so incompatible implementations cannot reach provider methods.
 */
export const negotiateAdapterProtocol = (
  adapter: YokaiAdapter,
  supportedVersion: AdapterProtocolVersion = CURRENT_ADAPTER_PROTOCOL_VERSION,
): Effect.Effect<YokaiAdapter, AdapterProtocolVersionMismatchError> =>
  isAdapterProtocolVersionCompatible(supportedVersion, adapter.descriptor.protocolVersion)
    ? Effect.succeed(adapter)
    : Effect.fail(
        new AdapterProtocolVersionMismatchError({
          adapterId: adapter.descriptor.id,
          operation: 'register',
          supportedVersion,
          candidateVersion: adapter.descriptor.protocolVersion,
        }),
      )
