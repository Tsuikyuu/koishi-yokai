import { CapabilityRegistry, WakeProposal } from '@yokai-internal/core'
import { CapabilityProtocolVersion, ResponseMechanism } from 'yokai-protocol'
import { Effect, Layer } from 'effect'

const VERSION = CapabilityProtocolVersion.make({ major: 0, minor: 1 })

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* CapabilityRegistry.Service
    const direct = yield* registry.registerResponseMechanism(
      ResponseMechanism.make({
        id: WakeProposal.DIRECT_MECHANISM_ID,
        protocolVersion: VERSION,
      }),
    )
    const activity = yield* registry.registerResponseMechanism(
      ResponseMechanism.make({
        id: WakeProposal.ACTIVITY_MECHANISM_ID,
        protocolVersion: VERSION,
      }),
    )
    const engagement = yield* registry.registerResponseMechanism(
      ResponseMechanism.make({
        id: WakeProposal.ENGAGEMENT_MECHANISM_ID,
        protocolVersion: VERSION,
      }),
    )
    const actionCompletion = yield* registry.registerResponseMechanism(
      ResponseMechanism.make({
        id: WakeProposal.ACTION_COMPLETION_MECHANISM_ID,
        protocolVersion: VERSION,
      }),
    )

    yield* Effect.addFinalizer(() =>
      Effect.all(
        [
          direct.unregister(),
          activity.unregister(),
          engagement.unregister(),
          actionCompletion.unregister(),
        ],
        { discard: true },
      ),
    )
  }),
)

export * as BuiltinResponseCapabilities from './capabilities'
