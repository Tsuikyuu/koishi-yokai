import { expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { TestClock } from 'effect/testing'
import {
  CapabilityScope,
  FocusMessage,
  SCHEDULE_CANCEL_ACTION_TOOL_ID,
  SCHEDULE_CONTEXT_PROVIDER_ID,
  SCHEDULE_CREATE_ACTION_TOOL_ID,
  SCHEDULE_QUERY_FEEDBACK_TOOL_ID,
  SCHEDULE_UPDATE_ACTION_TOOL_ID,
  TokenLimit,
} from 'yokai-protocol'

import {
  ContextAssembly,
  ScheduledTask,
  ScheduledTaskCapabilities,
  ScheduledTaskModel,
} from '../../src/index'
import {
  CREATOR_ID,
  INSTANCE_ID,
  MISSING_SOURCE_ID,
  SCOPE,
  SOURCE_ID,
  TestStorage,
  createRequest,
  serviceLayer,
} from './fixtures'

const CAPABILITY_SCOPE = CapabilityScope.make({
  instanceId: INSTANCE_ID,
  platform: SCOPE.platform,
  guildId: SCOPE.guildId,
  channelId: SCOPE.channelId,
})

const OPTIONS: ScheduledTaskCapabilities.Options = {
  instanceId: INSTANCE_ID,
  timeZone: ScheduledTaskModel.TimeZoneId.make('UTC'),
  contextLimit: ScheduledTaskModel.QueryLimit.make(8),
}

const focus = FocusMessage.make({
  messageId: SOURCE_ID,
  authorId: CREATOR_ID,
  timestamp: 0,
  content: 'remind me later',
})

it.effect('always provides bounded host time and IANA zone context, even with zero tasks', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const schedules = yield* ScheduledTask.Service
    const provider = ScheduledTaskCapabilities.makeContextProvider(schedules, OPTIONS)

    const empty = Option.getOrThrow(
      yield* provider.provide({
        scope: CAPABILITY_SCOPE,
        focus,
        tokenBudget: TokenLimit.make(256),
      }),
    )
    expect(provider.id).toBe(SCHEDULE_CONTEXT_PROVIDER_ID)
    expect(provider.maxTokens).toBe(256)
    expect(empty.content).toContain('"hostNowEpochMs":0')
    expect(empty.content).toContain('"hostLocalIso":"1970-01-01T00:00:00.000+00:00[UTC]"')
    expect(empty.content).toContain('"timeZone":"UTC"')

    const task = yield* schedules.create(createRequest('1970-01-01T00:00:10'))
    const populated = Option.getOrThrow(
      yield* provider.provide({
        scope: CAPABILITY_SCOPE,
        focus,
        tokenBudget: TokenLimit.make(256),
      }),
    )
    expect(populated.content).toContain(task.scheduleId)
    expect(populated.content).toContain(task.reason)
    expect(populated.sourceRefs).toEqual([])
    expect(populated.estimatedTokens).toBeLessThanOrEqual(256)
  }).pipe(Effect.provide(serviceLayer())),
)

it.effect('prepares a bounded read-only schedule.query feedback result', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const schedules = yield* ScheduledTask.Service
    const task = yield* schedules.create(createRequest('1970-01-01T00:00:10'))
    const tool = ScheduledTaskCapabilities.makeFeedbackTool(schedules, OPTIONS)

    expect(tool.id).toBe(SCHEDULE_QUERY_FEEDBACK_TOOL_ID)
    const prepared = yield* tool.prepare({
      scope: CAPABILITY_SCOPE,
      input: { statuses: ['pending'], 'creator-id': CREATOR_ID, limit: 8 },
    })
    const output = yield* prepared.execute()
    const serialized = JSON.stringify(output)
    expect(serialized).toContain(task.scheduleId)
    expect(serialized).toContain('"untrusted":true')

    const oversized = yield* tool
      .prepare({ scope: CAPABILITY_SCOPE, input: { limit: 32 } })
      .pipe(Effect.flip)
    expect(oversized._tag).toBe('FeedbackToolValidationError')
    expect(oversized.reason).toBe('budget-exceeded')
  }).pipe(Effect.provide(serviceLayer())),
)

it.effect('marks an exact query-limit result as truncated', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const schedules = yield* ScheduledTask.Service
    for (let index = 0; index < OPTIONS.contextLimit; index += 1) {
      yield* schedules.create(
        createRequest(
          `1970-01-01T00:00:${String(index + 10).padStart(2, '0')}`,
          `limit-${String(index)}`,
        ),
      )
    }
    const tool = ScheduledTaskCapabilities.makeFeedbackTool(schedules, OPTIONS)
    const prepared = yield* tool.prepare({
      scope: CAPABILITY_SCOPE,
      input: { statuses: ['pending'], limit: OPTIONS.contextLimit },
    })

    expect(JSON.stringify(yield* prepared.execute())).toContain('"truncated":true')
  }).pipe(Effect.provide(serviceLayer())),
)

