import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { ActivityGateValue, DynamicThreshold } from '../../src/index'

const pressureFields = [
  'recentCallPressure',
  'dailyBudgetPressure',
  'recentParticipationPressure',
] as const

it.effect('uses the documented initial activity and relevance thresholds', () =>
  Effect.sync(() => {
    expect(DynamicThreshold.DEFAULT_ACTIVITY_THRESHOLD).toBe(7)
    expect(DynamicThreshold.DEFAULT_RELEVANCE_THRESHOLD).toBe(2)
  }),
)

it.effect('adds every documented pressure to the base threshold', () =>
  Effect.sync(() => {
    const result = DynamicThreshold.calculate(
      DynamicThreshold.Input.make({
        baseThreshold: DynamicThreshold.DEFAULT_ACTIVITY_THRESHOLD,
        recentCallPressure: ActivityGateValue.Pressure.make(0.25),
        dailyBudgetPressure: ActivityGateValue.Pressure.make(0.5),
        recentParticipationPressure: ActivityGateValue.Pressure.make(0.75),
      }),
    )

    expect(result).toBe(8.5)
  }),
)

it.effect('never lowers the threshold as any pressure increases', () =>
  Effect.sync(() => {
    const pressureLevels = [0, 0.25, 0.5, 0.75, 1]

    for (const pressureField of pressureFields) {
      const thresholds = pressureLevels.map((pressure) =>
        DynamicThreshold.calculate(
          DynamicThreshold.Input.make({
            baseThreshold: DynamicThreshold.DEFAULT_RELEVANCE_THRESHOLD,
            recentCallPressure: ActivityGateValue.Pressure.make(0),
            dailyBudgetPressure: ActivityGateValue.Pressure.make(0),
            recentParticipationPressure: ActivityGateValue.Pressure.make(0),
            [pressureField]: ActivityGateValue.Pressure.make(pressure),
          }),
        ),
      )

      for (const [index, threshold] of thresholds.entries()) {
        if (index === 0) continue
        const previous = thresholds[index - 1]
        if (previous === undefined) continue
        expect(threshold).toBeGreaterThanOrEqual(previous)
      }
    }
  }),
)
