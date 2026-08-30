import { ActionTool, ActionToolXmlTemplate, SCHEDULE_CANCEL_ACTION_TOOL_ID } from 'yokai-protocol'
import { Effect, Schema } from 'effect'

import { CancelRequest, ScheduleId } from '../model'
import type { ScheduledTask } from '../scheduled-task'
import { MAX_DURATION_MS, VERSION, decodeActionScope, executionError, strictScope } from './shared'

const CancelInput = Schema.Struct({
  'task-id': ScheduleId,
})

interface CancelInput extends Schema.Schema.Type<typeof CancelInput> {}

const decodeInput = Schema.decodeUnknownEffect(CancelInput, { onExcessProperty: 'error' })
const isInput = Schema.is(CancelInput)

const INPUT_SCHEMA = {
  _tag: 'Object',
  description: 'Cancel one pending schedule in the host-locked current channel scope.',
  properties: [{ name: 'task-id', required: true, schema: { _tag: 'String' } }],
} as const

const XML_TEMPLATE = ActionToolXmlTemplate.make(`<action tool="schedule.cancel">
  <task-id>EXACT TASK ID</task-id>
</action>`)

export const make = (service: ScheduledTask.Interface, instanceId: string): ActionTool =>
  ActionTool.make({
    id: SCHEDULE_CANCEL_ACTION_TOOL_ID,
    protocolVersion: VERSION,
    description: 'Cancel a pending persistent schedule in the current channel.',
    xmlTemplate: XML_TEMPLATE,
    inputSchema: INPUT_SCHEMA,
    executionStage: 'before-send',
    completionPolicy: 'none',
    failurePolicy: 'block-reply',
    maxDurationMs: MAX_DURATION_MS,
    isAvailable: (scope) => strictScope(instanceId, scope.instanceId),
    isInputAllowed: (scope, input) => strictScope(instanceId, scope.instanceId) && isInput(input),
    execute: Effect.fn('ScheduleCancelActionTool.execute')(function* (request) {
      const scope = yield* decodeActionScope(request.scope, SCHEDULE_CANCEL_ACTION_TOOL_ID)
      const input = yield* decodeInput(request.input).pipe(
        Effect.mapError(() => executionError(SCHEDULE_CANCEL_ACTION_TOOL_ID)),
      )
      yield* service
        .cancel(CancelRequest.make({ scope, scheduleId: input['task-id'] }))
        .pipe(Effect.mapError(() => executionError(SCHEDULE_CANCEL_ACTION_TOOL_ID)))
    }),
  })

export * as ScheduleCancelActionTool from './cancel'
