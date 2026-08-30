import { ActionTool, ActionToolXmlTemplate, SCHEDULE_UPDATE_ACTION_TOOL_ID } from 'yokai-protocol'
import { Effect, Schema } from 'effect'

import { Reason, RepeatEveryMinutes, ScheduleId, TimeExpression, UpdateRequest } from '../model'
import type { ScheduledTask } from '../scheduled-task'
import {
  MAX_DURATION_MS,
  VERSION,
  decodeActionScope,
  executionError,
  repeatMilliseconds,
  strictScope,
} from './shared'

const UpdateInput = Schema.Struct({
  'task-id': ScheduleId,
  time: TimeExpression,
  reason: Reason,
  'repeat-every-minutes': Schema.optionalKey(RepeatEveryMinutes),
})

interface UpdateInput extends Schema.Schema.Type<typeof UpdateInput> {}

const decodeInput = Schema.decodeUnknownEffect(UpdateInput, { onExcessProperty: 'error' })
const isInput = Schema.is(UpdateInput)

const INPUT_SCHEMA = {
  _tag: 'Object',
  description: 'Completely replace the mutable schedule fields for one pending task.',
  properties: [
    { name: 'task-id', required: true, schema: { _tag: 'String' } },
    {
      name: 'time',
      required: true,
      schema: {
        _tag: 'String',
        description:
          'Replacement local YYYY-MM-DDTHH:mm[:ss], or HH:mm[:ss], in the host IANA time zone.',
      },
    },
    {
      name: 'reason',
      required: true,
      schema: { _tag: 'String', description: 'Complete replacement reason.' },
    },
    {
      name: 'repeat-every-minutes',
      required: false,
      schema: {
        _tag: 'Integer',
        minimum: 1,
        maximum: 5_256_000,
        description: 'Replacement fixed repeat interval; omit to make it one-shot.',
      },
    },
  ],
} as const

const XML_TEMPLATE = ActionToolXmlTemplate.make(`<action tool="schedule.update">
  <task-id>EXACT TASK ID</task-id>
  <time>REPLACEMENT YYYY-MM-DDTHH:mm[:ss] OR HH:mm[:ss]</time>
  <reason>COMPLETE REPLACEMENT REASON</reason>
  <repeat-every-minutes>REPLACEMENT POSITIVE INTEGER, OPTIONAL</repeat-every-minutes>
</action>`)

export const make = (service: ScheduledTask.Interface, instanceId: string): ActionTool =>
  ActionTool.make({
    id: SCHEDULE_UPDATE_ACTION_TOOL_ID,
    protocolVersion: VERSION,
    description:
      'Replace the time, reason, and optional repetition of a pending schedule in the current channel.',
    xmlTemplate: XML_TEMPLATE,
    inputSchema: INPUT_SCHEMA,
    executionStage: 'before-send',
    completionPolicy: 'none',
    failurePolicy: 'block-reply',
    maxDurationMs: MAX_DURATION_MS,
    isAvailable: (scope) => strictScope(instanceId, scope.instanceId),
    isInputAllowed: (scope, input) => strictScope(instanceId, scope.instanceId) && isInput(input),
    execute: Effect.fn('ScheduleUpdateActionTool.execute')(function* (request) {
      const scope = yield* decodeActionScope(request.scope, SCHEDULE_UPDATE_ACTION_TOOL_ID)
      const input = yield* decodeInput(request.input).pipe(
        Effect.mapError(() => executionError(SCHEDULE_UPDATE_ACTION_TOOL_ID)),
      )
      yield* service
        .update(
          UpdateRequest.make({
            scope,
            scheduleId: input['task-id'],
            time: input.time,
            reason: input.reason,
            repeatEveryMs: repeatMilliseconds(input['repeat-every-minutes']),
          }),
        )
        .pipe(Effect.mapError(() => executionError(SCHEDULE_UPDATE_ACTION_TOOL_ID)))
    }),
  })

export * as ScheduleUpdateActionTool from './update'
