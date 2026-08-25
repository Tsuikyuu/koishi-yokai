import { Schema } from 'effect'

import { Pressure, Score } from './value'

export const DEFAULT_ACTIVITY_THRESHOLD = Score.make(7)
export const DEFAULT_RELEVANCE_THRESHOLD = Score.make(2)

export const Input = Schema.Struct({
  baseThreshold: Score,
  recentCallPressure: Pressure,
  dailyBudgetPressure: Pressure,
  recentParticipationPressure: Pressure,
})

export interface Input extends Schema.Schema.Type<typeof Input> {}

export const calculate = (input: Input): Score =>
  Score.make(
    input.baseThreshold +
      input.recentCallPressure +
      input.dailyBudgetPressure +
      input.recentParticipationPressure,
  )
