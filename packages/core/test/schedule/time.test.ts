import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { ScheduledTaskModel, ScheduledTaskTime } from '../../src/index'

const epoch = (value: string): ScheduledTaskModel.EpochMilliseconds =>
  ScheduledTaskModel.EpochMilliseconds.make(Date.parse(value))

it.effect('resolves absolute local time through the configured IANA zone', () =>
  Effect.gen(function* () {
    const zone = yield* ScheduledTaskTime.resolveZone(
      ScheduledTaskModel.TimeZoneId.make('Asia/Shanghai'),
    )
    const dueAt = yield* ScheduledTaskTime.parse(
      ScheduledTaskModel.TimeExpression.make('2025-01-02T08:30:15'),
      epoch('2025-01-01T00:00:00.000Z'),
      zone,
    )

    expect(dueAt).toBe(Date.parse('2025-01-02T00:30:15.000Z'))
    expect(ScheduledTaskTime.localIso(dueAt, zone)).toContain(
      '2025-01-02T08:30:15.000+08:00[Asia/Shanghai]',
    )
  }),
)

it.effect('moves a passed wall-clock time to the next local calendar day', () =>
  Effect.gen(function* () {
    const zone = yield* ScheduledTaskTime.resolveZone(
      ScheduledTaskModel.TimeZoneId.make('Asia/Shanghai'),
    )
    const dueAt = yield* ScheduledTaskTime.parse(
      ScheduledTaskModel.TimeExpression.make('00:30'),
      epoch('2025-01-01T15:59:00.000Z'),
      zone,
    )

    expect(dueAt).toBe(Date.parse('2025-01-01T16:30:00.000Z'))
  }),
)

it.effect('rejects future nonexistent and ambiguous DST wall-clock times', () =>
  Effect.gen(function* () {
    const zone = yield* ScheduledTaskTime.resolveZone(
      ScheduledTaskModel.TimeZoneId.make('America/New_York'),
    )
    const gap = yield* ScheduledTaskTime.parse(
      ScheduledTaskModel.TimeExpression.make('2025-03-09T02:30'),
      epoch('2025-03-01T00:00:00.000Z'),
      zone,
    ).pipe(Effect.flip)
    const overlap = yield* ScheduledTaskTime.parse(
      ScheduledTaskModel.TimeExpression.make('2025-11-02T01:30'),
      epoch('2025-11-01T00:00:00.000Z'),
      zone,
    ).pipe(Effect.flip)
    const timeOnlyGap = yield* ScheduledTaskTime.parse(
      ScheduledTaskModel.TimeExpression.make('02:30'),
      epoch('2025-03-09T05:30:00.000Z'),
      zone,
    ).pipe(Effect.flip)
    const timeOnlyOverlap = yield* ScheduledTaskTime.parse(
      ScheduledTaskModel.TimeExpression.make('01:30'),
      epoch('2025-11-02T04:30:00.000Z'),
      zone,
    ).pipe(Effect.flip)

    expect(gap._tag).toBe('ScheduledTaskInvalidTimeExpressionError')
    expect(overlap._tag).toBe('ScheduledTaskInvalidTimeExpressionError')
    expect(timeOnlyGap._tag).toBe('ScheduledTaskInvalidTimeExpressionError')
    expect(timeOnlyOverlap._tag).toBe('ScheduledTaskInvalidTimeExpressionError')
  }),
)

it.effect('moves already-passed DST gap and overlap wall times to the next valid day', () =>
  Effect.gen(function* () {
    const zone = yield* ScheduledTaskTime.resolveZone(
      ScheduledTaskModel.TimeZoneId.make('America/New_York'),
    )
    const afterGap = yield* ScheduledTaskTime.parse(
      ScheduledTaskModel.TimeExpression.make('02:30'),
      epoch('2025-03-09T07:30:00.000Z'),
      zone,
    )
    const afterOverlap = yield* ScheduledTaskTime.parse(
      ScheduledTaskModel.TimeExpression.make('01:30'),
      epoch('2025-11-02T07:30:00.000Z'),
      zone,
    )

    expect(afterGap).toBe(Date.parse('2025-03-10T06:30:00.000Z'))
    expect(afterOverlap).toBe(Date.parse('2025-11-03T06:30:00.000Z'))
  }),
)

it.effect('types invalid zones and past absolute times', () =>
  Effect.gen(function* () {
    const invalidZone = yield* ScheduledTaskTime.resolveZone(
      ScheduledTaskModel.TimeZoneId.make('Mars/Olympus'),
    ).pipe(Effect.flip)
    expect(invalidZone._tag).toBe('ScheduledTaskInvalidTimeZoneError')

    const zone = yield* ScheduledTaskTime.resolveZone(ScheduledTaskModel.TimeZoneId.make('UTC'))
    const past = yield* ScheduledTaskTime.parse(
      ScheduledTaskModel.TimeExpression.make('2025-01-01T00:00'),
      epoch('2025-01-01T00:00:00.000Z'),
      zone,
    ).pipe(Effect.flip)
    expect(past._tag).toBe('ScheduledTaskDueTimeNotFutureError')
  }),
)
