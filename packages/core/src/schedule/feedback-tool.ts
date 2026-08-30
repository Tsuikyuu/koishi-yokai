import {
  CapabilityDurationMilliseconds,
  CapabilityProtocolVersion,
  FeedbackTool,
  FeedbackToolExecutionError,
  FeedbackToolValidationError,
  SCHEDULE_QUERY_FEEDBACK_TOOL_ID,
  TokenLimit,
  type CapabilityScope,
} from 'yokai-protocol'
import { Effect, Option, Schema } from 'effect'

import { MessageArchiveEvent, MessageHistoryQuery } from '@yokai-internal/memory'
import { EpochMilliseconds, QueryLimit, QueryRequest, Statuses, type Task } from './model'
import type { ScheduledTask } from './scheduled-task'

const VERSION = CapabilityProtocolVersion.make({ major: 0, minor: 1 })
const MAX_RESULT_TOKENS = TokenLimit.make(2_048)
const MAX_DURATION_MS = CapabilityDurationMilliseconds.make(1_000)
const UTF8_BYTES_PER_TOKEN = 4
const MAX_RESULT_BYTES = MAX_RESULT_TOKENS * UTF8_BYTES_PER_TOKEN

export interface Options {
  readonly instanceId: string
  readonly queryLimit: QueryLimit
}

const QueryInput = Schema.Struct({
  statuses: Schema.optionalKey(Statuses),
  'creator-id': Schema.optionalKey(MessageArchiveEvent.ActorId),
  'due-from': Schema.optionalKey(EpochMilliseconds),
  'due-until': Schema.optionalKey(EpochMilliseconds),
  limit: Schema.optionalKey(QueryLimit),
})

interface QueryInput extends Schema.Schema.Type<typeof QueryInput> {}

const decodeInput = Schema.decodeUnknownEffect(QueryInput, { onExcessProperty: 'error' })
const decodeScope = Schema.decodeUnknownEffect(MessageArchiveEvent.ChannelScope)

const INPUT_SCHEMA = {
  _tag: 'Object',
  description: 'Query bounded schedules in the host-locked current channel scope.',
  properties: [
    {
      name: 'statuses',
      required: false,
      schema: {
        _tag: 'Array',
        minItems: 1,
        maxItems: 4,
        items: {
          _tag: 'StringEnum',
          values: ['pending', 'triggered', 'cancelled', 'expired'],
        },
      },
    },
    {
      name: 'creator-id',
      required: false,
      schema: { _tag: 'String', description: 'Exact creator ID.' },
    },
    {
      name: 'due-from',
      required: false,
      schema: {
        _tag: 'Integer',
        minimum: 0,
        description: 'Inclusive minimum due time as Unix milliseconds.',
      },
    },
    {
      name: 'due-until',
      required: false,
      schema: {
        _tag: 'Integer',
        minimum: 0,
        description: 'Inclusive maximum due time as Unix milliseconds.',
      },
    },
    {
      name: 'limit',
      required: false,
      schema: {
        _tag: 'Integer',
        minimum: 1,
        maximum: 32,
        description: 'Maximum result count; host configuration may impose a lower maximum.',
      },
    },
  ],
} as const

const OUTPUT_SCHEMA = {
  _tag: 'Object',
  properties: [
    { name: 'untrusted', required: true, schema: { _tag: 'Boolean' } },
    {
      name: 'tasks',
      required: true,
      schema: {
        _tag: 'Array',
        minItems: 0,
        maxItems: 32,
        items: {
          _tag: 'Object',
          properties: [
            { name: 'taskId', required: true, schema: { _tag: 'String' } },
            { name: 'creatorId', required: true, schema: { _tag: 'String' } },
            { name: 'createdMessageId', required: true, schema: { _tag: 'String' } },
            { name: 'reason', required: true, schema: { _tag: 'String' } },
            { name: 'dueAt', required: true, schema: { _tag: 'Integer', minimum: 0 } },
            {
              name: 'repeatEveryMs',
              required: false,
              schema: { _tag: 'Integer', minimum: 1 },
            },
            {
              name: 'status',
              required: true,
              schema: {
                _tag: 'StringEnum',
                values: ['pending', 'triggered', 'cancelled', 'expired'],
              },
            },
            { name: 'occurrence', required: true, schema: { _tag: 'Integer', minimum: 0 } },
            { name: 'timeZone', required: true, schema: { _tag: 'String' } },
          ],
        },
      },
    },
    { name: 'truncated', required: true, schema: { _tag: 'Boolean' } },
  ],
} as const

