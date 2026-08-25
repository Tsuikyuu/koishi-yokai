import { CapabilityRegistry } from '@yokai-internal/core'
import { HistoryCapabilities, MessageHistory } from '@yokai-internal/memory'
import { Effect, Layer } from 'effect'

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* CapabilityRegistry.Service
    const history = yield* MessageHistory.Service
    const contextRegistration = yield* registry.registerContextProvider(
      HistoryCapabilities.makeContextProvider(history),
    )
    const feedbackRegistration = yield* registry.registerFeedbackTool(
      HistoryCapabilities.makeFeedbackTool(history),
    )

    yield* Effect.addFinalizer(() =>
      Effect.all([contextRegistration.unregister(), feedbackRegistration.unregister()], {
        discard: true,
      }),
    )
  }),
)

export * as HistoryCapabilityRegistration from './capabilities'
