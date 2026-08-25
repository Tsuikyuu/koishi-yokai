import {
  ContinueRequest,
  FeedbackToolRequest,
  GenerateRequest,
  ToolResult,
  feedbackToolDeclaration,
  type CapabilityScope,
  type FeedbackTool,
  type PreparedFeedbackToolCall,
  type ToolCall,
  type YokaiAdapter,
} from 'yokai-protocol'
import { Effect, Schema } from 'effect'

export const FeedbackBatchInvalidReason = Schema.Literals([
  'duplicate-call-id',
  'unknown-tool',
  'invalid-input',
  'scope-denied',
  'budget-exceeded',
  'unavailable',
])

export type FeedbackBatchInvalidReason = typeof FeedbackBatchInvalidReason.Type

export class FeedbackBatchInvalidError extends Schema.TaggedError<FeedbackBatchInvalidError>(
  '@yokai/core/FeedbackGeneration.FeedbackBatchInvalidError',
)('FeedbackBatchInvalidError', {
  reason: FeedbackBatchInvalidReason,
}) {}

export interface Budget {
  readonly maxCalls: number
  readonly maxResultTokens: number
}

export interface Options {
  readonly adapter: YokaiAdapter
  readonly request: GenerateRequest
  readonly scope: CapabilityScope
  readonly tools: ReadonlyArray<FeedbackTool>
  readonly budget: Budget
}

interface PreparedCall {
  readonly call: ToolCall
  readonly prepared: PreparedFeedbackToolCall
}

const invalid = (reason: FeedbackBatchInvalidReason) => new FeedbackBatchInvalidError({ reason })

const prepareBatch = Effect.fn('FeedbackGeneration.prepareBatch')(function* (
  calls: ReadonlyArray<ToolCall>,
  tools: ReadonlyArray<FeedbackTool>,
  scope: CapabilityScope,
  budget: Budget,
) {
  const callIds = calls.map((call) => call.callId)
  if (new Set(callIds).size !== callIds.length) {
    return yield* Effect.fail(invalid('duplicate-call-id'))
  }
  if (calls.length > budget.maxCalls) {
    return yield* Effect.fail(invalid('budget-exceeded'))
  }

  const selectedTools = yield* Effect.forEach(calls, (call) => {
    const tool = tools.find((candidate) => candidate.id === call.toolId)
    return tool === undefined ? Effect.fail(invalid('unknown-tool')) : Effect.succeed(tool)
  })
  const declaredResultTokens = selectedTools.reduce(
    (total, tool) => total + tool.maxResultTokens,
    0,
  )
  if (declaredResultTokens > budget.maxResultTokens) {
    return yield* Effect.fail(invalid('budget-exceeded'))
  }

  return yield* Effect.forEach(calls, (call, index) => {
    const tool = selectedTools[index]
    if (tool === undefined) return Effect.fail(invalid('unknown-tool'))
    return tool.prepare(FeedbackToolRequest.make({ scope, input: call.input })).pipe(
      Effect.map((prepared) => ({ call, prepared }) satisfies PreparedCall),
      Effect.mapError((error) => invalid(error.reason)),
    )
  })
})

const execute = Effect.fn('FeedbackGeneration.execute')(function* (prepared: PreparedCall) {
  return yield* prepared.prepared.execute().pipe(
    Effect.map((output) => ToolResult.cases.Success.make({ callId: prepared.call.callId, output })),
    Effect.catch((error) =>
      Effect.succeed(
        ToolResult.cases.Failure.make({
          callId: prepared.call.callId,
          reason: error.reason,
        }),
      ),
    ),
  )
})

export const run = Effect.fn('FeedbackGeneration.run')(function* (options: Options) {
  const request = GenerateRequest.make({
    ...options.request,
    feedbackTools: options.tools.map(feedbackToolDeclaration),
  })
  const initial = yield* options.adapter.generate(request)
  if (initial._tag === 'Text') return initial

  const prepared = yield* prepareBatch(initial.calls, options.tools, options.scope, options.budget)
  const results = yield* Effect.forEach(prepared, execute, { concurrency: 'unbounded' })
  const first = results[0]
  if (first === undefined) return yield* Effect.die('Feedback tool call batch was empty')
  return yield* options.adapter.continue(
    ContinueRequest.make({
      continuation: initial.continuation,
      results: [first, ...results.slice(1)],
    }),
  )
})

export * as FeedbackGeneration from './feedback-generation'
