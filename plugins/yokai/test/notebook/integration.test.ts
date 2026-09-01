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
  ActionToolId,
  ActionToolXmlTemplate,
  AdapterId,
  AdapterModelId,
  CapabilityDurationMilliseconds,
  CapabilityProtocolVersion,
  type ActionToolRequest,
  type GenerateRequest,
  GenerationUsage,
  type YokaiAdapter,
} from 'yokai-protocol'
import { Deferred, Effect, Fiber, Queue } from 'effect'
import { Bot, Context, h, type Fragment, type Schema as KoishiSchema, Universal } from 'koishi'
import { vi } from 'vitest'

vi.mock('koishi', () => import('@koishijs/core'))

import { apply, type Config } from '../../src/index'
import { DEFAULT_VISIBLE_ACTION_TOOLS } from '../../src/config'
import type { YokaiMemoryRow } from '../../src/notebook/model'

const ADAPTER_ID = AdapterId.make('notebook-integration')
const MODEL_ID = AdapterModelId.make('model-a')
const MODEL_REFERENCE = 'notebook-integration/model-a'
const CAPABILITY_VERSION = CapabilityProtocolVersion.make({ major: 0, minor: 1 })
const BASE_TIMESTAMP = 1_777_000_000_000

const CONFIG: Config = {
  model: MODEL_REFERENCE,
  feedbackToolsEnabled: false,
  capabilities: {
    actionTools: [...DEFAULT_VISIBLE_ACTION_TOOLS, 'test.silent-after'],
  },
  notebook: { maxNotesPerReply: 4, recallLimit: 8 },
  wake: {
    directDebounceMs: 100,
    cooldownMs: 0,
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

type SendDirective = 'success' | 'failure'

class TestBot extends Bot<Context, {}> {
  constructor(
    ctx: Context,
    private readonly sendAttempts: Queue.Queue<string>,
    private readonly sendDirectives: Queue.Queue<SendDirective>,
    private readonly sentMessages: Queue.Queue<string>,
  ) {
    super(ctx, {}, 'test')
    this.user = { id: 'bot' }
  }

  override sendMessage(_channelId: string, content: Fragment): Promise<string[]> {
    const text = h.normalize(content).join('')
    return Effect.runPromise(
      Queue.offer(this.sendAttempts, text).pipe(
        Effect.andThen(Queue.take(this.sendDirectives)),
        Effect.flatMap((directive) =>
          directive === 'failure'
            ? Effect.fail(new Error('controlled send failure'))
            : Queue.offer(this.sentMessages, text).pipe(Effect.as(['sent-message'])),
        ),
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
  readonly sendAttempts: Queue.Queue<string>
  readonly sendDirectives: Queue.Queue<SendDirective>
  readonly sentMessages: Queue.Queue<string>
}

interface DispatchOptions {
  readonly channelId?: string
  readonly guildId?: string
  readonly userId?: string
  readonly timestamp?: number
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

const makeHarness = Effect.fn('NotebookIntegrationTest.makeHarness')(function* (
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
  const sendAttempts = yield* Queue.unbounded<string>()
  const sendDirectives = yield* Queue.unbounded<SendDirective>()
  const sentMessages = yield* Queue.unbounded<string>()
  const bot = new TestBot(ctx, sendAttempts, sendDirectives, sentMessages)
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
      tokenNamespace: 'notebook-integration-test',
    },
    AdapterConformanceSetup.make({ discoverySteps: [discovery], generationSteps }),
  )
  yield* Effect.promise(() => ctx.yokai.registerAdapter(observeAdapter(subject, requests)))
  yield* Deferred.await(modelReady)

  return {
    ctx,
    bot,
    subject,
    requests,
    sendAttempts,
    sendDirectives,
    sentMessages,
  } satisfies Harness
})

const dispatchMessage = Effect.fn('NotebookIntegrationTest.dispatchMessage')(function* (
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
    user: {
      id: options.userId === undefined ? 'user' : options.userId,
      name: options.userId === undefined ? 'User' : options.userId,
    },
    channel: {
      id: options.channelId === undefined ? 'channel' : options.channelId,
      type: Universal.Channel.Type.TEXT,
    },
    guild: { id: options.guildId === undefined ? 'guild' : options.guildId },
    timestamp: options.timestamp === undefined ? BASE_TIMESTAMP : options.timestamp,
  })
  session.type = 'message'
  session.messageId = messageId
  session.content = content
  harness.bot.dispatch(session)
  yield* Deferred.await(completed)
  yield* Effect.sync(() => removeListener())
})

const directMention = (content: string): string => h.at('bot').toString() + ` ${content}`

const memoryRows = (ctx: Context): Effect.Effect<ReadonlyArray<YokaiMemoryRow>> =>
  Effect.promise(() => ctx.database.get('yokai_memory', {}))

const waitForMemoryCount: (
  ctx: Context,
  expected: number,
  attempts: number,
) => Effect.Effect<ReadonlyArray<YokaiMemoryRow>> = Effect.fn(
  'NotebookIntegrationTest.waitForMemoryCount',
)(function* (ctx: Context, expected: number, attempts: number) {
  const rows = yield* memoryRows(ctx)
  if (rows.length === expected) return rows
  if (attempts === 0) {
    return yield* Effect.die(`Expected ${expected} notebook rows, received ${rows.length}`)
  }
  yield* Effect.yieldNow
  return yield* waitForMemoryCount(ctx, expected, attempts - 1)
})

const generationStarts = (subject: FakeAdapterSubject) =>
  subject.control
    .events()
    .pipe(
      Effect.map((events) =>
        events.filter((event) => event._tag === 'RequestStarted' && event.kind === 'generation'),
      ),
    )

const afterSendTool = (observed: Queue.Queue<ActionToolRequest>): ActionTool =>
  ActionTool.make({
    id: ActionToolId.make('test.silent-after'),
    protocolVersion: CAPABILITY_VERSION,
    description: 'Observe ordinary after-send execution during a silent role turn.',
    xmlTemplate: ActionToolXmlTemplate.make(
      '<action tool="test.silent-after"><value>TEXT</value></action>',
    ),
    inputSchema: {
      _tag: 'Object',
      properties: [
        {
          name: 'value',
          required: true,
          schema: { _tag: 'String', description: 'Observed value.' },
        },
      ],
    },
    executionStage: 'after-send',
    completionPolicy: 'none',
    failurePolicy: 'continue',
    maxDurationMs: CapabilityDurationMilliseconds.make(1_000),
    isAvailable: () => true,
    isInputAllowed: () => true,
    execute: (request) => Queue.offer(observed, request).pipe(Effect.asVoid),
  })

it.effect(
  'writes only after every segment succeeds and recalls medium confidence as uncertain',
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness([
          textGeneration(`<output><message>记下了</message><message>周末再聊</message><actions>
          <action tool="notebook.write"><notes><item>
            <kind>fact</kind><object-id>user</object-id><content>用户周六计划去西山</content>
            <topics><item>西山</item></topics>
            <source-message-ids><item>memory-source</item></source-message-ids>
            <confidence>0.5</confidence><importance>0.8</importance>
          </item></notes></action>
        </actions></output>`),
          textGeneration('<output></output>'),
        ])

        const dispatch = yield* dispatchMessage(
          harness,
          'memory-source',
          directMention('我周六计划去西山'),
        ).pipe(Effect.forkScoped)
        const firstRequest = yield* Queue.take(harness.requests)
        expect(firstRequest.systemInstruction).toContain('ActionTool notebook.write')

        expect(yield* Queue.take(harness.sendAttempts)).toBe('记下了')
        expect(yield* memoryRows(harness.ctx)).toEqual([])
        yield* Queue.offer(harness.sendDirectives, 'success')
        expect(yield* Queue.take(harness.sentMessages)).toBe('记下了')

        expect(yield* Queue.take(harness.sendAttempts)).toBe('周末再聊')
        expect(yield* memoryRows(harness.ctx)).toEqual([])
        yield* Queue.offer(harness.sendDirectives, 'success')
        expect(yield* Queue.take(harness.sentMessages)).toBe('周末再聊')
        yield* Fiber.join(dispatch)

        const stored = yield* waitForMemoryCount(harness.ctx, 1, 200)
        const note = stored[0]
        if (note === undefined) return yield* Effect.die('Expected one stored notebook note')
        expect(note.kind).toBe('fact')
        expect(note.objectId).toBe('user')
        expect(note.content).toBe('用户周六计划去西山')
        expect(note.sourceMessageIdsJson).toBe('["memory-source"]')
        expect(note.confidence).toBe(0.5)
        expect(yield* generationStarts(harness.subject)).toHaveLength(1)
        expect(yield* Queue.size(harness.requests)).toBe(0)

        yield* Effect.forEach(
          Array.from({ length: 40 }, (_, index) => index),
          (index) =>
            dispatchMessage(harness, `memory-filler-${index}`, `填充消息 ${index}`, {
              userId: 'filler',
              timestamp: BASE_TIMESTAMP + index + 1,
            }),
          { discard: true },
        )
        expect(yield* Queue.size(harness.requests)).toBe(0)

        yield* dispatchMessage(harness, 'memory-recall', directMention('还记得西山吗'), {
          timestamp: BASE_TIMESTAMP + 100,
        })
        const recallRequest = yield* Queue.take(harness.requests)
        const recalled = recallRequest.messages.find((message) =>
          message.content.includes('[Untrusted recalled notebook notes:'),
        )
        if (recalled === undefined) return yield* Effect.die('Expected recalled notebook context')
        expect(recalled.content).toContain('用户周六计划去西山')
        expect(recalled.content).toContain('"certainty":"uncertain"')
        expect(recalled.content).not.toContain('"confidence"')
        expect(yield* generationStarts(harness.subject)).toHaveLength(2)
      }),
    ),
)

