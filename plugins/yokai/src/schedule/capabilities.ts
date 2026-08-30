import {
  CapabilityRegistry,
  ScheduledTask,
  ScheduledTaskCapabilities,
  WakeProposal,
} from '@yokai-internal/core'
import { CapabilityProtocolVersion, ResponseMechanism } from 'yokai-protocol'
import { Effect, Layer } from 'effect'

const VERSION = CapabilityProtocolVersion.make({ major: 0, minor: 1 })

const registerScoped = <A extends { readonly unregister: () => Effect.Effect<boolean> }, E, R>(
  registration: Effect.Effect<A, E, R>,
) =>
  Effect.acquireRelease(registration, (registered) => registered.unregister().pipe(Effect.asVoid))

export const layer = (options: ScheduledTaskCapabilities.Options) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* CapabilityRegistry.Service
      const scheduledTask = yield* ScheduledTask.Service
      yield* registerScoped(
        registry.registerContextProvider(
          ScheduledTaskCapabilities.makeContextProvider(scheduledTask, options),
        ),
      )
      yield* registerScoped(
        registry.registerFeedbackTool(
          ScheduledTaskCapabilities.makeFeedbackTool(scheduledTask, options),
        ),
      )
      yield* Effect.forEach(
        ScheduledTaskCapabilities.makeActionTools(scheduledTask, options),
        (action) => registerScoped(registry.registerActionTool(action)),
        { discard: true },
      )
      yield* registerScoped(
        registry.registerResponseMechanism(
          ResponseMechanism.make({
            id: WakeProposal.SCHEDULE_MECHANISM_ID,
            protocolVersion: VERSION,
          }),
        ),
      )
    }),
  )

export * as ScheduleCapabilityRegistration from './capabilities'
