import { expect, it } from '@effect/vitest'
import { AdapterConformanceSetup, AdapterGenerationStep } from 'yokai-adapter-conformance'
import { makeFakeAdapter } from 'yokai-adapter-conformance/fake'
import {
  AdapterId,
  AdapterModelId,
  CapabilityDurationMilliseconds,
  CapabilityProtocolVersion,
  CapabilityScope,
  FeedbackTool,
  FeedbackToolId,
  FeedbackToolValidationError,
  GenerateRequest,
  GenerationUsage,
  TokenLimit,
  ToolCall,
  ToolCallId,
  UserMessage,
  makeAdapterContinuation,
  type AdapterContinuation,
  type ContinueRequest,
  type InitialGenerationResult,
  type ToolCalls,
  type YokaiAdapter,
} from 'yokai-protocol'
import { Deferred, Duration, Effect, Fiber, Ref } from 'effect'
import { TestClock } from 'effect/testing'

import { FeedbackGeneration, WakeArbiter } from '../../src/index'

const ADAPTER_ID = AdapterId.make('feedback-turn')
const MODEL_ID = AdapterModelId.make('model')
const TOOL_ID = FeedbackToolId.make('history.search')
const VERSION = CapabilityProtocolVersion.make({ major: 0, minor: 1 })
const SCOPE = CapabilityScope.make({
  instanceId: 'test',
  platform: 'test',
  guildId: 'guild',
  channelId: 'channel',
})
const USAGE = GenerationUsage.cases.Unavailable.make({})

const withContinuationCall: WakeArbiter.WithLogicalCallReservation = (use) =>
  use(() => Effect.succeed(true))

const request = GenerateRequest.make({
  modelId: MODEL_ID,
  messages: [UserMessage.make({ role: 'user', content: 'What happened?' })],
  limits: { maxOutputTokens: TokenLimit.make(256) },
  feedbackTools: [],
})

const finalText = AdapterGenerationStep.cases.Text.make({
  result: {
    _tag: 'Text',
    text: '<output><message>done</message></output>',
    finishReason: 'stop',
    usage: USAGE,
  },
  blocked: false,
})

const toolCalls = (...validInputs: ReadonlyArray<boolean>) =>
  AdapterGenerationStep.cases.ToolCalls.make({
    calls: validInputs.map((valid, index) =>
      ToolCall.make({
        callId: ToolCallId.make(`call-${index}`),
        toolId: TOOL_ID,
        input: { valid },
      }),
    ),
    usage: USAGE,
    blocked: false,
  })

interface ToolOverrides {
  readonly id?: FeedbackToolId
  readonly maxResultTokens?: number
  readonly maxDurationMs?: number
  readonly isAvailable?: FeedbackTool['isAvailable']
  readonly prepare?: FeedbackTool['prepare']
}

const makeTool = (executions: Ref.Ref<number>, overrides: ToolOverrides = {}): FeedbackTool => {
  const id = overrides.id === undefined ? TOOL_ID : overrides.id
  const maxResultTokens = overrides.maxResultTokens === undefined ? 64 : overrides.maxResultTokens
  const maxDurationMs = overrides.maxDurationMs === undefined ? 250 : overrides.maxDurationMs
  const isAvailable = overrides.isAvailable === undefined ? () => true : overrides.isAvailable
  const prepare =
    overrides.prepare === undefined
      ? (toolRequest: Parameters<FeedbackTool['prepare']>[0]) =>
          toolRequest.input.valid === true
            ? Effect.succeed({
                execute: () =>
                  Ref.update(executions, (count) => count + 1).pipe(
                    Effect.as({ messages: ['bounded history result'] }),
                  ),
              })
            : Effect.fail(new FeedbackToolValidationError({ toolId: id, reason: 'invalid-input' }))
      : overrides.prepare

  return FeedbackTool.make({
    id,
    protocolVersion: VERSION,
    description: 'Test history lookup',
    inputSchema: {
      _tag: 'Object',
      properties: [
        {
          name: 'valid',
          required: true,
          schema: { _tag: 'Boolean' },
        },
      ],
    },
    outputSchema: {
      _tag: 'Object',
      properties: [
        {
          name: 'messages',
          required: true,
          schema: {
            _tag: 'Array',
            items: { _tag: 'String' },
            minItems: 0,
            maxItems: 4,
          },
        },
      ],
    },
    maxResultTokens: TokenLimit.make(maxResultTokens),
    maxDurationMs: CapabilityDurationMilliseconds.make(maxDurationMs),
    isAvailable,
    prepare,
  })
}

