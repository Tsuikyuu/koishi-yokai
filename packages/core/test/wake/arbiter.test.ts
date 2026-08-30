import { expect, it } from '@effect/vitest'
import { CapabilityScope, FocusMessage, ResponseMechanismId } from 'yokai-protocol'
import { DateTime, Deferred, Duration, Effect, Fiber, Layer, Option, Ref } from 'effect'
import { TestClock } from 'effect/testing'

import { CallBudget, WakeArbiter, WakeProposal } from '../../src/index'

const SCOPE = CapabilityScope.make({
  instanceId: 'test',
  platform: 'test',
  guildId: 'guild',
  channelId: 'channel',
})
const OTHER_SCOPE = CapabilityScope.make({
  ...SCOPE,
  channelId: 'other-channel',
})

const limits = (count: number): CallBudget.ClassifiedLimits =>
  CallBudget.ClassifiedLimits.make({
    reserved: CallBudget.WindowLimits.make({
      minute: CallBudget.CallCount.make(count),
      day: CallBudget.CallCount.make(count),
    }),
    normal: CallBudget.WindowLimits.make({
      minute: CallBudget.CallCount.make(count),
      day: CallBudget.CallCount.make(count),
    }),
    background: CallBudget.WindowLimits.make({
      minute: CallBudget.CallCount.make(count),
      day: CallBudget.CallCount.make(count),
    }),
  })

const testLayer = (count = 8, cooldownMs = 45_000) => {
  const budget = CallBudget.layer({
    limits: limits(count),
    timeZone: DateTime.zoneMakeNamedUnsafe('UTC'),
  })
  return WakeArbiter.layer({
    cooldownMs: WakeProposal.DurationMilliseconds.make(cooldownMs),
  }).pipe(Layer.provideMerge(budget))
}

const proposal = (
  mergeKey: string,
  reason: string,
  priority: number,
  options: {
    readonly submittedAt?: number
    readonly expiresAt?: number
    readonly debounceMs?: number
    readonly category?: CallBudget.Category
    readonly cooldown?: WakeProposal.CooldownPolicy
    readonly scope?: CapabilityScope
  } = {},
): WakeProposal.Proposal => {
  const submittedAt = options.submittedAt === undefined ? 0 : options.submittedAt
  const scope = options.scope === undefined ? SCOPE : options.scope
  return WakeProposal.Proposal.make({
    scopeId: WakeProposal.scopeIdOf(scope),
    scope,
    mergeKey: WakeProposal.MergeKey.make(mergeKey),
    kind: options.category === 'normal' ? 'activity' : 'direct',
    reason: WakeProposal.Reason.make({
      mechanismId: ResponseMechanismId.make('test'),
      code: WakeProposal.ReasonCode.make(reason),
      priority: WakeProposal.Priority.make(priority),
    }),
    focus: FocusMessage.make({
      messageId: reason,
      authorId: 'user',
      timestamp: submittedAt,
      content: reason,
    }),
    submittedAt: WakeProposal.EpochMilliseconds.make(submittedAt),
    expiresAt: WakeProposal.EpochMilliseconds.make(
      options.expiresAt === undefined ? submittedAt + 10_000 : options.expiresAt,
    ),
    debounceMs: WakeProposal.DurationMilliseconds.make(
      options.debounceMs === undefined ? 500 : options.debounceMs,
    ),
    budgetCategory: options.category === undefined ? 'reserved' : options.category,
    cooldownPolicy: options.cooldown === undefined ? 'bypass' : options.cooldown,
  })
}