it.effect('filters notebook writes on silence while preserving ordinary after-send actions', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        textGeneration(`<output><actions>
          <action tool="notebook.write"><notes><item>
            <kind>fact</kind><content>这条沉默笔记不能写入</content>
            <source-message-ids><item>silent-source</item></source-message-ids>
          </item></notes></action>
          <action tool="test.silent-after"><value>still-runs</value></action>
        </actions></output>`),
      ])
      const observed = yield* Queue.unbounded<ActionToolRequest>()
      yield* Effect.promise(() => harness.ctx.yokai.registerActionTool(afterSendTool(observed)))

      yield* dispatchMessage(harness, 'silent-source', directMention('保持沉默'))
      const request = yield* Queue.take(observed)

      expect(request.input).toEqual({ value: 'still-runs' })
      expect(yield* memoryRows(harness.ctx)).toEqual([])
      expect(yield* Queue.size(harness.sendAttempts)).toBe(0)
      expect(yield* generationStarts(harness.subject)).toHaveLength(1)
    }),
  ),
)

it.effect('writes nothing when the second message segment fails to send', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        textGeneration(`<output><message>第一段</message><message>第二段</message><actions>
          <action tool="notebook.write"><notes><item>
            <kind>episode</kind><content>发送失败时不能留下笔记</content>
            <source-message-ids><item>failed-send-source</item></source-message-ids>
          </item></notes></action>
        </actions></output>`),
      ])

      const dispatch = yield* dispatchMessage(
        harness,
        'failed-send-source',
        directMention('测试分段发送'),
      ).pipe(Effect.forkScoped)
      yield* Queue.take(harness.requests)
      expect(yield* Queue.take(harness.sendAttempts)).toBe('第一段')
      yield* Queue.offer(harness.sendDirectives, 'success')
      expect(yield* Queue.take(harness.sentMessages)).toBe('第一段')
      expect(yield* Queue.take(harness.sendAttempts)).toBe('第二段')
      yield* Queue.offer(harness.sendDirectives, 'failure')
      yield* Fiber.join(dispatch)

      expect(yield* memoryRows(harness.ctx)).toEqual([])
      expect(yield* Queue.size(harness.sentMessages)).toBe(0)
      expect(yield* generationStarts(harness.subject)).toHaveLength(1)
    }),
  ),
)

