import { expect, it } from '@effect/vitest'
import { CapabilityScope, FocusMessage } from 'yokai-protocol'
import { DateTime, Duration, Effect, Layer, Option } from 'effect'
import { TestClock } from 'effect/testing'

import {
  ActivityResponseMechanism,
  CallBudget,
  DirectResponseMechanism,
  WakeArbiter,
  WakeMessage,
  WakeProposal,
} from '../../src/index'

const SCOPE = CapabilityScope.make({
  instanceId: 'test',
  platform: 'test',
  guildId: 'guild',
  channelId: 'channel',
})

const message = (
  messageId: string,
  overrides: Partial<WakeMessage.Message> = {},
): WakeMessage.Message =>
  WakeMessage.Message.make({
    scope: SCOPE,
    focus: FocusMessage.make({
      messageId,
      authorId: 'user',
      timestamp: 0,
      content: messageId,
    }),
    isDuplicate: false,
    isOtherBot: false,
    isSelf: false,
    isEffective: true,
    explicitMention: false,
    replyToSelf: false,
    nameHit: false,
    isQuestionOrHelp: false,
    hasQuote: false,
    hasMedia: false,
    ...overrides,
  })

const mechanismLayer = Layer.merge(
  DirectResponseMechanism.layer(),
  ActivityResponseMechanism.layer().pipe(
    Layer.provide(
      WakeArbiter.layer().pipe(
        Layer.provide(
          CallBudget.layer({
            limits: CallBudget.ClassifiedLimits.make({
              reserved: CallBudget.WindowLimits.make({
                minute: CallBudget.CallCount.make(100),
                day: CallBudget.CallCount.make(100),
              }),
              normal: CallBudget.WindowLimits.make({
                minute: CallBudget.CallCount.make(100),
                day: CallBudget.CallCount.make(100),
              }),
              background: CallBudget.WindowLimits.make({
                minute: CallBudget.CallCount.make(100),
                day: CallBudget.CallCount.make(100),
              }),
            }),
            timeZone: DateTime.zoneMakeNamedUnsafe('UTC'),
          }),
        ),
      ),
    ),
  ),
)

it.effect('uses the direct window for mentions, replies, and following supplements', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const direct = yield* DirectResponseMechanism.Service

    const mention = yield* direct.observe(message('mention', { explicitMention: true }))
    expect(Option.isSome(mention)).toBe(true)
    if (Option.isNone(mention)) return yield* Effect.die('Expected direct mention proposal')
    expect(mention.value.reason.code).toBe('explicit-mention')
    expect(mention.value.budgetCategory).toBe('reserved')
    expect(mention.value.cooldownPolicy).toBe('bypass')

    const supplement = yield* direct.observe(message('supplement'))
    expect(Option.isSome(supplement)).toBe(true)
    if (Option.isNone(supplement)) return yield* Effect.die('Expected supplement proposal')
    expect(supplement.value.mergeKey).toBe(mention.value.mergeKey)
    expect(supplement.value.reason.priority).toBeLessThan(mention.value.reason.priority)

    const otherAuthor = yield* direct.observe(
      message('other', {
        focus: FocusMessage.make({
          messageId: 'other',
          authorId: 'other-user',
          timestamp: 0,
          content: 'other',
        }),
      }),
    )
    expect(Option.isNone(otherAuthor)).toBe(true)

    yield* TestClock.adjust(Duration.millis(501))
    expect(Option.isNone(yield* direct.observe(message('late-supplement')))).toBe(true)
  }).pipe(Effect.provide(DirectResponseMechanism.layer())),
)

it.effect('keeps activity local until both documented thresholds pass', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const activity = yield* ActivityResponseMechanism.Service

    for (let index = 1; index <= 5; index += 1) {
      expect(
        Option.isNone(
          yield* activity.observe(message(`question-${index}`, { isQuestionOrHelp: true })),
        ),
      ).toBe(true)
    }

    const triggered = yield* activity.observe(message('question-6', { isQuestionOrHelp: true }))
    expect(Option.isSome(triggered)).toBe(true)
    if (Option.isNone(triggered)) return yield* Effect.die('Expected activity proposal')
    expect(triggered.value.reason.code).toBe('social-threshold')
    expect(triggered.value.budgetCategory).toBe('normal')
    expect(triggered.value.cooldownPolicy).toBe('enforce')
    expect(triggered.value.debounceMs).toBe(3_000)

    const beforeConsume = yield* activity.snapshot(WakeProposal.scopeIdOf(SCOPE))
    expect(beforeConsume.activity).toBeGreaterThanOrEqual(7)
    yield* activity.consume(WakeProposal.scopeIdOf(SCOPE))
    expect((yield* activity.snapshot(WakeProposal.scopeIdOf(SCOPE))).activity).toBe(0)
  }).pipe(Effect.provide(mechanismLayer)),
)

it.effect('excludes duplicate, self, and other-bot messages from activity proposals', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const activity = yield* ActivityResponseMechanism.Service
    const excluded = [
      message('duplicate', { isDuplicate: true, isQuestionOrHelp: true }),
      message('self', { isSelf: true, isQuestionOrHelp: true }),
      message('other-bot', { isOtherBot: true, isQuestionOrHelp: true }),
    ]

    for (const candidate of excluded) {
      expect(Option.isNone(yield* activity.observe(candidate))).toBe(true)
    }
    expect((yield* activity.snapshot(WakeProposal.scopeIdOf(SCOPE))).activity).toBe(0)
  }).pipe(Effect.provide(mechanismLayer)),
)