it.effect('merges a same-scope burst into one highest-priority turn', () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const arbiter = yield* WakeArbiter.Service
      const budget = yield* CallBudget.Service
      const executions = yield* Ref.make<ReadonlyArray<WakeProposal.Merged>>([])
      const execute: WakeArbiter.Executor<never> = (merged, markDispatched) =>
        markDispatched().pipe(
          Effect.andThen(Ref.update(executions, (current) => [...current, merged])),
        )

      const first = yield* arbiter
        .submit(proposal('conversation', 'social', 10), execute)
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* TestClock.adjust(Duration.millis(300))
      const second = yield* arbiter
        .submit(proposal('conversation', 'direct', 100), execute)
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow

      expect(yield* Ref.get(executions)).toHaveLength(0)
      yield* TestClock.adjust(Duration.millis(499))
      expect(yield* Ref.get(executions)).toHaveLength(0)
      yield* TestClock.adjust(Duration.millis(1))
      const firstOutcome = yield* Fiber.join(first)
      const secondOutcome = yield* Fiber.join(second)

      expect(firstOutcome._tag).toBe('Executed')
      expect(secondOutcome._tag).toBe('Executed')
      const recorded = yield* Ref.get(executions)
      expect(recorded).toHaveLength(1)
      expect(recorded[0]).toMatchObject({
        primaryReason: { code: 'direct', priority: 100 },
        additionalReasons: [{ code: 'social', priority: 10 }],
        mergedCount: 2,
      })
      const usage = yield* budget.snapshot()
      expect(usage.minute.usage.reserved.committed).toBe(1)
      expect(usage.minute.usage.reserved.pending).toBe(0)
    }).pipe(Effect.provide(testLayer())),
  ),
)

it.effect('drops an expired proposal before budget or execution', () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const arbiter = yield* WakeArbiter.Service
      const budget = yield* CallBudget.Service
      const executions = yield* Ref.make(0)
      const fiber = yield* arbiter
        .submit(
          proposal('expiring', 'expires', 10, { debounceMs: 1_000, expiresAt: 500 }),
          (_merged, markDispatched) =>
            markDispatched().pipe(Effect.andThen(Ref.update(executions, (count) => count + 1))),
        )
        .pipe(Effect.forkScoped)

      yield* TestClock.adjust(Duration.seconds(1))
      const outcome = yield* Fiber.join(fiber)
      expect(outcome._tag).toBe('Expired')
      expect(yield* Ref.get(executions)).toBe(0)
      expect((yield* budget.snapshot()).minute.usage.normal.committed).toBe(0)
      expect((yield* budget.snapshot()).minute.usage.reserved.committed).toBe(0)
    }).pipe(Effect.provide(testLayer())),
  ),
)

it.effect('serializes different merge keys in the same channel', () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const arbiter = yield* WakeArbiter.Service
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const starts = yield* Ref.make<ReadonlyArray<string>>([])

      const first = yield* arbiter
        .submit(proposal('first', 'first', 10, { debounceMs: 0 }), (merged, markDispatched) =>
          markDispatched().pipe(
            Effect.andThen(Ref.update(starts, (current) => [...current, merged.mergeKey])),
            Effect.andThen(Deferred.succeed(firstStarted, undefined)),
            Effect.andThen(Deferred.await(releaseFirst)),
          ),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(firstStarted)
      const second = yield* arbiter
        .submit(proposal('second', 'second', 10, { debounceMs: 0 }), (merged, markDispatched) =>
          markDispatched().pipe(
            Effect.andThen(Ref.update(starts, (current) => [...current, merged.mergeKey])),
          ),
        )
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow

      expect(yield* Ref.get(starts)).toEqual(['first'])
      yield* Deferred.succeed(releaseFirst, undefined)
      expect((yield* Fiber.join(first))._tag).toBe('Executed')
      expect((yield* Fiber.join(second))._tag).toBe('Executed')
      expect(yield* Ref.get(starts)).toEqual(['first', 'second'])
    }).pipe(Effect.provide(testLayer())),
  ),
)

