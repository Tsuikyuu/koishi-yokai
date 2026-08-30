import {
  CapabilityProtocolVersion,
  CapabilityDurationMilliseconds,
  FeedbackTool,
  FeedbackToolExecutionError,
  FeedbackToolValidationError,
  HISTORY_SEARCH_FEEDBACK_TOOL_ID,
  TokenLimit,
  type CapabilityScope,
} from 'yokai-protocol'
import { Effect, Option, Schema } from 'effect'

import { ActorId, ChannelScope, Timestamp } from '../message-archive/event'
import { MessageHistory } from './history'
import {
  HistoryCursor,
  HistoryFilters,
  HistoryKeyword,
  HistoryPageLimit,
  HistoryPageRequest,
  defaultPageLimit,
  estimateTextTokens,
  type HistoryPage,
} from './query'

const VERSION = CapabilityProtocolVersion.make({ major: 0, minor: 1 })
const TOOL_MAX_RESULT_TOKENS = TokenLimit.make(2_048)
const TOOL_PAGE_TOKEN_BUDGET = TokenLimit.make(1_792)
const TOOL_MAX_DURATION_MS = CapabilityDurationMilliseconds.make(1_000)

const HistorySearchInput = Schema.Struct({
  before: Schema.optionalKey(HistoryCursor),
  after: Schema.optionalKey(HistoryCursor),
  author: Schema.optionalKey(ActorId),
  keyword: Schema.optionalKey(HistoryKeyword),
  fromTimestamp: Schema.optionalKey(Timestamp),
  toTimestamp: Schema.optionalKey(Timestamp),
  limit: Schema.optionalKey(HistoryPageLimit),
})

interface HistorySearchInput extends Schema.Schema.Type<typeof HistorySearchInput> {}

const decodeSearchInput = Schema.decodeUnknownEffect(HistorySearchInput, {
  onExcessProperty: 'error',
})

const INPUT_SCHEMA = {
  _tag: 'Object',
  description: 'Search read-only history in the host-locked current channel scope.',
  properties: [
    {
      name: 'before',
      required: false,
      schema: { _tag: 'String', description: 'Opaque cursor for older messages.' },
    },
    {
      name: 'after',
      required: false,
      schema: { _tag: 'String', description: 'Opaque cursor for newer messages.' },
    },
    {
      name: 'author',
      required: false,
      schema: { _tag: 'String', description: 'Exact author ID.' },
    },
    {
      name: 'keyword',
      required: false,
      schema: { _tag: 'String', description: 'Case-insensitive content keyword.' },
    },
    {
      name: 'fromTimestamp',
      required: false,
      schema: {
        _tag: 'Integer',
        minimum: 0,
        description: 'Inclusive minimum Unix timestamp in milliseconds.',
      },
    },
    {
      name: 'toTimestamp',
      required: false,
      schema: {
        _tag: 'Integer',
        minimum: 0,
        description: 'Inclusive maximum Unix timestamp in milliseconds.',
      },
    },
    {
      name: 'limit',
      required: false,
      schema: {
        _tag: 'Integer',
        minimum: 1,
        maximum: 100,
        description: 'Page size; defaults to 40 and cannot exceed 100.',
      },
    },
  ],
} as const

const OUTPUT_SCHEMA = {
  _tag: 'Object',
  properties: [
    {
      name: 'untrusted',
      required: true,
      schema: { _tag: 'Boolean' },
    },
    {
      name: 'messages',
      required: true,
      schema: {
        _tag: 'Array',
        minItems: 0,
        maxItems: 100,
        items: {
          _tag: 'Object',
          properties: [
            { name: 'messageId', required: true, schema: { _tag: 'String' } },
            { name: 'authorId', required: true, schema: { _tag: 'String' } },
            {
              name: 'timestamp',
              required: true,
              schema: { _tag: 'Integer', minimum: 0 },
            },
            { name: 'content', required: true, schema: { _tag: 'String' } },
          ],
        },
      },
    },
    {
      name: 'hasMore',
      required: true,
      schema: { _tag: 'Boolean' },
    },
    {
      name: 'nextCursor',
      required: false,
      schema: { _tag: 'String' },
    },
  ],
} as const

const decodeScope = Schema.decodeUnknownEffect(ChannelScope)

const optional = <A>(value: A | undefined): Option.Option<A> =>
  value === undefined ? Option.none<A>() : Option.some(value)

const validationFailure = (reason: FeedbackToolValidationError['reason']) =>
  new FeedbackToolValidationError({ toolId: HISTORY_SEARCH_FEEDBACK_TOOL_ID, reason })

