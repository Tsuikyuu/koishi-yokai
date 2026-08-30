import { DateTime, Effect, Option, Schema } from 'effect'

import { EpochMilliseconds, type TimeExpression, type TimeZoneId } from './model'

export class InvalidTimeZoneError extends Schema.TaggedError<InvalidTimeZoneError>(
  '@yokai/core/ScheduledTaskTime.InvalidTimeZoneError',
)('ScheduledTaskInvalidTimeZoneError', {
  timeZone: Schema.String,
}) {}

export class InvalidTimeExpressionError extends Schema.TaggedError<InvalidTimeExpressionError>(
  '@yokai/core/ScheduledTaskTime.InvalidTimeExpressionError',
)('ScheduledTaskInvalidTimeExpressionError', {
  expression: Schema.String,
  timeZone: Schema.String,
}) {}

export class DueTimeNotFutureError extends Schema.TaggedError<DueTimeNotFutureError>(
  '@yokai/core/ScheduledTaskTime.DueTimeNotFutureError',
)('ScheduledTaskDueTimeNotFutureError', {
  expression: Schema.String,
  now: Schema.Int,
}) {}

export interface ResolvedZone {
  readonly id: TimeZoneId
  readonly zone: DateTime.TimeZone.Named
}

const invalidExpression = (expression: TimeExpression, timeZone: TimeZoneId) =>
  new InvalidTimeExpressionError({ expression, timeZone })

const component = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : undefined
}

const zonedEpoch = (
  expression: TimeExpression,
  timeZone: TimeZoneId,
  zone: DateTime.TimeZone.Named,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): Effect.Effect<EpochMilliseconds, InvalidTimeExpressionError> => {
  const resolved = DateTime.makeZoned(
    { year, month, day, hour, minute, second, millisecond: 0 },
    { timeZone: zone, adjustForTimeZone: true, disambiguation: 'reject' },
  )
  return Option.match(resolved, {
    onNone: () => Effect.fail(invalidExpression(expression, timeZone)),
    onSome: (value) => Effect.succeed(EpochMilliseconds.make(DateTime.toEpochMillis(value))),
  })
}

const absolute = (
  expression: TimeExpression,
  now: EpochMilliseconds,
  resolvedZone: ResolvedZone,
): Effect.Effect<EpochMilliseconds, InvalidTimeExpressionError | DueTimeNotFutureError> =>
  Effect.gen(function* () {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(expression)
    if (match === null) return yield* Effect.fail(invalidExpression(expression, resolvedZone.id))
    const year = component(match[1])
    const month = component(match[2])
    const day = component(match[3])
    const hour = component(match[4])
    const minute = component(match[5])
    const second = component(match[6]) ?? 0
    if (
      year === undefined ||
      month === undefined ||
      day === undefined ||
      hour === undefined ||
      minute === undefined
    ) {
      return yield* Effect.fail(invalidExpression(expression, resolvedZone.id))
    }
    const dueAt = yield* zonedEpoch(
      expression,
      resolvedZone.id,
      resolvedZone.zone,
      year,
      month,
      day,
      hour,
      minute,
      second,
    )
    if (dueAt <= now) {
      return yield* Effect.fail(new DueTimeNotFutureError({ expression, now }))
    }
    return dueAt
  })

const wallClock = (
  expression: TimeExpression,
  now: EpochMilliseconds,
  resolvedZone: ResolvedZone,
): Effect.Effect<EpochMilliseconds, InvalidTimeExpressionError> =>
  Effect.gen(function* () {
    const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(expression)
    if (match === null) return yield* Effect.fail(invalidExpression(expression, resolvedZone.id))
    const hour = component(match[1])
    const minute = component(match[2])
    const second = component(match[3]) ?? 0
    if (hour === undefined || minute === undefined) {
      return yield* Effect.fail(invalidExpression(expression, resolvedZone.id))
    }
    const localNow = DateTime.setZone(DateTime.makeUnsafe(now), resolvedZone.zone)
    const today = DateTime.toParts(localNow)
    const targetMillis = ((hour * 60 + minute) * 60 + second) * 1_000
    const currentMillis =
      ((today.hour * 60 + today.minute) * 60 + today.second) * 1_000 + today.millisecond
    if (targetMillis <= currentMillis) {
      const tomorrow = DateTime.toParts(DateTime.add(localNow, { days: 1 }))
      return yield* zonedEpoch(
        expression,
        resolvedZone.id,
        resolvedZone.zone,
        tomorrow.year,
        tomorrow.month,
        tomorrow.day,
        hour,
        minute,
        second,
      )
    }
    const dueToday = yield* zonedEpoch(
      expression,
      resolvedZone.id,
      resolvedZone.zone,
      today.year,
      today.month,
      today.day,
      hour,
      minute,
      second,
    )
    return dueToday
  })

export const resolveZone = (
  timeZone: TimeZoneId,
): Effect.Effect<ResolvedZone, InvalidTimeZoneError> =>
  DateTime.zoneMakeNamedEffect(timeZone).pipe(
    Effect.map((zone) => ({ id: timeZone, zone })),
    Effect.mapError(() => new InvalidTimeZoneError({ timeZone })),
  )

export const parse = (
  expression: TimeExpression,
  now: EpochMilliseconds,
  resolvedZone: ResolvedZone,
): Effect.Effect<EpochMilliseconds, InvalidTimeExpressionError | DueTimeNotFutureError> =>
  expression.includes('T')
    ? absolute(expression, now, resolvedZone)
    : wallClock(expression, now, resolvedZone)

export const localIso = (at: EpochMilliseconds, resolvedZone: ResolvedZone): string =>
  DateTime.formatIsoZoned(DateTime.setZone(DateTime.makeUnsafe(at), resolvedZone.zone))

export * as ScheduledTaskTime from './time'