const optional = <A>(value: A | undefined): Option.Option<A> =>
  value === undefined ? Option.none<A>() : Option.some(value)

const validationFailure = (reason: FeedbackToolValidationError['reason']) =>
  new FeedbackToolValidationError({ toolId: SCHEDULE_QUERY_FEEDBACK_TOOL_ID, reason })

const executionFailure = (reason: FeedbackToolExecutionError['reason']) =>
  new FeedbackToolExecutionError({ toolId: SCHEDULE_QUERY_FEEDBACK_TOOL_ID, reason })

const taskJson = (task: Task): Schema.Json => {
  const base = {
    taskId: task.scheduleId,
    creatorId: task.creatorId,
    createdMessageId: task.createdMessageId,
    reason: task.reason,
    dueAt: task.dueAt,
    status: task.status,
    occurrence: task.occurrence,
    timeZone: task.timeZone,
  }
  return Option.match(task.repeatEveryMs, {
    onNone: () => base,
    onSome: (repeatEveryMs) => ({ ...base, repeatEveryMs }),
  })
}

const outputJson = (tasks: ReadonlyArray<Task>, truncated: boolean): Schema.Json => ({
  untrusted: true,
  tasks: tasks.map(taskJson),
  truncated,
})

const fitsOutputBudget = (serialized: string): boolean =>
  MessageHistoryQuery.estimateTextTokens(serialized) <= MAX_RESULT_TOKENS &&
  Buffer.byteLength(serialized, 'utf8') <= MAX_RESULT_BYTES

const boundedOutput = (tasks: ReadonlyArray<Task>, truncatedByQuery: boolean): Schema.Json => {
  const selected = tasks.reduce<ReadonlyArray<Task>>((accepted, task) => {
    const candidate = [...accepted, task]
    const output = outputJson(candidate, truncatedByQuery || candidate.length < tasks.length)
    const serialized = JSON.stringify(output)
    return serialized !== undefined && fitsOutputBudget(serialized) ? candidate : accepted
  }, [])
  return outputJson(selected, truncatedByQuery || selected.length < tasks.length)
}

const queryRequest = Effect.fn('ScheduledTaskFeedbackTool.queryRequest')(function* (
  scope: CapabilityScope,
  input: QueryInput,
  maximum: QueryLimit,
) {
  if (
    input['due-from'] !== undefined &&
    input['due-until'] !== undefined &&
    input['due-from'] > input['due-until']
  ) {
    return yield* Effect.fail(validationFailure('invalid-input'))
  }
  const channelScope = yield* decodeScope(scope).pipe(
    Effect.mapError(() => validationFailure('scope-denied')),
  )
  const requestedLimit = input.limit === undefined ? maximum : input.limit
  if (requestedLimit > maximum) {
    return yield* Effect.fail(validationFailure('budget-exceeded'))
  }
  return QueryRequest.make({
    scope: channelScope,
    statuses: input.statuses === undefined ? ['pending'] : input.statuses,
    creatorId: optional(input['creator-id']),
    dueFrom: optional(input['due-from']),
    dueUntil: optional(input['due-until']),
    limit: requestedLimit,
  })
})

export const make = (service: ScheduledTask.Interface, options: Options): FeedbackTool =>
  FeedbackTool.make({
    id: SCHEDULE_QUERY_FEEDBACK_TOOL_ID,
    protocolVersion: VERSION,
    description:
      'Query bounded persistent schedules in the current channel. Results return only to this model feedback round.',
    inputSchema: INPUT_SCHEMA,
    outputSchema: OUTPUT_SCHEMA,
    maxResultTokens: MAX_RESULT_TOKENS,
    maxDurationMs: MAX_DURATION_MS,
    isAvailable: (scope) => scope.instanceId === options.instanceId,
    prepare: Effect.fn('ScheduledTaskFeedbackTool.prepare')(function* (request) {
      if (request.scope.instanceId !== options.instanceId) {
        return yield* Effect.fail(validationFailure('scope-denied'))
      }
      const input = yield* decodeInput(request.input).pipe(
        Effect.mapError(() => validationFailure('invalid-input')),
      )
      const query = yield* queryRequest(request.scope, input, options.queryLimit)
      return {
        execute: () =>
          service.query(query).pipe(
            Effect.map((tasks) => boundedOutput(tasks, tasks.length === query.limit)),
            Effect.mapError(() => executionFailure('execution-failed')),
          ),
      }
    }),
  })

export * as ScheduledTaskFeedbackTool from './feedback-tool'
