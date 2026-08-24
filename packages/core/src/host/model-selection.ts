import {
  CapabilityRegistry,
  ModelSelectionUnavailableError,
  type ResolvedModel,
} from '../capability-registry/index'
import { Effect, Option } from 'effect'

import { HostConfiguration } from './configuration'

export const resolve = Effect.fn('HostModelSelection.resolve')(function* () {
  const configuration = yield* HostConfiguration.Service
  const registry = yield* CapabilityRegistry.Service
  if (Option.isNone(configuration.model)) {
    return yield* Effect.fail(new ModelSelectionUnavailableError({}))
  }
  return yield* registry.resolveModel(configuration.model.value)
})

export type Resolution = ResolvedModel

export * as HostModelSelection from './model-selection'
