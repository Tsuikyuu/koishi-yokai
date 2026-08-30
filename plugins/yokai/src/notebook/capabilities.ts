import { CapabilityRegistry } from '@yokai-internal/core'
import { Notebook, NotebookCapabilities } from '@yokai-internal/memory'
import { Effect, Layer } from 'effect'

export const layer = (options: NotebookCapabilities.Options) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* CapabilityRegistry.Service
      const notebook = yield* Notebook.Service
      const contextRegistration = yield* registry.registerContextProvider(
        NotebookCapabilities.makeContextProvider(notebook, options),
      )
      const actionRegistration = yield* registry.registerActionTool(
        NotebookCapabilities.makeActionTool(notebook, options),
      )

      yield* Effect.addFinalizer(() =>
        Effect.all([contextRegistration.unregister(), actionRegistration.unregister()], {
          discard: true,
        }),
      )
    }),
  )

export * as NotebookCapabilityRegistration from './capabilities'