const executionFailure = (reason: FeedbackToolExecutionError['reason']) =>
  new FeedbackToolExecutionError({ toolId: HISTORY_SEARCH_FEEDBACK_TOOL_ID, reason })

const historyPageJson = (page: HistoryPage): Schema.Json => {
  const base = {
    untrusted: true,
    messages: page.messages.map((message) => ({
      messageId: message.messageId,
      authorId: message.authorId,
      timestamp: message.timestamp,
      content: message.content,
    })),
    hasMore: page.hasMore,
  }
  return Option.match(page.nextCursor, {
    onNone: () => base,
    onSome: (nextCursor) => ({ ...base, nextCursor }),
  })
}

const boundedHistoryPageJson = (
  page: HistoryPage,
): Effect.Effect<Schema.Json, FeedbackToolExecutionError> => {
  const output = historyPageJson(page)
  const serialized = JSON.stringify(output)
  return serialized === undefined || estimateTextTokens(serialized) > TOOL_MAX_RESULT_TOKENS
    ? Effect.fail(executionFailure('result-too-large'))
    : Effect.succeed(output)
}

const searchRequest = Effect.fn('HistorySearchFeedbackTool.searchRequest')(function* (
  scope: CapabilityScope,
  input: HistorySearchInput,
) {
  if (input.before !== undefined && input.after !== undefined) {
    return yield* Effect.fail(validationFailure('invalid-input'))
  }
  if (
    input.fromTimestamp !== undefined &&
    input.toTimestamp !== undefined &&
    input.fromTimestamp > input.toTimestamp
  ) {
    return yield* Effect.fail(validationFailure('invalid-input'))
  }

  const channelScope = yield* decodeScope(scope).pipe(
    Effect.mapError(() => validationFailure('scope-denied')),
  )
  const direction = input.after === undefined ? 'before' : 'after'
  const encodedCursor = input.after === undefined ? input.before : input.after
  return HistoryPageRequest.make({
    scope: channelScope,
    direction,
    cursor: optional(encodedCursor),
    limit: input.limit === undefined ? defaultPageLimit() : input.limit,
    filters: HistoryFilters.make({
      authorId: optional(input.author),
      keyword: optional(input.keyword),
      fromTimestamp: optional(input.fromTimestamp),
      toTimestamp: optional(input.toTimestamp),
    }),
    tokenBudget: TOOL_PAGE_TOKEN_BUDGET,
  })
})

export const make = (history: MessageHistory.Interface): FeedbackTool =>
  FeedbackTool.make({
    id: HISTORY_SEARCH_FEEDBACK_TOOL_ID,
    protocolVersion: VERSION,
    description:
      'Search read-only messages in the host-locked current channel by author, keyword, time, and stable cursor.',
    inputSchema: INPUT_SCHEMA,
    outputSchema: OUTPUT_SCHEMA,
    maxResultTokens: TOOL_MAX_RESULT_TOKENS,
    maxDurationMs: TOOL_MAX_DURATION_MS,
    isAvailable: () => true,
    prepare: Effect.fn('HistorySearchFeedbackTool.prepare')(function* (request) {
      const rawLimit = request.input.limit
      if (typeof rawLimit === 'number' && rawLimit > 100) {
        return yield* Effect.fail(validationFailure('budget-exceeded'))
      }
      const input = yield* decodeSearchInput(request.input).pipe(
        Effect.mapError(() => validationFailure('invalid-input')),
      )
      const pageRequest = yield* searchRequest(request.scope, input)
      const prepared = yield* history
        .prepare(pageRequest)
        .pipe(
          Effect.mapError((error) =>
            error._tag === 'MessageHistoryCursorScopeMismatchError' ||
            error._tag === 'MessageHistoryInstanceScopeMismatchError'
              ? validationFailure('scope-denied')
              : error._tag === 'MessageHistoryCursorInvalidError' ||
                  error._tag === 'MessageHistoryInvalidTimeRangeError'
                ? validationFailure('invalid-input')
                : validationFailure('unavailable'),
          ),
        )
      return {
        execute: () =>
          prepared.execute().pipe(
            Effect.mapError((error) =>
              error._tag === 'MessageHistoryResultBudgetExceededError'
                ? executionFailure('result-too-large')
                : executionFailure('execution-failed'),
            ),
            Effect.flatMap(boundedHistoryPageJson),
          ),
      }
    }),
  })

export * as HistorySearchFeedbackTool from './feedback-tool'
