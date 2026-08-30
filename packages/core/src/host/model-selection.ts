import {
  CapabilityRegistry,
  ModelSelectionUnavailableError,
  type ResolvedModel,
  type TurnCapabilitySnapshot,
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

const sameReference = (
  left: TurnCapabilitySnapshot['modelCatalog']['models'][number]['reference'],
  right: TurnCapabilitySnapshot['modelCatalog']['models'][number]['reference'],
): boolean => left.adapterId === right.adapterId && left.modelId === right.modelId

/** Resolve the configured model from the same immutable capability snapshot as the turn. */
export const resolveSnapshot = Effect.fn('HostModelSelection.resolveSnapshot')(function* (
  snapshot: TurnCapabilitySnapshot,
) {
  const configuration = yield* HostConfiguration.Service
  if (Option.isNone(configuration.model)) {
    return yield* Effect.fail(new ModelSelectionUnavailableError({}))
  }

  const reference = configuration.model.value
  const adapter = snapshot.adapters.find(
    (candidate) => candidate.descriptor.id === reference.adapterId,
  )
  const adapterCatalog = snapshot.modelCatalog.adapters.find(
    (candidate) => candidate.id === reference.adapterId,
  )
  const model = snapshot.modelCatalog.models.find((candidate) =>
    sameReference(candidate.reference, reference),
  )
  const statusAllowsUse =
    adapterCatalog !== undefined &&
    adapterCatalog.status !== 'failed' &&
    adapterCatalog.status !== 'offline'

  return adapter !== undefined &&
    model !== undefined &&
    model.availability === 'available' &&
    statusAllowsUse
    ? { adapter, reference, model }
    : yield* Effect.fail(new ModelSelectionUnavailableError({ reference }))
})

export type Resolution = ResolvedModel

export * as HostModelSelection from './model-selection'
