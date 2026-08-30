import { Context, Effect, Schema } from 'effect'

import type { WakeProposal } from '../wake/proposal'
import { ScheduledTaskModel } from './model'

export class DispatchError extends Schema.TaggedError<DispatchError>(
  '@yokai/core/ScheduledDelivery.DispatchError',
)('ScheduledDeliveryDispatchError', {
  scheduleId: ScheduledTaskModel.ScheduleId,
  occurrence: ScheduledTaskModel.Occurrence,
  cause: Schema.Defect(),
}) {}

export interface Request {
  readonly task: ScheduledTaskModel.Task
  readonly proposal: WakeProposal.Proposal
}

export interface Interface {
  readonly isAvailable: (task: ScheduledTaskModel.Task) => Effect.Effect<boolean>
  readonly dispatch: (request: Request) => Effect.Effect<void, DispatchError>
}

/** Host boundary for turning one durably claimed occurrence into a role turn. */
export class Service extends Context.Service<Service, Interface>()(
  '@yokai/core/ScheduledDelivery',
) {}

export * as ScheduledDelivery from './delivery'
