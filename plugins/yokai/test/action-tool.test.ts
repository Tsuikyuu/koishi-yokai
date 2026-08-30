import { SQLiteDriver } from '@minatojs/driver-sqlite'
import { expect, it } from '@effect/vitest'
import {
  AdapterConformanceSetup,
  AdapterDiscoveryStep,
  AdapterGenerationStep,
  type AdapterGenerationStep as AdapterGenerationStepType,
} from 'yokai-adapter-conformance'
import { makeFakeAdapter, type FakeAdapterSubject } from 'yokai-adapter-conformance/fake'
import {
  ActionTool,
  ActionToolExecutionError,
  ActionToolId,
  ActionToolXmlTemplate,
  AdapterId,
  AdapterModelId,
  CapabilityDurationMilliseconds,
  CapabilityProtocolVersion,
  type ActionToolCompletionPolicy,
  type ActionToolExecute,
  type ActionToolExecutionStage,
  type ActionToolFailurePolicy,
  type ActionToolRequest,
  type GenerateRequest,
  GenerationUsage,
  type YokaiAdapter,
} from 'yokai-protocol'
import { Deferred, Effect, Queue } from 'effect'
import { Bot, Context, h, type Fragment, type Schema as KoishiSchema, Universal } from 'koishi'
import { vi } from 'vitest'

vi.mock('koishi', () => import('@koishijs/core'))

import { apply, type Config } from '../src/index'

const ADAPTER_ID = AdapterId.make('action-test')
const MODEL_ID = AdapterModelId.make('model-a')
const MODEL_REFERENCE = 'action-test/model-a'
const CAPABILITY_VERSION = CapabilityProtocolVersion.make({ major: 0, minor: 1 })

const CONFIG: Config = {
  model: MODEL_REFERENCE,
  feedbackToolsEnabled: false,
  wake: { directDebounceMs: 100, cooldownMs: 0 },
}

const discovery = AdapterDiscoveryStep.cases.Success.make({
  discoveredAt: '2026-08-30T00:00:00.000Z',
  models: [
    {
      id: MODEL_ID,
      displayName: 'Model A',
      availability: 'available',
      discoveryFreshness: 'fresh',
    },
  ],
  blocked: false,
})

const textGeneration = (text: string): AdapterGenerationStepType =>
  AdapterGenerationStep.cases.Text.make({
    result: {
      _tag: 'Text',
      text,
      finishReason: 'stop',
      usage: GenerationUsage.cases.Unavailable.make({}),
    },
    blocked: false,
  })

class TestBot extends Bot<Context, {}> {
  constructor(
    ctx: Context,
    private readonly sentMessages: Queue.Queue<string>,
    private readonly lifecycle: Queue.Queue<string>,
  ) {
    super(ctx, {}, 'test')
    this.user = { id: 'bot' }
  }

  override sendMessage(_channelId: string, content: Fragment): Promise<string[]> {
    const text = h.normalize(content).join('')
    return Effect.runPromise(
      Queue.offer(this.sentMessages, text).pipe(
        Effect.andThen(Queue.offer(this.lifecycle, `send:${text}`)),
        Effect.as(['sent-message']),
      ),
    )
  }

  override dispose(): Promise<void> {
    return Promise.resolve()
  }
}

interface Harness {
  readonly ctx: Context
  readonly bot: TestBot
  readonly subject: FakeAdapterSubject
  readonly requests: Queue.Queue<GenerateRequest>
  readonly completedRequests: Queue.Queue<GenerateRequest>
  readonly sentMessages: Queue.Queue<string>
  readonly lifecycle: Queue.Queue<string>
}

interface ObservedAction {
  readonly stage: ActionToolExecutionStage
  readonly request: ActionToolRequest
}

const schemaOption = (schema: KoishiSchema, value: string): KoishiSchema | undefined => {
  const list = schema.list
  return list === undefined ? undefined : list.find((option) => option.value === value)
}