const call = (callId: string, toolId: FeedbackToolId, input: ToolCall['input']): ToolCall =>
  ToolCall.make({ callId: ToolCallId.make(callId), toolId, input })

const batchCalls = (first: ToolCall, ...rest: ReadonlyArray<ToolCall>): ToolCalls => [
  first,
  ...rest,
]

const scriptedToolCalls = (first: ToolCall, ...rest: ReadonlyArray<ToolCall>) =>
  AdapterGenerationStep.cases.ToolCalls.make({
    calls: [first, ...rest],
    usage: USAGE,
    blocked: false,
  })

const rawAdapter = (
  base: YokaiAdapter,
  continuation: AdapterContinuation,
  calls: ToolCalls,
  continuations: Ref.Ref<number>,
): YokaiAdapter => ({
  ...base,
  generate: () =>
    Effect.succeed({
      _tag: 'ToolCallBatch',
      calls,
      continuation,
      usage: USAGE,
    } satisfies InitialGenerationResult),
  continue: () =>
    Ref.update(continuations, (count) => count + 1).pipe(
      Effect.andThen(Effect.die('Invalid feedback batches must not continue generation')),
    ),
})

const makeSubject = (steps: ReadonlyArray<AdapterGenerationStep>) =>
  makeFakeAdapter(
    {
      adapterId: ADAPTER_ID,
      feedbackTools: true,
      tokenNamespace: 'yk014',
    },
    AdapterConformanceSetup.make({ discoverySteps: [], generationSteps: steps }),
  )

it.effect('feeds history results into exactly one final generation without redeclaring tools', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const subject = yield* makeSubject([toolCalls(true), finalText])
      const executions = yield* Ref.make(0)
      const continuations = yield* Ref.make<ReadonlyArray<ContinueRequest>>([])
      const logicalReservations = yield* Ref.make(0)
      const continuationDispatches = yield* Ref.make(0)
      const withTrackedContinuationCall: WakeArbiter.WithLogicalCallReservation = (use) =>
        Ref.update(logicalReservations, (count) => count + 1).pipe(
          Effect.andThen(
            use(() =>
              Ref.update(continuationDispatches, (count) => count + 1).pipe(Effect.as(true)),
            ),
          ),
        )
      const adapter: YokaiAdapter = {
        ...subject.adapter,
        continue: (continueRequest) =>
          Ref.update(continuations, (requests) => [...requests, continueRequest]).pipe(
            Effect.andThen(subject.adapter.continue(continueRequest)),
          ),
      }

      const result = yield* FeedbackGeneration.run({
        adapter,
        request,
        scope: SCOPE,
        tools: [makeTool(executions)],
        withContinuationCall: withTrackedContinuationCall,
        budget: { maxCalls: 1, maxResultTokens: 64, maxConcurrency: 1 },
      })
      expect(result.text).toContain('<message>done</message>')
      expect(yield* Ref.get(executions)).toBe(1)
      expect(yield* Ref.get(logicalReservations)).toBe(1)
      expect(yield* Ref.get(continuationDispatches)).toBe(1)

      const continueRequests = yield* Ref.get(continuations)
      expect(continueRequests).toHaveLength(1)
      const finalRequest = continueRequests[0]
      if (finalRequest === undefined) return yield* Effect.die('Expected one continuation')
      expect(Object.keys(finalRequest).sort()).toEqual(['continuation', 'results'])
      expect(finalRequest.results[0]).toMatchObject({
        _tag: 'Success',
        output: { messages: ['bounded history result'] },
      })

      const starts = (yield* subject.control.events()).filter(
        (event) => event._tag === 'RequestStarted' && event.kind === 'generation',
      )
      expect(starts).toMatchObject([{ operation: 'generate' }, { operation: 'continue' }])
    }),
  ),
)

it.effect('does not reserve a continuation call for a single-pass response', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const subject = yield* makeSubject([finalText])
      const executions = yield* Ref.make(0)
      const logicalReservations = yield* Ref.make(0)
      const failIfReserved: WakeArbiter.WithLogicalCallReservation = () =>
        Ref.update(logicalReservations, (count) => count + 1).pipe(
          Effect.andThen(Effect.die('Single-pass generation must not reserve a continuation')),
        )

      const result = yield* FeedbackGeneration.run({
        adapter: subject.adapter,
        request,
        scope: SCOPE,
        tools: [makeTool(executions)],
        withContinuationCall: failIfReserved,
        budget: { maxCalls: 1, maxResultTokens: 64, maxConcurrency: 1 },
      })

      expect(result.text).toContain('<message>done</message>')
      expect(yield* Ref.get(logicalReservations)).toBe(0)
      expect(yield* Ref.get(executions)).toBe(0)
    }),
  ),
)

