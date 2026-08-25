import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { ActivityGateValue, GatePressure } from '../../src/index'

it.effect('turns the documented 45 second cooldown into decreasing normalized pressure', () =>
  Effect.sync(() => {
    const cases: ReadonlyArray<{
      readonly elapsedMs: number
      readonly cooldownMs: number
      readonly expected: number
    }> = [
      { elapsedMs: 0, cooldownMs: 45_000, expected: 1 },
      { elapsedMs: 22_500, cooldownMs: 45_000, expected: 0.5 },
      { elapsedMs: 45_000, cooldownMs: 45_000, expected: 0 },
      { elapsedMs: 90_000, cooldownMs: 45_000, expected: 0 },
      { elapsedMs: 0, cooldownMs: 0, expected: 0 },
    ]

    for (const testCase of cases) {
      expect(
        GatePressure.cooldown(
          GatePressure.CooldownInput.make({
            elapsedSinceWakeMs: ActivityGateValue.Milliseconds.make(testCase.elapsedMs),
            cooldownMs: ActivityGateValue.Milliseconds.make(testCase.cooldownMs),
          }),
        ),
      ).toBe(testCase.expected)
    }

    expect(GatePressure.DEFAULT_COOLDOWN_MS).toBe(45_000)
  }),
)

it.effect('maps budget utilization to bounded pressure', () =>
  Effect.sync(() => {
    const cases: ReadonlyArray<{
      readonly used: number
      readonly limit: number
      readonly expected: number
    }> = [
      { used: 0, limit: 10, expected: 0 },
      { used: 5, limit: 10, expected: 0.5 },
      { used: 10, limit: 10, expected: 1 },
      { used: 20, limit: 10, expected: 1 },
      { used: 0, limit: 0, expected: 1 },
    ]

    for (const testCase of cases) {
      expect(
        GatePressure.budget(
          GatePressure.BudgetInput.make({
            used: ActivityGateValue.UsageCount.make(testCase.used),
            limit: ActivityGateValue.UsageCount.make(testCase.limit),
          }),
        ),
      ).toBe(testCase.expected)
    }
  }),
)