it.effect('allows different channels to execute independently', () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const arbiter = yield* WakeArbiter.Service
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const starts = yield* Ref.make(0)

      const first = yield* arbiter
        .submit(proposal('conversation', 'first-channel', 10, { debounceMs: 0 }), (_merged, mark) =>
          mark().pipe(
            Effect.andThen(Ref.update(starts, (count) => count + 1)),
            Effect.andThen(Deferred.succeed(firstStarted, undefined)),
            Effect.andThen(Deferred.await(releaseFirst)),
          ),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(firstStarted)
      const second = yield* arbiter
        .submit(
          proposal('conversation', 'other-channel', 10, {
            debounceMs: 0,
            scope: OTHER_SCOPE,
          }),
          (_merged, mark) => mark().pipe(Effect.andThen(Ref.update(starts, (count) => count + 1))),
        )
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow

      expect(yield* Ref.get(starts)).toBe(2)
      yield* Deferred.succeed(releaseFirst, undefined)
      expect((yield* Fiber.join(first))._tag).toBe('Executed')
      expect((yield* Fiber.join(second))._tag).toBe('Executed')
    }).pipe(Effect.provide(testLayer())),
  ),
)

it.effect('enforces social cooldown while direct proposals bypass it', () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const arbiter = yield* WakeArbiter.Service
      const execute: WakeArbiter.Executor<never> = (_merged, markDispatched) =>
        markDispatched().pipe(Effect.asVoid)

      expect(
        (yield* arbiter.submit(proposal('direct-first', 'direct', 100, { debounceMs: 0 }), execute))
          ._tag,
      ).toBe('Executed')
      const denied = yield* arbiter.submit(
        proposal('social', 'social', 10, {
          debounceMs: 0,
          category: 'normal',
          cooldown: 'enforce',
        }),
        execute,
      )
      expect(denied._tag).toBe('CooldownDenied')
      if (denied._tag !== 'CooldownDenied') return yield* Effect.die('Expected cooldown denial')
      expect(denied.remainingMs).toBe(45_000)

      expect(
        (yield* arbiter.submit(
          proposal('direct-second', 'direct', 100, { debounceMs: 0 }),
          execute,
        ))._tag,
      ).toBe('Executed')
    }).pipe(Effect.provide(testLayer())),
  ),
)

it.effect('denies exhausted categories and releases skipped pre-dispatch turns', () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const arbiter = yield* WakeArbiter.Service
      const budget = yield* CallBudget.Service
      const skipped = yield* arbiter.submit(
        proposal('skipped', 'skipped', 100, { debounceMs: 0 }),
        () => Effect.void,
      )
      expect(skipped._tag).toBe('Skipped')
      expect((yield* budget.snapshot()).minute.usage.reserved.remaining).toBe(1)

      const execute: WakeArbiter.Executor<never> = (_merged, markDispatched) =>
        markDispatched().pipe(Effect.asVoid)
      expect(
        (yield* arbiter.submit(proposal('charged', 'charged', 100, { debounceMs: 0 }), execute))
          ._tag,
      ).toBe('Executed')
      expect(
        (yield* arbiter.submit(proposal('denied', 'denied', 100, { debounceMs: 0 }), execute))._tag,
      ).toBe('BudgetDenied')
      expect(
        Option.isSome((yield* arbiter.gateStatus(WakeProposal.scopeIdOf(SCOPE))).lastWakeAt),
      ).toBe(true)
    }).pipe(Effect.provide(testLayer(1))),
  ),
)

it.effect('requires a separate budget reservation for each additional logical call', () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const arbiter = yield* WakeArbiter.Service
      const budget = yield* CallBudget.Service
      const continuationAttempts = yield* Ref.make(0)

      const outcome = yield* arbiter.submit(
        proposal('bounded-feedback', 'bounded-feedback', 100, { debounceMs: 0 }),
        (_merged, markDispatched, withLogicalCallReservation) =>
          Effect.gen(function* () {
            expect(yield* markDispatched()).toBe(true)
            const error = yield* withLogicalCallReservation(() =>
              Ref.update(continuationAttempts, (count) => count + 1),
            ).pipe(Effect.flip)
            expect(error._tag).toBe('CallBudgetExceededError')
          }),
      )

      expect(outcome._tag).toBe('Executed')
      expect(yield* Ref.get(continuationAttempts)).toBe(0)
      const snapshot = yield* budget.snapshot()
      expect(snapshot.minute.usage.reserved.committed).toBe(1)
      expect(snapshot.minute.usage.reserved.pending).toBe(0)
      expect(snapshot.minute.usage.reserved.remaining).toBe(0)
    }).pipe(Effect.provide(testLayer(1))),
  ),
)

