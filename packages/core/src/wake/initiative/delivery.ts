import { Context, Effect, Schema } from 'effect'

import type { WakeArbiter } from '../arbiter'
import { ScopeId, type Proposal } from '../proposal'
import type { Target } from './model'

export class DispatchError extends Schema.TaggedError<DispatchError>(
  '@yokai/core/InitiativeDelivery.DispatchError',
)('InitiativeDeliveryDispatchError', {
  scopeId: ScopeId,
  cause: Schema.Defect(),
}) {}

export interface Request {
  readonly target: Target
  readonly proposal: Proposal
  readonly admission: WakeArbiter.Admission
}

export interface Interface {
  readonly isAvailable: (target: Target) => Effect.Effect<boolean>
  readonly dispatch: (request: Request) => Effect.Effect<WakeArbiter.Outcome, DispatchError>
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/core/InitiativeDelivery',
) {}

export * as InitiativeDelivery from './delivery'