const observeAdapter = (
  subject: FakeAdapterSubject,
  requests: Queue.Queue<GenerateRequest>,
  completedRequests: Queue.Queue<GenerateRequest>,
): YokaiAdapter => ({
  descriptor: subject.adapter.descriptor,
  discoverModels: subject.adapter.discoverModels,
  generate: (request) =>
    Queue.offer(requests, request).pipe(
      Effect.andThen(subject.adapter.generate(request)),
      Effect.tap(() => Queue.offer(completedRequests, request)),
    ),
  continue: subject.adapter.continue,
})

const makeHarness = Effect.fn('ActionToolTest.makeHarness')(function* (
  generationSteps: ReadonlyArray<AdapterGenerationStepType>,
) {
  const ctx = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const context = new Context()
      context.plugin(SQLiteDriver, { path: ':memory:' })
      apply(context, CONFIG)
      return context
    }),
    (context) => Effect.promise(() => context.stop()),
  )
  yield* Effect.promise(() => ctx.start())

  const requests = yield* Queue.unbounded<GenerateRequest>()
  const completedRequests = yield* Queue.unbounded<GenerateRequest>()
  const sentMessages = yield* Queue.unbounded<string>()
  const lifecycle = yield* Queue.unbounded<string>()
  const bot = new TestBot(ctx, sentMessages, lifecycle)
  const modelReady = yield* Deferred.make<void>()
  ctx.on('internal/schema', (name) => {
    if (name !== 'yokai-model') return
    const option = schemaOption(ctx.schema.get(name), MODEL_REFERENCE)
    if (option !== undefined && option.meta.disabled !== true) {
      Effect.runSync(Deferred.succeed(modelReady, undefined))
    }
  })

  const subject = yield* makeFakeAdapter(
    {
      adapterId: ADAPTER_ID,
      feedbackTools: false,
      tokenNamespace: 'action-tool-test',
    },
    AdapterConformanceSetup.make({ discoverySteps: [discovery], generationSteps }),
  )
  yield* Effect.promise(() =>
    ctx.yokai.registerAdapter(observeAdapter(subject, requests, completedRequests)),
  )
  yield* Deferred.await(modelReady)

  return {
    ctx,
    bot,
    subject,
    requests,
    completedRequests,
    sentMessages,
    lifecycle,
  } satisfies Harness
})

const dispatchDirectMention = Effect.fn('ActionToolTest.dispatchDirectMention')(function* (
  harness: Harness,
  messageId: string,
) {
  const completed = yield* Deferred.make<void>()
  const removeListener = harness.ctx.on('middleware', (session) => {
    if (session.messageId === messageId) {
      Effect.runSync(Deferred.succeed(completed, undefined))
    }
  })
  const session = harness.bot.session({
    user: { id: 'user', name: 'User' },
    channel: { id: 'channel', type: Universal.Channel.Type.TEXT },
    guild: { id: 'guild' },
    timestamp: 1_777_000_000_000,
  })
  session.type = 'message'
  session.messageId = messageId
  session.content = h.at('bot').toString() + ' run actions'
  harness.bot.dispatch(session)
  yield* Deferred.await(completed)
  yield* Effect.sync(() => removeListener())
})

const generationStarts = (subject: FakeAdapterSubject) =>
  subject.control
    .events()
    .pipe(
      Effect.map((events) =>
        events.filter((event) => event._tag === 'RequestStarted' && event.kind === 'generation'),
      ),
    )

const makeTool = (
  id: string,
  executionStage: ActionToolExecutionStage,
  completionPolicy: ActionToolCompletionPolicy,
  failurePolicy: ActionToolFailurePolicy,
  execute: ActionToolExecute,
): ActionTool =>
  ActionTool.make({
    id: ActionToolId.make(id),
    protocolVersion: CAPABILITY_VERSION,
    description: `Observe ${id}`,
    xmlTemplate: ActionToolXmlTemplate.make(`<action tool="${id}"><count>INTEGER</count></action>`),
    inputSchema: {
      _tag: 'Object',
      properties: [
        {
          name: 'count',
          required: true,
          schema: { _tag: 'Integer', description: 'Observed count.' },
        },
      ],
    },
    executionStage,
    completionPolicy,
    failurePolicy,
    maxDurationMs: CapabilityDurationMilliseconds.make(1_000),
    isAvailable: () => true,
    isInputAllowed: () => true,
    execute,
  })

