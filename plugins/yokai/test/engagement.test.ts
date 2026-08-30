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
  AdapterId,
  AdapterModelId,
  type GenerateRequest,
  GenerationUsage,
  type YokaiAdapter,
} from 'yokai-protocol'
import { Deferred, Effect, Fiber, Queue } from 'effect'
import { Bot, Context, h, type Fragment, type Schema as KoishiSchema, Universal } from 'koishi'
import { vi } from 'vitest'

vi.mock('koishi', () => import('@koishijs/core'))

import { apply, type Config } from '../src/index'

const ADAPTER_ID = AdapterId.make('fake-engagement')
const MODEL_ID = AdapterModelId.make('model-a')
const MODEL_REFERENCE = 'fake-engagement/model-a'

const CONFIG: Config = {
  model: MODEL_REFERENCE,
  feedbackToolsEnabled: false,
  engagement: {
    enabled: true,
    idleTtlMs: 5_000,
    maxDurationMs: 30_000,
    maxRounds: 2,
  },
  wake: {
    directDebounceMs: 100,
    activityThreshold: 1_000,
    relevanceThreshold: 1_000,
  },
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

const makeHarness = Effect.fn('EngagementTest.makeHarness')(function* (
  generationSteps: ReadonlyArray<AdapterGenerationStepType>,
  config: Config = CONFIG,
) {
  const ctx = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const context = new Context()
      context.plugin(SQLiteDriver, { path: ':memory:' })
      apply(context, config)
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
      tokenNamespace: 'yk025',
    },
    AdapterConformanceSetup.make({ discoverySteps: [discovery], generationSteps }),
  )
  yield* Effect.promise(() => ctx.yokai.registerAdapter(observeAdapter(subject, requests)))
  yield* Deferred.await(modelReady)

  return { ctx, bot, subject, requests, sentMessages } satisfies Harness
})

interface DispatchOptions {
  readonly userId?: string
  readonly replyToSelf?: boolean
}

const dispatchMessage = Effect.fn('EngagementTest.dispatchMessage')(function* (
  harness: Harness,
  messageId: string,
  content: string,
  options: DispatchOptions = {},
) {
  const completed = yield* Deferred.make<void>()
  const removeListener = harness.ctx.on('middleware', (session) => {
    if (session.messageId === messageId) {
      Effect.runSync(Deferred.succeed(completed, undefined))
    }
  })
  const session = harness.bot.session({
    user: { id: options.userId === undefined ? 'alice' : options.userId, name: 'User' },
    channel: { id: 'channel', type: Universal.Channel.Type.TEXT },
    guild: { id: 'guild' },
    timestamp: 1_777_000_000_000,
  })
  session.type = 'message'
  session.messageId = messageId
  session.content = content
  if (options.replyToSelf === true) {
    session.quote = { id: 'yokai-message', user: { id: 'bot' }, content: 'previous reply' }
  }
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

it.effect('continues only for lease participants and consumes one round per merged burst', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        textGeneration('<output><message>initial</message></output>'),
        textGeneration('<output><message>merged follow-up</message></output>'),
        textGeneration('<output><message>last follow-up</message></output>'),
      ])

      yield* dispatchMessage(harness, 'initial', `${h.at('bot').toString()} engagement topic`)
      yield* Queue.take(harness.requests)
      expect(yield* Queue.take(harness.sentMessages)).toBe('initial')

      yield* dispatchMessage(harness, 'outsider', 'I was not invited', { userId: 'bob' })
      expect(yield* Queue.size(harness.requests)).toBe(0)
      expect(yield* Queue.size(harness.sentMessages)).toBe(0)

      const first = yield* dispatchMessage(harness, 'burst-1', 'engagement first follow-up').pipe(
        Effect.forkScoped,
      )
      const second = yield* dispatchMessage(harness, 'burst-2', 'engagement second follow-up').pipe(
        Effect.forkScoped,
      )
      yield* Fiber.join(first)
      yield* Fiber.join(second)

      const merged = yield* Queue.take(harness.requests)
      const mergedContext = [
        merged.systemInstruction,
        ...merged.messages.map((message) => message.content),
      ].join('\n')
      expect(mergedContext).toContain('engagement first follow-up')
      expect(mergedContext).toContain('engagement second follow-up')
      expect(mergedContext).not.toContain('remainingRounds')
      expect(mergedContext).not.toContain('absoluteExpiresAt')
      expect(mergedContext).not.toContain('<engagement')
      expect(yield* Queue.take(harness.sentMessages)).toBe('merged follow-up')
      expect(yield* Queue.size(harness.requests)).toBe(0)

      yield* dispatchMessage(harness, 'last', 'engagement one more follow-up')
      yield* Queue.take(harness.requests)
      expect(yield* Queue.take(harness.sentMessages)).toBe('last follow-up')

      yield* dispatchMessage(harness, 'exhausted', 'engagement must return to ordinary gating')
      expect(yield* Queue.size(harness.requests)).toBe(0)
      expect(yield* Queue.size(harness.sentMessages)).toBe(0)
      expect(yield* generationStarts(harness.subject)).toHaveLength(3)
    }),
  ),
)

