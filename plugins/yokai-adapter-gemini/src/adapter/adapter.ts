import {
  AdapterDescriptor,
  CURRENT_ADAPTER_PROTOCOL_VERSION,
  makeAdapterContinuationError,
  type ContinueRequest,
  type YokaiAdapter,
} from '@yokai/protocol'
import { Context, Effect, Layer } from 'effect'

import { GeminiModelDiscovery } from '../discovery/discovery'
import { GeminiTextGeneration } from '../generation/generation'

export interface Interface extends YokaiAdapter {}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/koishi-plugin-yokai-adapter-gemini/Adapter',
) {}

const make = Effect.fn('GeminiAdapter.make')(function* () {
  const discovery = yield* GeminiModelDiscovery.Service
  const generation = yield* GeminiTextGeneration.Service
  const descriptor = AdapterDescriptor.make({
    id: generation.adapterId,
    protocolVersion: CURRENT_ADAPTER_PROTOCOL_VERSION,
    capabilities: { feedbackTools: false },
  })

  return Service.of({
    descriptor,
    discoverModels: discovery.discoverModels,
    generate: generation.generate,
    continue: Effect.fn('GeminiAdapter.continue')(function* (_request: ContinueRequest) {
      return yield* Effect.fail(makeAdapterContinuationError(generation.adapterId))
    }),
  })
})

export const layer = Layer.effect(Service, make())

export * as GeminiAdapter from './adapter'