it.effect(
  'silences the whole turn when repeated notebook actions exceed the configured total',
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness(
          [
            textGeneration(`<output><message>不能发送</message><actions>
            <action tool="notebook.write"><notes><item>
              <kind>fact</kind><content>第一条</content>
              <source-message-ids><item>overflow-source</item></source-message-ids>
            </item></notes></action>
            <action tool="notebook.write"><notes><item>
              <kind>self</kind><content>第二条</content>
              <source-message-ids><item>overflow-source</item></source-message-ids>
            </item></notes></action>
          </actions></output>`),
          ],
          { ...CONFIG, notebook: { maxNotesPerReply: 1, recallLimit: 8 } },
        )

        yield* dispatchMessage(harness, 'overflow-source', directMention('写太多笔记'))

        expect(yield* memoryRows(harness.ctx)).toEqual([])
        expect(yield* Queue.size(harness.sendAttempts)).toBe(0)
        expect(yield* generationStarts(harness.subject)).toHaveLength(1)
      }),
    ),
)

it.effect('rejects missing and foreign-scope sources while storing a same-scope proposal', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        textGeneration(`<output><message>只保留有来源的一条</message><actions>
          <action tool="notebook.write"><notes>
            <item><kind>fact</kind><content>不存在的来源</content>
              <source-message-ids><item>missing-source</item></source-message-ids></item>
            <item><kind>relationship</kind><content>跨群来源</content>
              <source-message-ids><item>foreign-source</item></source-message-ids></item>
            <item><kind>self</kind><content>同群有效来源</content>
              <source-message-ids><item>valid-source</item></source-message-ids></item>
          </notes></action>
        </actions></output>`),
      ])
      yield* dispatchMessage(harness, 'foreign-source', '另一个群的来源消息', {
        channelId: 'foreign-channel',
        userId: 'foreign-user',
        timestamp: BASE_TIMESTAMP - 1,
      })

      const dispatch = yield* dispatchMessage(
        harness,
        'valid-source',
        directMention('检查来源范围'),
      ).pipe(Effect.forkScoped)
      yield* Queue.take(harness.requests)
      expect(yield* Queue.take(harness.sendAttempts)).toBe('只保留有来源的一条')
      yield* Queue.offer(harness.sendDirectives, 'success')
      expect(yield* Queue.take(harness.sentMessages)).toBe('只保留有来源的一条')
      yield* Fiber.join(dispatch)

      const rows = yield* waitForMemoryCount(harness.ctx, 1, 200)
      expect(rows.map((row) => row.content)).toEqual(['同群有效来源'])
      const stored = rows[0]
      if (stored === undefined) return yield* Effect.die('Expected one same-scope note')
      expect(stored.sourceMessageIdsJson).toBe('["valid-source"]')
      expect(yield* generationStarts(harness.subject)).toHaveLength(1)
    }),
  ),
)
