import {
  ContinueRequest,
  FeedbackToolRequest,
  GenerateRequest,
  ToolResult,
  feedbackToolDeclaration,
  validatePortableToolInput,
  validatePortableValue,
  type CapabilityScope,
  type FeedbackTool,
  type FinalTextResult,
  type PreparedFeedbackToolCall,
  type ToolCall,
  type ToolFailureReason,
  type YokaiAdapter,
} from 'yokai-protocol'
import { Cause, Clock, Duration, Effect, Schema } from 'effect'

import type { WakeArbiter } from '../wake/index'

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
  readonly maxConcurrency: number
}

export interface Options {
  readonly adapter: YokaiAdapter
  readonly request: GenerateRequest
  readonly scope: CapabilityScope
  readonly tools: ReadonlyArray<FeedbackTool>
  readonly budget: Budget
  readonly withContinuationCall: WakeArbiter.WithLogicalCallReservation
}

interface PreparedCall {
  readonly call: ToolCall
  readonly tool: FeedbackTool
  readonly prepared: PreparedFeedbackToolCall
}

export interface Report {
  readonly result: FinalTextResult
  readonly path: 'single-pass' | 'bounded-feedback'
  readonly logicalGenerations: 1 | 2
  readonly modelDurationMs: number
}

interface Timed<A> {
  readonly value: A
  readonly durationMs: number
}

const timed = Effect.fn('FeedbackGeneration.timed')(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const startedAt = yield* Clock.currentTimeMillis
  const value = yield* effect
  const completedAt = yield* Clock.currentTimeMillis
  return { value, durationMs: Math.max(0, completedAt - startedAt) } satisfies Timed<A>
})

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

  return yield* Effect.forEach(calls, (call, index) =>
    Effect.gen(function* () {
      const tool = selectedTools[index]
      if (tool === undefined) return yield* Effect.fail(invalid('unknown-tool'))
      if (!validatePortableToolInput(tool.inputSchema, call.input)) {
        return yield* Effect.fail(invalid('invalid-input'))
      }
      const available = yield* Effect.try({
        try: () => tool.isAvailable(scope),
        catch: () => invalid('unavailable'),
      })
      if (!available) return yield* Effect.fail(invalid('unavailable'))
      return yield* tool.prepare(FeedbackToolRequest.make({ scope, input: call.input })).pipe(
        Effect.map((prepared) => ({ call, tool, prepared }) satisfies PreparedCall),
        Effect.mapError((error) => invalid(error.reason)),
      )
    }),
  )
})

const failureResult = (prepared: PreparedCall, reason: ToolFailureReason) =>
  ToolResult.cases.Failure.make({ callId: prepared.call.callId, reason })

const withinResultBudget = (prepared: PreparedCall, output: Schema.Json): boolean => {
  const serialized = JSON.stringify(output)
  return (
    serialized !== undefined &&
    Buffer.byteLength(serialized, 'utf8') <= prepared.tool.maxResultTokens * 4
  )
}

const execute = Effect.fn('FeedbackGeneration.execute')(function* (prepared: PreparedCall) {
  return yield* Effect.suspend(() => prepared.prepared.execute()).pipe(
    Effect.timeout(Duration.millis(prepared.tool.maxDurationMs)),
    Effect.map((output) =>
      !validatePortableValue(prepared.tool.outputSchema, output)
        ? failureResult(prepared, 'invalid-output')
        : !withinResultBudget(prepared, output)
          ? failureResult(prepared, 'result-too-large')
          : ToolResult.cases.Success.make({ callId: prepared.call.callId, output }),
    ),
    Effect.catch((error) =>
      Effect.succeed(
        failureResult(prepared, Cause.isTimeoutError(error) ? 'timeout' : error.reason),
      ),
    ),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.succeed(failureResult(prepared, 'execution-failed')),
    ),
  )
})

export const runWithReport = Effect.fn('FeedbackGeneration.runWithReport')(function* (
  options: Options,
) {
  const request = GenerateRequest.make({
    ...options.request,
    feedbackTools: options.tools.map(feedbackToolDeclaration),
  })
  const initial = yield* timed(options.adapter.generate(request))
  if (initial.value._tag === 'Text') {
    return {
      result: initial.value,
      path: 'single-pass',
      logicalGenerations: 1,
      modelDurationMs: initial.durationMs,
    } satisfies Report
  }

  const calls = initial.value.calls
  const continuation = initial.value.continuation
  return yield* options.withContinuationCall((markContinuationDispatched) =>
    Effect.gen(function* () {
      const prepared = yield* prepareBatch(calls, options.tools, options.scope, options.budget)
      const results = yield* Effect.forEach(prepared, execute, {
        concurrency: options.budget.maxConcurrency,
      })
      const first = results[0]
      if (first === undefined) return yield* Effect.die('Feedback tool call batch was empty')
      const continueRequest = ContinueRequest.make({
        continuation,
        results: [first, ...results.slice(1)],
      })
      const dispatched = yield* markContinuationDispatched()
      if (!dispatched) {
        return yield* Effect.die('Feedback continuation reservation was already settled')
      }
      const final = yield* timed(Effect.suspend(() => options.adapter.continue(continueRequest)))
      return {
        result: final.value,
        path: 'bounded-feedback',
        logicalGenerations: 2,
        modelDurationMs: initial.durationMs + final.durationMs,
      } satisfies Report
    }),
  )
})

export const run = Effect.fn('FeedbackGeneration.run')(function* (options: Options) {
  return yield* runWithReport(options).pipe(Effect.map((report) => report.result))
})

export * as FeedbackGeneration from './feedback-generation'
