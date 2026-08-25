import { Schema } from 'effect'

import { Milliseconds, Pressure, UsageCount } from './value'

export const DEFAULT_COOLDOWN_MS = Milliseconds.make(45_000)

export const CooldownInput = Schema.Struct({
  elapsedSinceWakeMs: Milliseconds,
  cooldownMs: Milliseconds,
})

export interface CooldownInput extends Schema.Schema.Type<typeof CooldownInput> {}

export const BudgetInput = Schema.Struct({
  used: UsageCount,
  limit: UsageCount,
})

export interface BudgetInput extends Schema.Schema.Type<typeof BudgetInput> {}

export const cooldown = (input: CooldownInput): Pressure => {
  if (input.cooldownMs === 0 || input.elapsedSinceWakeMs >= input.cooldownMs) {
    return Pressure.make(0)
  }

  return Pressure.make(1 - input.elapsedSinceWakeMs / input.cooldownMs)
}

export const budget = (input: BudgetInput): Pressure => {
  if (input.limit === 0) return Pressure.make(1)
  return Pressure.make(Math.min(1, input.used / input.limit))
}
