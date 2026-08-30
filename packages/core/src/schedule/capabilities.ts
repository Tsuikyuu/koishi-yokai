import type { ActionTool, ContextProvider, FeedbackTool } from 'yokai-protocol'

import { ScheduleCancelActionTool } from './action-tools/cancel'
import { ScheduleCreateActionTool } from './action-tools/create'
import { ScheduleUpdateActionTool } from './action-tools/update'
import { ScheduledTaskContextProvider } from './context-provider'
import { ScheduledTaskFeedbackTool } from './feedback-tool'
import type { QueryLimit, TimeZoneId } from './model'
import type { ScheduledTask } from './scheduled-task'

export interface Options {
  readonly instanceId: string
  readonly timeZone: TimeZoneId
  readonly contextLimit: QueryLimit
}

export const makeContextProvider = (
  service: ScheduledTask.Interface,
  options: Options,
): ContextProvider => ScheduledTaskContextProvider.make(service, options)

export const makeFeedbackTool = (
  service: ScheduledTask.Interface,
  options: Options,
): FeedbackTool =>
  ScheduledTaskFeedbackTool.make(service, {
    instanceId: options.instanceId,
    queryLimit: options.contextLimit,
  })

export const makeActionTools = (
  service: ScheduledTask.Interface,
  options: Options,
): readonly [ActionTool, ActionTool, ActionTool] => [
  ScheduleCreateActionTool.make(service, options.instanceId),
  ScheduleUpdateActionTool.make(service, options.instanceId),
  ScheduleCancelActionTool.make(service, options.instanceId),
]

export * as ScheduledTaskCapabilities from './capabilities'
