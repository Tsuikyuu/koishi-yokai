import { type DateTime, Schema } from 'effect'

export const Category = Schema.Literals(['reserved', 'normal', 'background'])

export type Category = typeof Category.Type

export const Window = Schema.Literals(['minute', 'day'])

export type Window = typeof Window.Type

export const FailurePhase = Schema.Literals(['before-dispatch', 'after-dispatch'])

export type FailurePhase = typeof FailurePhase.Type

export const CallCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand('@yokai/core/CallBudgetCount'),
)

export type CallCount = typeof CallCount.Type

export const EpochMilliseconds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand('@yokai/core/CallBudgetEpochMilliseconds'),
)

export type EpochMilliseconds = typeof EpochMilliseconds.Type

export const LocalDate = Schema.NonEmptyString.pipe(Schema.brand('@yokai/core/CallBudgetLocalDate'))

export type LocalDate = typeof LocalDate.Type

export const ReservationId = Schema.NonEmptyString.pipe(
  Schema.brand('@yokai/core/CallBudgetReservationId'),
)

export type ReservationId = typeof ReservationId.Type

export const WindowLimits = Schema.Struct({
  minute: CallCount,
  day: CallCount,
})

export interface WindowLimits extends Schema.Schema.Type<typeof WindowLimits> {}

export const ClassifiedLimits = Schema.Struct({
  reserved: WindowLimits,
  normal: WindowLimits,
  background: WindowLimits,
})

export interface ClassifiedLimits extends Schema.Schema.Type<typeof ClassifiedLimits> {}

export interface Options {
  readonly limits: ClassifiedLimits
  readonly timeZone: DateTime.TimeZone
}

export const Reservation = Schema.Struct({
  id: ReservationId,
  category: Category,
  reservedAt: EpochMilliseconds,
  minuteWindowStartedAt: EpochMilliseconds,
  dayWindowLocalDate: LocalDate,
})

export interface Reservation extends Schema.Schema.Type<typeof Reservation> {}

export const Usage = Schema.Struct({
  limit: CallCount,
  pending: CallCount,
  committed: CallCount,
  remaining: CallCount,
})

export interface Usage extends Schema.Schema.Type<typeof Usage> {}

export const ClassifiedUsage = Schema.Struct({
  reserved: Usage,
  normal: Usage,
  background: Usage,
})

export interface ClassifiedUsage extends Schema.Schema.Type<typeof ClassifiedUsage> {}

export const MinuteWindowSnapshot = Schema.Struct({
  startedAt: EpochMilliseconds,
  usage: ClassifiedUsage,
})

export interface MinuteWindowSnapshot extends Schema.Schema.Type<typeof MinuteWindowSnapshot> {}

export const DayWindowSnapshot = Schema.Struct({
  localDate: LocalDate,
  usage: ClassifiedUsage,
})

export interface DayWindowSnapshot extends Schema.Schema.Type<typeof DayWindowSnapshot> {}

export const Snapshot = Schema.Struct({
  minute: MinuteWindowSnapshot,
  day: DayWindowSnapshot,
})

export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}

export class BudgetExceededError extends Schema.TaggedError<BudgetExceededError>(
  '@yokai/core/CallBudget.BudgetExceededError',
)('CallBudgetExceededError', {
  category: Category,
  window: Window,
  used: CallCount,
  limit: CallCount,
}) {}