it.effect('rejects an invalid batch atomically before executing any valid call', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const subject = yield* makeSubject([toolCalls(true, false)])
      const executions = yield* Ref.make(0)
      const error = yield* FeedbackGeneration.run({
        adapter: subject.adapter,
        request,
        scope: SCOPE,
        tools: [makeTool(executions)],
        withContinuationCall,
        budget: { maxCalls: 2, maxResultTokens: 128, maxConcurrency: 2 },
      }).pipe(Effect.flip)

      expect(error._tag).toBe('FeedbackBatchInvalidError')
      expect(yield* Ref.get(executions)).toBe(0)
      const starts = (yield* subject.control.events()).filter(
        (event) => event._tag === 'RequestStarted' && event.kind === 'generation',
      )
      expect(starts).toHaveLength(1)
    }),
  ),
)

it.effect('rejects every invalid batch class before executing any prepared call', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const subject = yield* makeSubject([])
      const continuation = yield* makeAdapterContinuation('invalid-feedback-batch')
      const continuations = yield* Ref.make(0)
      const validCall = (id: string) => call(id, TOOL_ID, { valid: true })
      const budget: FeedbackGeneration.Budget = {
        maxCalls: 2,
        maxResultTokens: 128,
        maxConcurrency: 2,
      }
      const assertInvalid = (
        calls: ToolCalls,
        tools: ReadonlyArray<FeedbackTool>,
        selectedBudget: FeedbackGeneration.Budget,
        expectedReason: FeedbackGeneration.FeedbackBatchInvalidReason,
        executions: Ref.Ref<number>,
      ) =>
        Effect.gen(function* () {
          const error = yield* FeedbackGeneration.run({
            adapter: rawAdapter(subject.adapter, continuation, calls, continuations),
            request,
            scope: SCOPE,
            tools,
            withContinuationCall,
            budget: selectedBudget,
          }).pipe(Effect.flip)

          expect(error).toMatchObject({
            _tag: 'FeedbackBatchInvalidError',
            reason: expectedReason,
          })
          expect(yield* Ref.get(executions)).toBe(0)
          expect(yield* Ref.get(continuations)).toBe(0)
        })

      const duplicateExecutions = yield* Ref.make(0)
      const duplicateTool = makeTool(duplicateExecutions)
      yield* assertInvalid(
        batchCalls(validCall('duplicate'), validCall('duplicate')),
        [duplicateTool],
        budget,
        'duplicate-call-id',
        duplicateExecutions,
      )

      const unknownExecutions = yield* Ref.make(0)
      const unknownTool = makeTool(unknownExecutions)
      yield* assertInvalid(
        batchCalls(
          validCall('known-before-unknown'),
          call('unknown', FeedbackToolId.make('missing.tool'), { valid: true }),
        ),
        [unknownTool],
        budget,
        'unknown-tool',
        unknownExecutions,
      )

      const invalidInputExecutions = yield* Ref.make(0)
      const inputTool = makeTool(invalidInputExecutions)
      yield* assertInvalid(
        batchCalls(
          validCall('known-before-invalid-input'),
          call('invalid-input', TOOL_ID, { valid: 'not-a-boolean' }),
        ),
        [inputTool],
        budget,
        'invalid-input',
        invalidInputExecutions,
      )

      const unavailableExecutions = yield* Ref.make(0)
      const unavailableId = FeedbackToolId.make('history.unavailable')
      yield* assertInvalid(
        batchCalls(
          validCall('known-before-unavailable'),
          call('unavailable', unavailableId, { valid: true }),
        ),
        [
          makeTool(unavailableExecutions),
          makeTool(unavailableExecutions, {
            id: unavailableId,
            isAvailable: () => false,
          }),
        ],
        budget,
        'unavailable',
        unavailableExecutions,
      )

      const scopeDeniedExecutions = yield* Ref.make(0)
      const scopeDeniedId = FeedbackToolId.make('history.scope-denied')
      yield* assertInvalid(
        batchCalls(
          validCall('known-before-scope-denied'),
          call('scope-denied', scopeDeniedId, { valid: true }),
        ),
        [
          makeTool(scopeDeniedExecutions),
          makeTool(scopeDeniedExecutions, {
            id: scopeDeniedId,
            prepare: () =>
              Effect.fail(
                new FeedbackToolValidationError({
                  toolId: scopeDeniedId,
                  reason: 'scope-denied',
                }),
              ),
          }),
        ],
        budget,
        'scope-denied',
        scopeDeniedExecutions,
      )

      const callBudgetExecutions = yield* Ref.make(0)
      const callBudgetTool = makeTool(callBudgetExecutions)
      yield* assertInvalid(
        batchCalls(validCall('call-budget-first'), validCall('call-budget-second')),
        [callBudgetTool],
        { ...budget, maxCalls: 1 },
        'budget-exceeded',
        callBudgetExecutions,
      )

      const resultBudgetExecutions = yield* Ref.make(0)
      const resultBudgetTool = makeTool(resultBudgetExecutions)
      yield* assertInvalid(
        batchCalls(validCall('result-budget-first'), validCall('result-budget-second')),
        [resultBudgetTool],
        { ...budget, maxResultTokens: 127 },
        'budget-exceeded',
        resultBudgetExecutions,
      )
    }),
  ),
)