const observeAction =
  (
    stage: ActionToolExecutionStage,
    observed: Queue.Queue<ObservedAction>,
    lifecycle: Queue.Queue<string>,
  ): ActionToolExecute =>
  (request) =>
    Queue.offer(observed, { stage, request }).pipe(
      Effect.andThen(Queue.offer(lifecycle, stage)),
      Effect.asVoid,
    )

it.effect(
  'executes decoded before-send, after-send, and deferred actions through the public host',
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness([
          textGeneration(`<output><message>action reply</message><actions>
          <action tool="test.before"><count>1</count></action>
          <action tool="test.after"><count>2</count></action>
          <action tool="test.deferred"><count>3</count></action>
        </actions></output>`),
        ])
        const observed = yield* Queue.unbounded<ObservedAction>()
        yield* Effect.promise(() =>
          harness.ctx.yokai.registerActionTool(
            makeTool(
              'test.before',
              'before-send',
              'none',
              'continue',
              observeAction('before-send', observed, harness.lifecycle),
            ),
          ),
        )
        yield* Effect.promise(() =>
          harness.ctx.yokai.registerActionTool(
            makeTool(
              'test.after',
              'after-send',
              'none',
              'continue',
              observeAction('after-send', observed, harness.lifecycle),
            ),
          ),
        )
        yield* Effect.promise(() =>
          harness.ctx.yokai.registerActionTool(
            makeTool(
              'test.deferred',
              'deferred',
              'none',
              'continue',
              observeAction('deferred', observed, harness.lifecycle),
            ),
          ),
        )

        yield* dispatchDirectMention(harness, 'actions-success')
        const generationRequest = yield* Queue.take(harness.requests)
        const observations = yield* Effect.forEach([0, 1, 2], () => Queue.take(observed))
        const lifecycle = yield* Effect.forEach([0, 1, 2, 3], () => Queue.take(harness.lifecycle))

        expect(generationRequest.systemInstruction).toContain('test.before')
        expect(generationRequest.systemInstruction).toContain('test.after')
        expect(generationRequest.systemInstruction).toContain('test.deferred')
        expect(yield* Queue.take(harness.sentMessages)).toBe('action reply')
        expect(
          observations.map(({ stage, request }) => ({
            stage,
            input: request.input,
            scope: request.scope,
          })),
        ).toEqual(
          expect.arrayContaining([
            {
              stage: 'before-send',
              input: { count: 1 },
              scope: {
                instanceId: 'default',
                platform: 'test',
                guildId: 'guild',
                channelId: 'channel',
              },
            },
            {
              stage: 'after-send',
              input: { count: 2 },
              scope: {
                instanceId: 'default',
                platform: 'test',
                guildId: 'guild',
                channelId: 'channel',
              },
            },
            {
              stage: 'deferred',
              input: { count: 3 },
              scope: {
                instanceId: 'default',
                platform: 'test',
                guildId: 'guild',
                channelId: 'channel',
              },
            },
          ]),
        )
        expect(lifecycle.indexOf('before-send')).toBeLessThan(
          lifecycle.indexOf('send:action reply'),
        )
        expect(lifecycle.indexOf('after-send')).toBeGreaterThan(
          lifecycle.indexOf('send:action reply'),
        )
        expect(yield* Queue.size(harness.requests)).toBe(0)
        expect(yield* generationStarts(harness.subject)).toHaveLength(1)
      }),
    ),
)

it.effect('keeps a failed block-reply action silent', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        textGeneration(
          '<output><message>must not send</message><actions><action tool="test.block"><count>4</count></action></actions></output>',
        ),
      ])
      const observed = yield* Queue.unbounded<ObservedAction>()
      const toolId = ActionToolId.make('test.block')
      yield* Effect.promise(() =>
        harness.ctx.yokai.registerActionTool(
          makeTool('test.block', 'before-send', 'none', 'block-reply', (request) =>
            Queue.offer(observed, { stage: 'before-send', request }).pipe(
              Effect.andThen(
                Effect.fail(new ActionToolExecutionError({ toolId, reason: 'execution-failed' })),
              ),
            ),
          ),
        ),
      )

      yield* dispatchDirectMention(harness, 'actions-blocked')
      yield* Queue.take(harness.requests)
      const execution = yield* Queue.take(observed)

      expect(execution.request.input).toEqual({ count: 4 })
      expect(execution.request.scope).toEqual({
        instanceId: 'default',
        platform: 'test',
        guildId: 'guild',
        channelId: 'channel',
      })
      expect(yield* Queue.size(harness.sentMessages)).toBe(0)
      expect(yield* generationStarts(harness.subject)).toHaveLength(1)
    }),
  ),
)