it.effect('bounds schedule.query results by both estimated tokens and UTF-8 bytes', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const schedules = yield* ScheduledTask.Service
    const first = yield* schedules.create(
      createRequest('1970-01-01T00:00:10', 'utf8-first', '约'.repeat(2_048)),
    )
    const second = yield* schedules.create(
      createRequest('1970-01-01T00:00:11', 'utf8-second', '束'.repeat(2_048)),
    )
    const tool = ScheduledTaskCapabilities.makeFeedbackTool(schedules, OPTIONS)
    const prepared = yield* tool.prepare({ scope: CAPABILITY_SCOPE, input: { limit: 8 } })
    const serialized = JSON.stringify(yield* prepared.execute())
    if (serialized === undefined) return yield* Effect.die('Expected JSON feedback output')

    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(tool.maxResultTokens * 4)
    expect(serialized).toContain(first.scheduleId)
    expect(serialized).not.toContain(second.scheduleId)
    expect(serialized).toContain('"truncated":true')
  }).pipe(Effect.provide(serviceLayer())),
)

it.effect('reserves enough provider budget for ContextAssembly to retain host time', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const schedules = yield* ScheduledTask.Service
    yield* schedules.create(createRequest('1970-01-01T00:00:10', 'wrapper-budget', 'r'.repeat(700)))
    const provider = ScheduledTaskCapabilities.makeContextProvider(schedules, OPTIONS)
    const assembly = yield* ContextAssembly.collect({
      providers: [provider],
      scope: CAPABILITY_SCOPE,
      focus,
    })

    expect(assembly.fragments).toHaveLength(1)
    expect(Option.getOrNull(assembly.content)).toContain('"hostNowEpochMs":0')
    expect(Option.getOrNull(assembly.content)).toContain('"timeZone":"UTC"')
  }).pipe(Effect.provide(serviceLayer())),
)

it.effect('registers strict before-send create/update/cancel actions without model feedback', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const schedules = yield* ScheduledTask.Service
    const storage = yield* TestStorage
    const [create, update, cancel] = ScheduledTaskCapabilities.makeActionTools(schedules, OPTIONS)

    expect(create.id).toBe(SCHEDULE_CREATE_ACTION_TOOL_ID)
    expect(update.id).toBe(SCHEDULE_UPDATE_ACTION_TOOL_ID)
    expect(cancel.id).toBe(SCHEDULE_CANCEL_ACTION_TOOL_ID)
    for (const tool of [create, update, cancel]) {
      expect(tool.executionStage).toBe('before-send')
      expect(tool.completionPolicy).toBe('none')
      expect(tool.failurePolicy).toBe('block-reply')
    }
    expect(create.xmlTemplate).toContain('<source-message-id>')
    expect(create.xmlTemplate).toContain('<dedupe-key>')
    expect(update.xmlTemplate).toContain('<task-id>')
    expect(cancel.xmlTemplate).toContain('<task-id>')

    yield* create.execute({
      scope: CAPABILITY_SCOPE,
      input: {
        'source-message-id': SOURCE_ID,
        time: '1970-01-01T00:00:10',
        reason: 'Created by action',
        'dedupe-key': 'action-task',
        'repeat-every-minutes': 5,
      },
    })
    const created = (yield* storage.all())[0]
    if (created === undefined) return yield* Effect.die('expected created schedule')
    expect(Option.getOrNull(created.repeatEveryMs)).toBe(300_000)

    yield* TestClock.setTime(1_000)
    yield* update.execute({
      scope: CAPABILITY_SCOPE,
      input: {
        'task-id': created.scheduleId,
        time: '1970-01-01T00:00:20',
        reason: 'Complete replacement',
      },
    })
    const replaced = (yield* storage.all())[0]
    if (replaced === undefined) return yield* Effect.die('expected replaced schedule')
    expect(replaced.reason).toBe('Complete replacement')
    expect(replaced.dueAt).toBe(20_000)
    expect(Option.isNone(replaced.repeatEveryMs)).toBe(true)

    yield* cancel.execute({
      scope: CAPABILITY_SCOPE,
      input: { 'task-id': created.scheduleId },
    })
    const cancelled = (yield* storage.all())[0]
    if (cancelled === undefined) return yield* Effect.die('expected cancelled schedule')
    expect(cancelled.status).toBe('cancelled')

    const missingSource = yield* create
      .execute({
        scope: CAPABILITY_SCOPE,
        input: {
          'source-message-id': MISSING_SOURCE_ID,
          time: '1970-01-01T00:00:30',
          reason: 'Must fail',
          'dedupe-key': 'missing-action-source',
        },
      })
      .pipe(Effect.flip)
    expect(missingSource._tag).toBe('ActionToolExecutionError')
    expect(missingSource.reason).toBe('execution-failed')
  }).pipe(Effect.provide(serviceLayer())),
)
