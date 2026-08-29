import { expect, it } from '@effect/vitest'
import { AdapterConformanceSetup, AdapterGenerationStep } from 'yokai-adapter-conformance'
import { makeFakeAdapter } from 'yokai-adapter-conformance/fake'
import {
  AdapterId,
  AdapterModelId,
  CapabilityProtocolVersion,
  CapabilityScope,
  FeedbackTool,
  FeedbackToolId,
  FeedbackToolValidationError,
  GenerateRequest,
  GenerationUsage,
  TokenLimit,
  ToolCallId,
  UserMessage,
  type ContinueRequest,
  type YokaiAdapter,
} from 'yokai-protocol'
import { Effect, Ref } from 'effect'

import { FeedbackGeneration } from '../../src/index'

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
    usage: GenerationUsage.cases.Unavailable.make({}),
  },
  blocked: false,
})

const toolCalls = (...validInputs: ReadonlyArray<boolean>) =>
  AdapterGenerationStep.cases.ToolCalls.make({
    calls: validInputs.map((valid, index) => ({
      callId: ToolCallId.make(`call-${index}`),
      toolId: TOOL_ID,
      input: { valid },
    })),
    usage: GenerationUsage.cases.Unavailable.make({}),
    blocked: false,
  })

const makeTool = (executions: Ref.Ref<number>): FeedbackTool =>
  FeedbackTool.make({
    id: TOOL_ID,
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
    maxResultTokens: TokenLimit.make(64),
    prepare: (toolRequest) =>
      toolRequest.input.valid === true
        ? Effect.succeed({
            execute: () =>
              Ref.update(executions, (count) => count + 1).pipe(
                Effect.as({ messages: ['bounded history result'] }),
              ),
          })
        : Effect.fail(
            new FeedbackToolValidationError({ toolId: TOOL_ID, reason: 'invalid-input' }),
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
        budget: { maxCalls: 1, maxResultTokens: 64 },
      })
      expect(result.text).toContain('<message>done</message>')
      expect(yield* Ref.get(executions)).toBe(1)

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
        budget: { maxCalls: 2, maxResultTokens: 128 },
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
          budget: { maxCalls: 1, maxResultTokens: 64 },
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
