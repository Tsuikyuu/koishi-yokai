import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SQLiteDriver } from '@minatojs/driver-sqlite'
import { expect, it } from '@effect/vitest'
import {
  AdapterConformanceSetup,
  AdapterDiscoveryStep,
  AdapterGenerationStep,
  type AdapterGenerationStep as AdapterGenerationStepType,
} from 'yokai-adapter-conformance'
import { makeFakeAdapter } from 'yokai-adapter-conformance/fake'
import { ScheduledTaskModel, ScheduledTaskStorage } from '@yokai-internal/core'
import { MessageArchiveEvent } from '@yokai-internal/memory'
import { AdapterId, AdapterModelId, GenerationUsage, type YokaiAdapter } from 'yokai-protocol'
import { Deferred, Duration, Effect, Option, Queue } from 'effect'
import { Bot, Context, h, type Fragment, type Schema as KoishiSchema, Universal } from 'koishi'
import { vi } from 'vitest'

vi.mock('koishi', () => import('@koishijs/core'))

import { apply, type Config } from '../../src/index'
import { YokaiScheduleModel } from '../../src/schedule/model'
import { KoishiScheduledTaskStorage } from '../../src/schedule/storage'

const INSTANCE_ID = MessageArchiveEvent.InstanceId.make('schedule-restart')
const ADAPTER_ID = AdapterId.make('schedule-restart')
const MODEL_ID = AdapterModelId.make('model-a')
const MODEL_REFERENCE = 'schedule-restart/model-a'

const CONFIG: Config = {
  instanceId: INSTANCE_ID,
  model: MODEL_REFERENCE,
  feedbackToolsEnabled: false,
  schedule: { gracePeriodMs: 300_000 },
  wake: { cooldownMs: 0 },
}

const discovery = AdapterDiscoveryStep.cases.Success.make({
  discoveredAt: '2026-08-31T00:00:00.000Z',
  models: [
    {
      id: MODEL_ID,
      displayName: 'Schedule restart model',
      availability: 'available',
      discoveryFreshness: 'fresh',
    },
  ],
  blocked: false,
})

const response = AdapterGenerationStep.cases.Text.make({
  result: {
    _tag: 'Text',
    text: '<output><message>restored schedule delivered</message></output>',
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
    return Effect.runPromise(Queue.offer(this.sentMessages, text).pipe(Effect.as(['sent'])))
  }

  override dispose(): Promise<void> {
    return Promise.resolve()
  }
}

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), 'yokai-schedule-integration-'))),
  (directory) => Effect.tryPromise(() => rm(directory, { recursive: true, force: true })),
)

const databaseContext = (path: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const ctx = yield* Effect.sync(() => {
        const context = new Context()
        YokaiScheduleModel.define(context)
        context.plugin(SQLiteDriver, { path })
        return context
      })
      yield* Effect.promise(() => ctx.start())
      return ctx
    }),
    (ctx) => Effect.promise(() => ctx.stop()),
  )

const runtimeContext = (path: string, sentMessages: Queue.Queue<string>) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const harness = yield* Effect.sync(() => {
        const ctx = new Context()
        ctx.plugin(SQLiteDriver, { path })
        apply(ctx, CONFIG)
        return { ctx, bot: new TestBot(ctx, sentMessages) }
      })
      yield* Effect.promise(() => harness.ctx.start())
      return harness
    }),
    (harness) => Effect.promise(() => harness.ctx.stop()),
  )

