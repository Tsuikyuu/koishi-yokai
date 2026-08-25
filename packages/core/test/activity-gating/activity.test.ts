import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { ActivityGateValue, ActivityScoring } from '../../src/index'

const baseMessage = ActivityScoring.Message.make({
  isDuplicate: false,
  isOtherBot: false,
  isSelf: false,
  isEffective: true,
  isFirstParticipantInWindow: false,
  isQuestion: false,
  hasQuote: false,
  hasMedia: false,
})

const message = (overrides: Partial<ActivityScoring.Message> = {}): ActivityScoring.Message =>
  ActivityScoring.Message.make({ ...baseMessage, ...overrides })

it.effect('uses the documented 120 second half-life', () =>
  Effect.sync(() => {
    const cases: ReadonlyArray<{
      readonly elapsedMs: number
      readonly expected: number
    }> = [
      { elapsedMs: 0, expected: 8 },
      { elapsedMs: 60_000, expected: 8 / Math.sqrt(2) },
      { elapsedMs: 120_000, expected: 4 },
      { elapsedMs: 240_000, expected: 2 },
    ]

    for (const testCase of cases) {
      expect(
        ActivityScoring.decay(
          ActivityGateValue.Score.make(8),
          ActivityGateValue.Milliseconds.make(testCase.elapsedMs),
        ),
      ).toBeCloseTo(testCase.expected)
    }
  }),
)

it.effect('applies the documented message impulse table and cap', () =>
  Effect.sync(() => {
    const cases: ReadonlyArray<{
      readonly name: string
      readonly candidate: ActivityScoring.Message
      readonly expected: number
    }> = [
      { name: 'ordinary effective message', candidate: message(), expected: 1 },
      {
        name: 'first participant in five minutes',
        candidate: message({ isFirstParticipantInWindow: true }),
        expected: 1.5,
      },
      { name: 'question', candidate: message({ isQuestion: true }), expected: 1.25 },
      { name: 'quote', candidate: message({ hasQuote: true }), expected: 1.25 },
      { name: 'media', candidate: message({ hasMedia: true }), expected: 1.25 },
      {
        name: 'all bonuses capped',
        candidate: message({
          isFirstParticipantInWindow: true,
          isQuestion: true,
          hasQuote: true,
          hasMedia: true,
        }),
        expected: 1.75,
      },
      { name: 'ineffective message', candidate: message({ isEffective: false }), expected: 0 },
      { name: 'duplicate message', candidate: message({ isDuplicate: true }), expected: 0 },
      { name: 'other bot message', candidate: message({ isOtherBot: true }), expected: 0 },
      { name: 'self message', candidate: message({ isSelf: true }), expected: 0 },
    ]

    for (const testCase of cases) {
      expect(ActivityScoring.impulse(testCase.candidate), testCase.name).toBe(testCase.expected)
    }

    expect(ActivityScoring.NEW_PARTICIPANT_WINDOW_MS).toBe(300_000)
  }),
)

it.effect('adds only the current eligible impulse after decay', () =>
  Effect.sync(() => {
    const result = ActivityScoring.update(
      ActivityScoring.UpdateInput.make({
        previousActivity: ActivityGateValue.Score.make(8),
        elapsedMs: ActivityGateValue.Milliseconds.make(120_000),
        message: message(),
      }),
    )

    expect(result.decayedActivity).toBe(4)
    expect(result.impulse).toBe(1)
    expect(result.activity).toBe(5)
  }),
)