it.effect('normalizes bounded execution failures and continues exactly once', () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const timeoutId = FeedbackToolId.make('history.timeout')
      const invalidOutputId = FeedbackToolId.make('history.invalid-output')
      const oversizedId = FeedbackToolId.make('history.oversized')
      const throwingId = FeedbackToolId.make('history.throwing')
      const timeoutCall = call('timeout-call', timeoutId, { valid: true })
      const invalidOutputCall = call('invalid-output-call', invalidOutputId, { valid: true })
      const oversizedCall = call('oversized-call', oversizedId, { valid: true })
      const throwingCall = call('throwing-call', throwingId, { valid: true })
      const subject = yield* makeSubject([
        scriptedToolCalls(timeoutCall, invalidOutputCall, oversizedCall, throwingCall),
        finalText,
      ])
      const executions = yield* Ref.make(0)
      const allStarted = yield* Deferred.make<void>()
      const continuations = yield* Ref.make<ReadonlyArray<ContinueRequest>>([])
      const beginExecution = () =>
        Ref.updateAndGet(executions, (count) => count + 1).pipe(
          Effect.flatMap((count) =>
            count === 3 ? Deferred.succeed(allStarted, undefined) : Effect.void,
          ),
        )
      const timeoutTool = makeTool(executions, {
        id: timeoutId,
        maxDurationMs: 100,
        prepare: () =>
          Effect.succeed({
            execute: () => beginExecution().pipe(Effect.andThen(Effect.never)),
          }),
      })
      const invalidOutputTool = makeTool(executions, {
        id: invalidOutputId,
        prepare: () =>
          Effect.succeed({
            execute: () => beginExecution().pipe(Effect.as({ messages: [1] })),
          }),
      })
      const oversizedTool = makeTool(executions, {
        id: oversizedId,
        maxResultTokens: 1,
        prepare: () =>
          Effect.succeed({
            execute: () =>
              beginExecution().pipe(
                Effect.as({ messages: ['this result is larger than four bytes'] }),
              ),
          }),
      })
      const throwingTool = makeTool(executions, {
        id: throwingId,
        prepare: () =>
          Effect.succeed({
            execute: () => {
              throw new Error('synchronous feedback execution failure')
            },
          }),
      })
      const adapter: YokaiAdapter = {
        ...subject.adapter,
        continue: (continueRequest) =>
          Ref.update(continuations, (requests) => [...requests, continueRequest]).pipe(
            Effect.andThen(subject.adapter.continue(continueRequest)),
          ),
      }

      const fiber = yield* FeedbackGeneration.run({
        adapter,
        request,
        scope: SCOPE,
        tools: [timeoutTool, invalidOutputTool, oversizedTool, throwingTool],
        withContinuationCall,
        budget: { maxCalls: 4, maxResultTokens: 193, maxConcurrency: 4 },
      }).pipe(Effect.forkScoped)

      yield* Deferred.await(allStarted)
      expect(yield* Ref.get(executions)).toBe(3)
      expect(yield* Ref.get(continuations)).toEqual([])
      yield* TestClock.adjust(Duration.millis(99))
      expect(yield* Ref.get(continuations)).toEqual([])
      yield* TestClock.adjust(Duration.millis(1))

      expect((yield* Fiber.join(fiber)).text).toContain('<message>done</message>')
      const continueRequests = yield* Ref.get(continuations)
      expect(continueRequests).toHaveLength(1)
      const finalRequest = continueRequests[0]
      if (finalRequest === undefined) return yield* Effect.die('Expected one continuation')
      expect(finalRequest.results).toEqual([
        { _tag: 'Failure', callId: 'timeout-call', reason: 'timeout' },
        { _tag: 'Failure', callId: 'invalid-output-call', reason: 'invalid-output' },
        { _tag: 'Failure', callId: 'oversized-call', reason: 'result-too-large' },
        { _tag: 'Failure', callId: 'throwing-call', reason: 'execution-failed' },
      ])
    }),
  ),
)