const task = (dueAt: number): ScheduledTaskModel.Task =>
  ScheduledTaskModel.Task.make({
    instanceId: INSTANCE_ID,
    platform: MessageArchiveEvent.PlatformId.make('test'),
    guildId: MessageArchiveEvent.GuildId.make('guild'),
    channelId: MessageArchiveEvent.ChannelId.make('channel'),
    scheduleId: ScheduledTaskModel.ScheduleId.make(`schedule_${'a'.repeat(32)}`),
    dedupeKey: ScheduledTaskModel.DedupeKey.make('restart-once'),
    creationFingerprint: ScheduledTaskModel.CreationFingerprint.make('a'.repeat(64)),
    createdMessageId: MessageArchiveEvent.MessageId.make('restart-source'),
    creatorId: MessageArchiveEvent.ActorId.make('user'),
    selfId: MessageArchiveEvent.ActorId.make('bot'),
    reason: ScheduledTaskModel.Reason.make('Deliver after restart'),
    dueAt: ScheduledTaskModel.EpochMilliseconds.make(dueAt),
    repeatEveryMs: Option.none(),
    timeZone: ScheduledTaskModel.TimeZoneId.make('UTC'),
    status: 'pending',
    occurrence: ScheduledTaskModel.Occurrence.make(0),
    revision: ScheduledTaskModel.Revision.make(1),
    createdAt: ScheduledTaskModel.EpochMilliseconds.make(dueAt),
    updatedAt: ScheduledTaskModel.EpochMilliseconds.make(dueAt),
    lastTriggeredAt: Option.none(),
  })

const schemaOption = (schema: KoishiSchema, value: string): KoishiSchema | undefined => {
  const list = schema.list
  return list === undefined ? undefined : list.find((option) => option.value === value)
}

const registerAdapter = Effect.fn('ScheduleIntegrationTest.registerAdapter')(function* (
  ctx: Context,
  generationSteps: ReadonlyArray<AdapterGenerationStepType>,
) {
  const modelReady = yield* Deferred.make<void>()
  const removeListener = ctx.on('internal/schema', (name) => {
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
      tokenNamespace: 'schedule-restart-test',
    },
    AdapterConformanceSetup.make({ discoverySteps: [discovery], generationSteps }),
  )
  const adapter: YokaiAdapter = subject.adapter
  yield* Effect.promise(() => ctx.yokai.registerAdapter(adapter))
  yield* Deferred.await(modelReady)
  yield* Effect.sync(() => removeListener())
  return subject
})

it.live(
  'restores a due task after restart and never delivers that occurrence twice',
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* temporaryDirectory
        const path = join(directory, 'schedule.db')
        const expected = task(Date.now() - 1_000)

        yield* Effect.scoped(
          Effect.gen(function* () {
            const ctx = yield* databaseContext(path)
            yield* ScheduledTaskStorage.Service.pipe(
              Effect.flatMap((storage) => storage.create(expected)),
              Effect.provide(KoishiScheduledTaskStorage.layer(ctx)),
            )
          }),
        )

        yield* Effect.scoped(
          Effect.gen(function* () {
            const sentMessages = yield* Queue.unbounded<string>()
            const harness = yield* runtimeContext(path, sentMessages)
            yield* Effect.sleep(Duration.millis(50))
            const beforeReady = yield* Effect.promise(() =>
              harness.ctx.database.get('yokai_schedule', {}),
            )
            expect(beforeReady[0]).toMatchObject({ status: 'pending', revision: 1 })

            harness.bot.status = Universal.Status.ONLINE
            const subject = yield* registerAdapter(harness.ctx, [response])
            expect(yield* Queue.take(sentMessages).pipe(Effect.timeout(Duration.seconds(5)))).toBe(
              'restored schedule delivered',
            )
            yield* Effect.sleep(Duration.millis(1_100))

            const claimed = yield* Effect.promise(() =>
              harness.ctx.database.get('yokai_schedule', {}),
            )
            expect(claimed[0]).toMatchObject({ status: 'triggered', revision: 2 })
            expect(yield* Queue.size(sentMessages)).toBe(0)
            expect(
              (yield* subject.control.events()).filter(
                (event) => event._tag === 'RequestStarted' && event.kind === 'generation',
              ),
            ).toHaveLength(1)
          }),
        )

        yield* Effect.scoped(
          Effect.gen(function* () {
            const sentMessages = yield* Queue.unbounded<string>()
            const harness = yield* runtimeContext(path, sentMessages)
            harness.bot.status = Universal.Status.ONLINE
            const subject = yield* registerAdapter(harness.ctx, [])
            yield* Effect.sleep(Duration.millis(1_100))

            expect(yield* Queue.size(sentMessages)).toBe(0)
            expect(
              (yield* subject.control.events()).filter(
                (event) => event._tag === 'RequestStarted' && event.kind === 'generation',
              ),
            ).toHaveLength(0)
          }),
        )
      }),
    ),
  15_000,
)
