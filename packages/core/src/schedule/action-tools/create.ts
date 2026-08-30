import { ActionTool, ActionToolXmlTemplate, SCHEDULE_CREATE_ACTION_TOOL_ID } from 'yokai-protocol'
import { Effect, Schema } from 'effect'

import { MessageArchiveEvent } from '@yokai-internal/memory'
import { CreateRequest, DedupeKey, Reason, RepeatEveryMinutes, TimeExpression } from '../model'
import type { ScheduledTask } from '../scheduled-task'
import {
  MAX_DURATION_MS,
  VERSION,
  decodeActionScope,
  executionError,
  repeatMilliseconds,
  strictScope,
} from './shared'

const CreateInput = Schema.Struct({
  'source-message-id': MessageArchiveEvent.MessageId,
  time: TimeExpression,
  reason: Reason,
  'dedupe-key': DedupeKey,
  'repeat-every-minutes': Schema.optionalKey(RepeatEveryMinutes),
})

interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}

const decodeInput = Schema.decodeUnknownEffect(CreateInput, { onExcessProperty: 'error' })
const isInput = Schema.is(CreateInput)

const INPUT_SCHEMA = {
  _tag: 'Object',
  description: 'Create one durable schedule in the host-locked current channel scope.',
  properties: [
    {
      name: 'source-message-id',
      required: true,
      schema: {
        _tag: 'String',
        description: 'Exact current-channel message ID that authorizes and owns the schedule.',
      },
    },
    {
      name: 'time',
      required: true,
      schema: {
        _tag: 'String',
        description:
          'Local YYYY-MM-DDTHH:mm[:ss], or HH:mm[:ss] for the next occurrence, in the host IANA time zone.',
      },
    },
    {
      name: 'reason',
      required: true,
      schema: { _tag: 'String', description: 'What should be revisited when the schedule fires.' },
    },
    {
      name: 'dedupe-key',
      required: true,
      schema: {
        _tag: 'String',
        description: 'Stable key unique to this intended schedule; reuse exactly on retries.',
      },
    },
    {
      name: 'repeat-every-minutes',
      required: false,
      schema: {
        _tag: 'Integer',
        minimum: 1,
        maximum: 5_256_000,
        description: 'Optional fixed repeat interval in minutes.',
      },
    },
  ],
} as const

const XML_TEMPLATE = ActionToolXmlTemplate.make(`<action tool="schedule.create">
  <source-message-id>EXACT SOURCE MESSAGE ID</source-message-id>
  <time>YYYY-MM-DDTHH:mm[:ss] OR HH:mm[:ss]</time>
  <reason>WHAT TO REVISIT</reason>
  <dedupe-key>STABLE UNIQUE KEY FOR THIS INTENT</dedupe-key>
  <repeat-every-minutes>POSITIVE INTEGER, OPTIONAL</repeat-every-minutes>
</action>`)

export const make = (service: ScheduledTask.Interface, instanceId: string): ActionTool =>
  ActionTool.make({
    id: SCHEDULE_CREATE_ACTION_TOOL_ID,
    protocolVersion: VERSION,
    description:
      'Create a persistent local schedule before sending the reply. Always cite an existing source message and use a stable dedupe key.',
    xmlTemplate: XML_TEMPLATE,
    inputSchema: INPUT_SCHEMA,
    executionStage: 'before-send',
    completionPolicy: 'none',
    failurePolicy: 'block-reply',
    maxDurationMs: MAX_DURATION_MS,
    isAvailable: (scope) => strictScope(instanceId, scope.instanceId),
    isInputAllowed: (scope, input) => strictScope(instanceId, scope.instanceId) && isInput(input),
    execute: Effect.fn('ScheduleCreateActionTool.execute')(function* (request) {
      const scope = yield* decodeActionScope(request.scope, SCHEDULE_CREATE_ACTION_TOOL_ID)
      const input = yield* decodeInput(request.input).pipe(
        Effect.mapError(() => executionError(SCHEDULE_CREATE_ACTION_TOOL_ID)),
      )
      yield* service
        .create(
          CreateRequest.make({
            scope,
            sourceMessageId: input['source-message-id'],
            time: input.time,
            reason: input.reason,
            dedupeKey: input['dedupe-key'],
            repeatEveryMs: repeatMilliseconds(input['repeat-every-minutes']),
          }),
        )
        .pipe(Effect.mapError(() => executionError(SCHEDULE_CREATE_ACTION_TOOL_ID)))
    }),
  })

export * as ScheduleCreateActionTool from './create'
