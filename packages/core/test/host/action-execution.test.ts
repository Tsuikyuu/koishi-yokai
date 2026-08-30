import type { RoleResponseEnvelope } from '@yokai-internal/mind'
import { expect, it } from '@effect/vitest'
import {
  ActionTool,
  ActionToolDurationMilliseconds,
  ActionToolExecutionError,
  ActionToolId,
  ActionToolXmlTemplate,
  CapabilityScope,
  type ActionToolCompletionPolicy,
  type ActionToolExecute,
  type ActionToolExecutionStage,
  type ActionToolFailurePolicy,
} from 'yokai-protocol'
import { Deferred, Duration, Effect, Fiber, Layer, Queue, Ref } from 'effect'
import { TestClock } from 'effect/testing'

import { ActionExecution, BackgroundTasks } from '../../src/index'

const SCOPE = CapabilityScope.make({
  instanceId: 'test',
  platform: 'test',
  guildId: 'guild',
  channelId: 'channel',
})

const action = (
  id: string,
  executionStage: ActionToolExecutionStage,
  completionPolicy: ActionToolCompletionPolicy,
  failurePolicy: ActionToolFailurePolicy,
  maxDurationMs: number,
  execute: ActionToolExecute,
): RoleResponseEnvelope.ParsedAction => ({
  tool: ActionTool.make({
    id: ActionToolId.make(id),
    protocolVersion: { major: 1, minor: 0 },
    description: `Execute ${id}`,
    xmlTemplate: ActionToolXmlTemplate.make(`<action tool="${id}"></action>`),
    inputSchema: { _tag: 'Object', properties: [] },
    executionStage,
    completionPolicy,
    failurePolicy,
    maxDurationMs: ActionToolDurationMilliseconds.make(maxDurationMs),
    isAvailable: () => true,
    isInputAllowed: () => true,
    execute,
  }),
  input: {},
})

const failure = (id: string): ActionToolExecutionError =>
  new ActionToolExecutionError({
    toolId: ActionToolId.make(id),
    reason: 'execution-failed',
  })

const inlineFork: BackgroundTasks.Fork = <R>(
  task: Effect.Effect<void, never, R>,
): Effect.Effect<void, never, R> => task

const inlineBackgroundTasks = Layer.succeed(
  BackgroundTasks.Service,
  BackgroundTasks.Service.of({ fork: inlineFork }),
)

it.effect('continues or blocks a reply according to the failed before-send action policy', () =>
  Effect.gen(function* () {
    const continuedId = 'before.continue'
    const blockedId = 'before.block'
    const continued = action(continuedId, 'before-send', 'none', 'continue', 250, () =>
      Effect.fail(failure(continuedId)),
    )
    const blocked = action(blockedId, 'before-send', 'none', 'block-reply', 250, () =>
      Effect.fail(failure(blockedId)),
    )
    const synchronouslyThrown = action(
      'before.throw',
      'before-send',
      'none',
      'continue',
      250,
      () => {
        throw new Error('third-party executor threw before returning an Effect')
      },
    )

    expect(yield* ActionExecution.runBeforeSend([continued], SCOPE)).toEqual({
      attempted: 1,
      failed: 1,
      blockReply: false,
    })
    expect(yield* ActionExecution.runBeforeSend([blocked], SCOPE)).toEqual({
      attempted: 1,
      failed: 1,
      blockReply: true,
    })
    expect(yield* ActionExecution.runBeforeSend([synchronouslyThrown], SCOPE)).toEqual({
      attempted: 1,
      failed: 1,
      blockReply: false,
    })
  }),
)

it.effect('starts before-send actions concurrently and caps the whole wait at 750ms', () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const firstStarted = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const completed = yield* Deferred.make<void>()
      const waitingAction = (id: string, started: Deferred.Deferred<void>) =>
        action(id, 'before-send', 'none', 'continue', 2_000, () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        )

      const fiber = yield* ActionExecution.runBeforeSend(
        [
          waitingAction('before.concurrent.first', firstStarted),
          waitingAction('before.concurrent.second', secondStarted),
        ],
        SCOPE,
      ).pipe(Effect.ensuring(Deferred.succeed(completed, undefined)), Effect.forkScoped)

      yield* Deferred.await(firstStarted)
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(secondStarted)).toBe(true)

      yield* TestClock.adjust(Duration.millis(749))
      expect(yield* Deferred.isDone(completed)).toBe(false)

      yield* TestClock.adjust(Duration.millis(1))
      expect(yield* Fiber.join(fiber)).toEqual({
        attempted: 2,
        failed: 2,
        blockReply: false,
      })
    }),
  ),
)

it.effect(
  'returns after-send scheduling immediately and interrupts work when its Layer closes',
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const pending = action('after.pending', 'after-send', 'none', 'continue', 60_000, () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      )

      yield* Effect.gen(function* () {
        yield* ActionExecution.scheduleAfterSend([pending], SCOPE)
        yield* Deferred.await(started)
        expect(yield* Deferred.isDone(interrupted)).toBe(false)
      }).pipe(Effect.provide(BackgroundTasks.layer))

      expect(yield* Deferred.isDone(interrupted)).toBe(true)
    }),
)

it.effect('wakes once per deferred turn when multiple wake actions succeed', () =>
  Effect.gen(function* () {
    const executions = yield* Ref.make(0)
    const wakes = yield* Ref.make(0)
    const wakeEvents = yield* Queue.unbounded<void>()
    const successfulAction = (id: string) =>
      action(id, 'deferred', 'wake', 'continue', 1_000, () =>
        Ref.update(executions, (count) => count + 1),
      )
    const actions = [successfulAction('deferred.first'), successfulAction('deferred.second')]
    const onWake = () =>
      Ref.update(wakes, (count) => count + 1).pipe(
        Effect.andThen(Queue.offer(wakeEvents, undefined)),
        Effect.asVoid,
      )

    yield* Effect.gen(function* () {
      yield* ActionExecution.scheduleDeferred(actions, SCOPE, onWake)
      yield* Queue.take(wakeEvents)
      expect(yield* Ref.get(executions)).toBe(2)
      expect(yield* Ref.get(wakes)).toBe(1)

      yield* ActionExecution.scheduleDeferred(actions, SCOPE, onWake)
      yield* Queue.take(wakeEvents)
      expect(yield* Ref.get(executions)).toBe(4)
      expect(yield* Ref.get(wakes)).toBe(2)
    }).pipe(Effect.provide(BackgroundTasks.layer))
  }),
)

it.effect('does not wake when deferred wake actions fail', () =>
  Effect.gen(function* () {
    const wakes = yield* Ref.make(0)
    const failedId = 'deferred.failed'
    const failed = action(failedId, 'deferred', 'wake', 'continue', 1_000, () =>
      Effect.fail(failure(failedId)),
    )
    const successfulWithoutWake = action(
      'deferred.no-wake',
      'deferred',
      'none',
      'continue',
      1_000,
      () => Effect.void,
    )

    yield* ActionExecution.scheduleDeferred([failed, successfulWithoutWake], SCOPE, () =>
      Ref.update(wakes, (count) => count + 1),
    )

    expect(yield* Ref.get(wakes)).toBe(0)
  }).pipe(Effect.provide(inlineBackgroundTasks)),
)
