import { expect, it } from '@effect/vitest'
import {
  AdapterConformanceSetup,
  AdapterDiscoveryStep,
  AdapterGenerationStep,
  type AdapterGenerationStep as AdapterGenerationStepType,
} from '@yokai/adapter-conformance'
import { makeFakeAdapter, type FakeAdapterSubject } from '@yokai/adapter-conformance/fake'
import {
  AdapterId,
  AdapterModelId,
  type GenerateRequest,
  GenerationUsage,
  type YokaiAdapter,
} from '@yokai/protocol'
import { Deferred, Effect, Queue } from 'effect'
import { Bot, Context, h, type Fragment, type Schema as KoishiSchema, Universal } from 'koishi'
import { vi } from 'vitest'

vi.mock('koishi', () => import('@koishijs/core'))

import { apply, type Config } from '../src/index'

const ADAPTER_ID = AdapterId.make('fake-turn')
const MODEL_ID = AdapterModelId.make('model-a')
const MODEL_REFERENCE = 'fake-turn/model-a'

const CONFIG: Config = {
  model: MODEL_REFERENCE,
  feedbackToolsEnabled: false,
}

const discovery = AdapterDiscoveryStep.cases.Success.make({
  discoveredAt: '2026-08-24T00:00:00.000Z',
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

const transportFailure = AdapterGenerationStep.cases.Failure.make({
  failure: {
    category: 'transport',
    providerMessage: 'provider protocol text must stay private',
  },
  blocked: false,
})

class TestBot extends Bot<Context, {}> {
  constructor(
    ctx: Context,
    private readonly sentMessages: Queue.Queue<string>,
  ) {
    super(ctx, {}, 'test')
    this.user = { id: 'bot' }
  }

  override sendMessage(_channelId: string, content: Fragment): Promise<string[]> {
    const text = h.normalize(content).join('')
    return Effect.runPromise(Queue.offer(this.sentMessages, text).pipe(Effect.as(['sent-message'])))
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
  readonly sentMessages: Queue.Queue<string>
}

const schemaOption = (schema: KoishiSchema, value: string): KoishiSchema | undefined => {
  const list = schema.list
  return list === undefined ? undefined : list.find((option) => option.value === value)
}

const observeAdapter = (
  subject: FakeAdapterSubject,
  requests: Queue.Queue<GenerateRequest>,
): YokaiAdapter => ({
  descriptor: subject.adapter.descriptor,
  discoverModels: subject.adapter.discoverModels,
  generate: (request) =>
    Queue.offer(requests, request).pipe(Effect.andThen(subject.adapter.generate(request))),
  continue: subject.adapter.continue,
})

const makeHarness = Effect.fn('DirectMentionTest.makeHarness')(function* (
  generationSteps: ReadonlyArray<AdapterGenerationStepType>,
) {
  const ctx = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const context = new Context()
      apply(context, CONFIG)
      return context
    }),
    (context) => Effect.promise(() => context.stop()),
  )
  yield* Effect.promise(() => ctx.start())

  const requests = yield* Queue.unbounded<GenerateRequest>()
  const sentMessages = yield* Queue.unbounded<string>()
  const bot = new TestBot(ctx, sentMessages)
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
      tokenNamespace: 'yk012',
    },
    AdapterConformanceSetup.make({ discoverySteps: [discovery], generationSteps }),
  )
  yield* Effect.promise(() => ctx.yokai.registerAdapter(observeAdapter(subject, requests)))
  yield* Deferred.await(modelReady)

  return { ctx, bot, subject, requests, sentMessages } satisfies Harness
})

const dispatchMessage = Effect.fn('DirectMentionTest.dispatchMessage')(function* (
  harness: Harness,
  messageId: string,
  content: string,
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
  session.content = content
  harness.bot.dispatch(session)
  yield* Deferred.await(completed)
  yield* Effect.sync(() => removeListener())
  return session
})

const generationStarts = (subject: FakeAdapterSubject) =>
  subject.control
    .events()
    .pipe(
      Effect.map((events) =>
        events.filter((event) => event._tag === 'RequestStarted' && event.kind === 'generation'),
      ),
    )

it.effect('turns one direct mention into one generic generation and one group message', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        textGeneration(
          '<yokai-response version="1"><decision action="reply"><message>三点见</message></decision></yokai-response>',
        ),
      ])
      yield* dispatchMessage(harness, 'message-reply', h.at('bot').toString() + '  下午三点可以吗')

      const request = yield* Queue.take(harness.requests)
      expect(request.modelId).toBe(MODEL_ID)
      expect(request.messages).toEqual([{ role: 'user', content: '下午三点可以吗' }])
      expect(request.feedbackTools).toEqual([])
      expect(yield* Queue.take(harness.sentMessages)).toBe('三点见')
      expect(yield* Queue.size(harness.sentMessages)).toBe(0)
      expect(yield* generationStarts(harness.subject)).toHaveLength(1)
    }),
  ),
)

it.effect('sends decoded XML message content as text instead of Koishi elements', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        textGeneration(
          '<yokai-response version="1"><decision action="reply"><message>&lt;at id=&quot;victim&quot;/&gt;</message></decision></yokai-response>',
        ),
      ])
      yield* dispatchMessage(harness, 'message-text', h.at('bot').toString() + ' 叫一下他')

      expect(yield* Queue.take(harness.sentMessages)).toBe('&lt;at id="victim"/&gt;')
      expect(yield* Queue.size(harness.sentMessages)).toBe(0)
    }),
  ),
)

it.effect('does not invoke the model for a message without a direct mention', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        textGeneration(
          '<yokai-response version="1"><decision action="reply"><message>must not send</message></decision></yokai-response>',
        ),
      ])
      yield* dispatchMessage(harness, 'message-ordinary', '大家下午三点可以吗')

      expect(yield* Queue.size(harness.requests)).toBe(0)
      expect(yield* Queue.size(harness.sentMessages)).toBe(0)
      expect(yield* generationStarts(harness.subject)).toHaveLength(0)
    }),
  ),
)

it.effect('keeps silence and malformed XML out of group chat', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        textGeneration(
          '<yokai-response version="1"><decision action="silence"></decision></yokai-response>',
        ),
        textGeneration('<yokai-response>protocol leak</yokai-response>'),
      ])
      yield* dispatchMessage(harness, 'message-silence', h.at('bot').toString() + ' 在吗')
      yield* dispatchMessage(harness, 'message-malformed', h.at('bot').toString() + ' 回一下')

      expect(yield* Queue.size(harness.sentMessages)).toBe(0)
      expect(yield* generationStarts(harness.subject)).toHaveLength(2)
    }),
  ),
)

it.effect('keeps adapter failures and provider text out of group chat', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness([transportFailure])
      yield* dispatchMessage(harness, 'message-failure', h.at('bot').toString() + ' 回一下')

      expect(yield* Queue.size(harness.sentMessages)).toBe(0)
      expect(yield* generationStarts(harness.subject)).toHaveLength(1)
    }),
  ),
)