it.effect('honors the feedback execution concurrency limit with TestClock', () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const subject = yield* makeSubject([toolCalls(true, true, true, true), finalText])
      const starts = yield* Ref.make(0)
      const active = yield* Ref.make(0)
      const peak = yield* Ref.make(0)
      const firstStarted = yield* Deferred.make<void>()
      const continuations = yield* Ref.make(0)
      const tool = makeTool(starts, {
        maxDurationMs: 500,
        prepare: () =>
          Effect.succeed({
            execute: () =>
              Effect.gen(function* () {
                const currentActive = yield* Ref.updateAndGet(active, (count) => count + 1)
                yield* Ref.update(peak, (current) => Math.max(current, currentActive))
                const started = yield* Ref.updateAndGet(starts, (count) => count + 1)
                if (started === 1) yield* Deferred.succeed(firstStarted, undefined)
                yield* Effect.sleep(Duration.millis(100))
                yield* Ref.update(active, (count) => count - 1)
                return { messages: ['concurrent result'] }
              }),
          }),
      })
      const adapter: YokaiAdapter = {
        ...subject.adapter,
        continue: (continueRequest) =>
          Ref.update(continuations, (count) => count + 1).pipe(
            Effect.andThen(subject.adapter.continue(continueRequest)),
          ),
      }

      const fiber = yield* FeedbackGeneration.run({
        adapter,
        request,
        scope: SCOPE,
        tools: [tool],
        withContinuationCall,
        budget: { maxCalls: 4, maxResultTokens: 256, maxConcurrency: 2 },
      }).pipe(Effect.forkScoped)

      yield* Deferred.await(firstStarted)
      yield* Effect.yieldNow
      expect(yield* Ref.get(starts)).toBe(2)
      expect(yield* Ref.get(active)).toBe(2)
      expect(yield* Ref.get(peak)).toBe(2)

      yield* TestClock.adjust(Duration.millis(99))
      expect(yield* Ref.get(starts)).toBe(2)
      expect(yield* Ref.get(continuations)).toBe(0)
      yield* TestClock.adjust(Duration.millis(1))
      yield* Effect.yieldNow
      expect(yield* Ref.get(starts)).toBe(4)
      expect(yield* Ref.get(peak)).toBe(2)

      yield* TestClock.adjust(Duration.millis(99))
      expect(yield* Ref.get(continuations)).toBe(0)
      yield* TestClock.adjust(Duration.millis(1))
      expect((yield* Fiber.join(fiber)).text).toContain('<message>done</message>')
      expect(yield* Ref.get(active)).toBe(0)
      expect(yield* Ref.get(peak)).toBe(2)
      expect(yield* Ref.get(continuations)).toBe(1)
    }),
  ),
)

it.effect(
  'cannot continue paging when the final provider response asks for another tool call',
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const subject = yield* makeSubject([toolCalls(true), toolCalls(true)])
        const executions = yield* Ref.make(0)
        const error = yield* FeedbackGeneration.run({
          adapter: subject.adapter,
          request,
          scope: SCOPE,
          tools: [makeTool(executions)],
          withContinuationCall,
          budget: { maxCalls: 1, maxResultTokens: 64, maxConcurrency: 1 },
        }).pipe(Effect.flip)

        expect(error._tag).toBe('AdapterProtocolViolationError')
        expect(yield* Ref.get(executions)).toBe(1)
        const starts = (yield* subject.control.events()).filter(
          (event) => event._tag === 'RequestStarted' && event.kind === 'generation',
        )
        expect(starts).toMatchObject([{ operation: 'generate' }, { operation: 'continue' }])
      }),
    ),
)