it.effect('releases an additional reservation when continuation is not dispatched', () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const arbiter = yield* WakeArbiter.Service
      const budget = yield* CallBudget.Service

      const outcome = yield* arbiter.submit(
        proposal('failed-feedback', 'failed-feedback', 100, { debounceMs: 0 }),
        (_merged, markDispatched, withLogicalCallReservation) =>
          Effect.gen(function* () {
            expect(yield* markDispatched()).toBe(true)
            yield* withLogicalCallReservation(() => Effect.fail('before-continuation')).pipe(
              Effect.catch(() => Effect.void),
            )
          }),
      )

      expect(outcome._tag).toBe('Executed')
      const snapshot = yield* budget.snapshot()
      expect(snapshot.minute.usage.reserved.committed).toBe(1)
      expect(snapshot.minute.usage.reserved.pending).toBe(0)
      expect(snapshot.minute.usage.reserved.remaining).toBe(1)
    }).pipe(Effect.provide(testLayer(2))),
  ),
)

it.effect('commits an additional reservation once continuation dispatch starts', () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const arbiter = yield* WakeArbiter.Service
      const budget = yield* CallBudget.Service

      const outcome = yield* arbiter.submit(
        proposal('dispatched-feedback', 'dispatched-feedback', 100, { debounceMs: 0 }),
        (_merged, markDispatched, withLogicalCallReservation) =>
          Effect.gen(function* () {
            expect(yield* markDispatched()).toBe(true)
            yield* withLogicalCallReservation((markContinuationDispatched) =>
              markContinuationDispatched().pipe(
                Effect.andThen(Effect.fail('after-continuation-dispatch')),
              ),
            ).pipe(Effect.catch(() => Effect.void))
          }),
      )

      expect(outcome._tag).toBe('Executed')
      const snapshot = yield* budget.snapshot()
      expect(snapshot.minute.usage.reserved.committed).toBe(2)
      expect(snapshot.minute.usage.reserved.pending).toBe(0)
      expect(snapshot.minute.usage.reserved.remaining).toBe(0)
    }).pipe(Effect.provide(testLayer(2))),
  ),
)

it.effect('classifies typed executor failures without leaking them through submit', () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const arbiter = yield* WakeArbiter.Service
      const budget = yield* CallBudget.Service

      const beforeDispatch = yield* arbiter.submit(
        proposal('failed-before-dispatch', 'failed-before-dispatch', 100, { debounceMs: 0 }),
        () => Effect.fail('expected-before-dispatch'),
      )
      expect(beforeDispatch).toMatchObject({
        _tag: 'ExecutionFailed',
        dispatched: false,
      })
      expect((yield* budget.snapshot()).minute.usage.reserved.remaining).toBe(8)

      const afterDispatch = yield* arbiter.submit(
        proposal('failed-after-dispatch', 'failed-after-dispatch', 100, { debounceMs: 0 }),
        (_merged, markDispatched) =>
          markDispatched().pipe(Effect.andThen(Effect.fail('expected-after-dispatch'))),
      )
      expect(afterDispatch).toMatchObject({
        _tag: 'ExecutionFailed',
        dispatched: true,
      })
      expect((yield* budget.snapshot()).minute.usage.reserved.remaining).toBe(7)
      expect(
        Option.isSome((yield* arbiter.gateStatus(WakeProposal.scopeIdOf(SCOPE))).lastWakeAt),
      ).toBe(true)
    }).pipe(Effect.provide(testLayer())),
  ),
)