it.effect('coalesces successful deferred wake actions into one completion turn', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        textGeneration(`<output><actions>
          <action tool="test.deferred-first"><count>5</count></action>
          <action tool="test.deferred-second"><count>6</count></action>
        </actions></output>`),
        textGeneration('<output></output>'),
      ])
      const observed = yield* Queue.unbounded<ObservedAction>()
      yield* Effect.promise(() =>
        harness.ctx.yokai.registerActionTool(
          makeTool(
            'test.deferred-first',
            'deferred',
            'wake',
            'continue',
            observeAction('deferred', observed, harness.lifecycle),
          ),
        ),
      )
      yield* Effect.promise(() =>
        harness.ctx.yokai.registerActionTool(
          makeTool(
            'test.deferred-second',
            'deferred',
            'wake',
            'continue',
            observeAction('deferred', observed, harness.lifecycle),
          ),
        ),
      )

      yield* dispatchDirectMention(harness, 'actions-deferred')
      yield* Queue.take(harness.requests)
      yield* Queue.take(harness.completedRequests)
      const deferredExecutions = yield* Effect.forEach([0, 1], () => Queue.take(observed))
      yield* Queue.take(harness.requests)
      yield* Queue.take(harness.completedRequests)

      expect(deferredExecutions.map((execution) => execution.request.input)).toEqual(
        expect.arrayContaining([{ count: 5 }, { count: 6 }]),
      )
      expect(yield* generationStarts(harness.subject)).toHaveLength(2)
      expect(yield* Queue.size(harness.requests)).toBe(0)
      expect(yield* Queue.size(harness.sentMessages)).toBe(0)
    }),
  ),
)

it.effect('bounds visible ActionTools without silencing a turn', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        textGeneration('<output><message>bounded tools</message></output>'),
      ])
      const toolIds = Array.from(
        { length: 17 },
        (_, index) => `test.limit-${index.toString().padStart(2, '0')}`,
      )
      yield* Effect.forEach(toolIds, (toolId) =>
        Effect.promise(() =>
          harness.ctx.yokai.registerActionTool(
            makeTool(toolId, 'before-send', 'none', 'continue', () => Effect.succeed(undefined)),
          ),
        ),
      )

      yield* dispatchDirectMention(harness, 'actions-visible-limit')
      const request = yield* Queue.take(harness.requests)

      expect(request.systemInstruction).toContain('test.limit-00')
      expect(request.systemInstruction).toContain('test.limit-15')
      expect(request.systemInstruction).not.toContain('test.limit-16')
      expect(yield* Queue.take(harness.sentMessages)).toBe('bounded tools')
      expect(yield* generationStarts(harness.subject)).toHaveLength(1)
    }),
  ),
)

it.effect('runs after-send actions after a successful silent send phase', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        textGeneration(
          '<output><actions><action tool="test.silent-after"><count>7</count></action></actions></output>',
        ),
      ])
      const observed = yield* Queue.unbounded<ObservedAction>()
      yield* Effect.promise(() =>
        harness.ctx.yokai.registerActionTool(
          makeTool(
            'test.silent-after',
            'after-send',
            'none',
            'continue',
            observeAction('after-send', observed, harness.lifecycle),
          ),
        ),
      )

      yield* dispatchDirectMention(harness, 'actions-silent-after')
      yield* Queue.take(harness.requests)
      const execution = yield* Queue.take(observed)

      expect(execution.request.input).toEqual({ count: 7 })
      expect(yield* Queue.size(harness.sentMessages)).toBe(0)
      expect(yield* generationStarts(harness.subject)).toHaveLength(1)
    }),
  ),
)