it.effect('does not open a continuation lease when the @ hard reply switch is disabled', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [textGeneration('<output><message>must not send</message></output>')],
        {
          ...CONFIG,
          wake: {
            directDebounceMs: 100,
            hardReplyAtMention: false,
            activityThreshold: 1_000,
            relevanceThreshold: 1_000,
          },
        },
      )

      yield* dispatchMessage(harness, 'disabled-anchor', `${h.at('bot').toString()} no lease`)
      yield* dispatchMessage(harness, 'disabled-follow-up', 'this must remain ordinary')

      expect(yield* Queue.size(harness.requests)).toBe(0)
      expect(yield* Queue.size(harness.sentMessages)).toBe(0)
      expect(yield* generationStarts(harness.subject)).toHaveLength(0)
    }),
  ),
)

it.effect('does not open a continuation lease when reply-to-self hard replies are disabled', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [textGeneration('<output><message>must not send</message></output>')],
        {
          ...CONFIG,
          wake: {
            directDebounceMs: 100,
            hardReplyOnReplyToSelf: false,
            activityThreshold: 1_000,
            relevanceThreshold: 1_000,
          },
        },
      )

      yield* dispatchMessage(harness, 'disabled-reply-anchor', 'no reply lease', {
        replyToSelf: true,
      })
      yield* dispatchMessage(harness, 'disabled-reply-follow-up', 'this must remain ordinary')

      expect(yield* Queue.size(harness.requests)).toBe(0)
      expect(yield* Queue.size(harness.sentMessages)).toBe(0)
      expect(yield* generationStarts(harness.subject)).toHaveLength(0)
    }),
  ),
)

it.effect('treats a disabled reply-to-self hard match as an existing lease continuation', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [
          textGeneration('<output><message>mention opened</message></output>'),
          textGeneration('<output><message>reply continued</message></output>'),
        ],
        {
          ...CONFIG,
          engagement: {
            enabled: true,
            idleTtlMs: 5_000,
            maxDurationMs: 30_000,
            maxRounds: 1,
          },
          wake: {
            directDebounceMs: 100,
            hardReplyOnReplyToSelf: false,
            activityThreshold: 1_000,
            relevanceThreshold: 1_000,
          },
        },
      )

      yield* dispatchMessage(harness, 'mention-anchor', `${h.at('bot').toString()} lease topic`)
      yield* Queue.take(harness.requests)
      expect(yield* Queue.take(harness.sentMessages)).toBe('mention opened')

      yield* dispatchMessage(harness, 'soft-reply-continuation', 'continue in the lease', {
        replyToSelf: true,
      })
      yield* Queue.take(harness.requests)
      expect(yield* Queue.take(harness.sentMessages)).toBe('reply continued')

      yield* dispatchMessage(harness, 'lease-exhausted', 'ordinary gating again')
      expect(yield* Queue.size(harness.requests)).toBe(0)
      expect(yield* Queue.size(harness.sentMessages)).toBe(0)
      expect(yield* generationStarts(harness.subject)).toHaveLength(2)
    }),
  ),
)

it.effect("opens the same bounded continuation after a reply to the bot's own message", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [
          textGeneration('<output><message>reply opened</message></output>'),
          textGeneration('<output><message>reply continued</message></output>'),
        ],
        {
          ...CONFIG,
          engagement: {
            enabled: true,
            idleTtlMs: 5_000,
            maxDurationMs: 30_000,
            maxRounds: 1,
          },
        },
      )

      yield* dispatchMessage(harness, 'reply-open', 'continue from that', { replyToSelf: true })
      yield* Queue.take(harness.requests)
      expect(yield* Queue.take(harness.sentMessages)).toBe('reply opened')

      yield* dispatchMessage(harness, 'reply-follow-up', 'and this part too')
      yield* Queue.take(harness.requests)
      expect(yield* Queue.take(harness.sentMessages)).toBe('reply continued')
      expect(yield* generationStarts(harness.subject)).toHaveLength(2)
    }),
  ),
)
