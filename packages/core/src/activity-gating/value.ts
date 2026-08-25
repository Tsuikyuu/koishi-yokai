import { Schema } from 'effect'

export const Score = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand('@yokai/core/ActivityGateScore'),
)

export type Score = typeof Score.Type

export const Pressure = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(
  Schema.brand('@yokai/core/ActivityGatePressure'),
)

export type Pressure = typeof Pressure.Type

export const Milliseconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand('@yokai/core/ActivityGateMilliseconds'),
)

export type Milliseconds = typeof Milliseconds.Type

export const PositiveMilliseconds = Schema.Finite.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand('@yokai/core/ActivityGatePositiveMilliseconds'),
)

export type PositiveMilliseconds = typeof PositiveMilliseconds.Type

export const UsageCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand('@yokai/core/ActivityGateUsageCount'),
)

export type UsageCount = typeof UsageCount.Type

export const MessageEligibility = Schema.Struct({
  isDuplicate: Schema.Boolean,
  isOtherBot: Schema.Boolean,
  isSelf: Schema.Boolean,
})

export interface MessageEligibility extends Schema.Schema.Type<typeof MessageEligibility> {}

export const isExcludedMessage = (message: MessageEligibility): boolean =>
  message.isDuplicate || message.isOtherBot || message.isSelf
