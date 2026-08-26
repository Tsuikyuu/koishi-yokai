import { Data, DateTime, HashMap, Option } from 'effect'

import {
  BudgetExceededError,
  CallCount,
  type Category,
  type ClassifiedLimits,
  ClassifiedUsage,
  DayWindowSnapshot,
  EpochMilliseconds,
  LocalDate,
  MinuteWindowSnapshot,
  type Options,
  Reservation,
  type ReservationId,
  ReservationId as ReservationIdSchema,
  Snapshot,
  Usage,
  type WindowLimits,
} from './model'

interface Counter {
  readonly pending: number
  readonly committed: number
}

interface ClassifiedCounters {
  readonly reserved: Counter
  readonly normal: Counter
  readonly background: Counter
}

interface MinuteWindowState {
  readonly startedAt: EpochMilliseconds
  readonly counters: ClassifiedCounters
}

interface DayWindowState {
  readonly localDate: LocalDate
  readonly counters: ClassifiedCounters
}

export interface State {
  readonly nextReservationSequence: number
  readonly minute: MinuteWindowState
  readonly day: DayWindowState
  readonly reservations: HashMap.HashMap<ReservationId, Reservation>
}

export type ReserveDecision = Data.TaggedEnum<{
  Granted: { readonly reservation: Reservation }
  Denied: { readonly error: BudgetExceededError }
}>

export const ReserveDecision = Data.taggedEnum<ReserveDecision>()

export type Disposition = 'commit' | 'release'

const emptyCounter = (): Counter => ({ pending: 0, committed: 0 })

const emptyClassifiedCounters = (): ClassifiedCounters => ({
  reserved: emptyCounter(),
  normal: emptyCounter(),
  background: emptyCounter(),
})

const minuteWindowStartedAt = (now: number): EpochMilliseconds =>
  EpochMilliseconds.make(Math.floor(now / 60_000) * 60_000)

const dayWindowLocalDate = (now: number, timeZone: DateTime.TimeZone): LocalDate =>
  LocalDate.make(DateTime.formatIsoDate(DateTime.setZone(DateTime.makeUnsafe(now), timeZone)))

export const initialState = (options: Options, now: number): State => ({
  nextReservationSequence: 1,
  minute: {
    startedAt: minuteWindowStartedAt(now),
    counters: emptyClassifiedCounters(),
  },
  day: {
    localDate: dayWindowLocalDate(now, options.timeZone),
    counters: emptyClassifiedCounters(),
  },
  reservations: HashMap.empty(),
})

const normalizeWindows = (state: State, options: Options, now: number): State => {
  const startedAt = minuteWindowStartedAt(now)
  const localDate = dayWindowLocalDate(now, options.timeZone)
  const minute =
    state.minute.startedAt === startedAt
      ? state.minute
      : { startedAt, counters: emptyClassifiedCounters() }
  const day =
    state.day.localDate === localDate
      ? state.day
      : { localDate, counters: emptyClassifiedCounters() }

  return minute === state.minute && day === state.day ? state : { ...state, minute, day }
}

const counterFor = (counters: ClassifiedCounters, category: Category): Counter => {
  switch (category) {
    case 'reserved':
      return counters.reserved
    case 'normal':
      return counters.normal
    case 'background':
      return counters.background
  }
}

const withCounter = (
  counters: ClassifiedCounters,
  category: Category,
  counter: Counter,
): ClassifiedCounters => {
  switch (category) {
    case 'reserved':
      return { ...counters, reserved: counter }
    case 'normal':
      return { ...counters, normal: counter }
    case 'background':
      return { ...counters, background: counter }
  }
}

const limitsFor = (limits: ClassifiedLimits, category: Category): WindowLimits => {
  switch (category) {
    case 'reserved':
      return limits.reserved
    case 'normal':
      return limits.normal
    case 'background':
      return limits.background
  }
}

const occupied = (counter: Counter): number => counter.pending + counter.committed

const exceeded = (
  category: Category,
  window: 'minute' | 'day',
  counter: Counter,
  limit: CallCount,
): BudgetExceededError | undefined =>
  occupied(counter) >= limit
    ? new BudgetExceededError({
        category,
        window,
        used: CallCount.make(occupied(counter)),
        limit,
      })
    : undefined

const reserveCounter = (counters: ClassifiedCounters, category: Category): ClassifiedCounters => {
  const current = counterFor(counters, category)
  return withCounter(counters, category, { ...current, pending: current.pending + 1 })
}

export const reserve = (
  state: State,
  options: Options,
  category: Category,
  now: number,
): readonly [ReserveDecision, State] => {
  const current = normalizeWindows(state, options, now)
  const limits = limitsFor(options.limits, category)
  const minuteError = exceeded(
    category,
    'minute',
    counterFor(current.minute.counters, category),
    limits.minute,
  )
  if (minuteError !== undefined) return [ReserveDecision.Denied({ error: minuteError }), current]

  const dayError = exceeded(category, 'day', counterFor(current.day.counters, category), limits.day)
  if (dayError !== undefined) return [ReserveDecision.Denied({ error: dayError }), current]

  const id = ReservationIdSchema.make(`call-${current.nextReservationSequence}`)
  const reservation = Reservation.make({
    id,
    category,
    reservedAt: EpochMilliseconds.make(now),
    minuteWindowStartedAt: current.minute.startedAt,
    dayWindowLocalDate: current.day.localDate,
  })

  return [
    ReserveDecision.Granted({ reservation }),
    {
      nextReservationSequence: current.nextReservationSequence + 1,
      minute: {
        ...current.minute,
        counters: reserveCounter(current.minute.counters, category),
      },
      day: {
        ...current.day,
        counters: reserveCounter(current.day.counters, category),
      },
      reservations: HashMap.set(current.reservations, id, reservation),
    },
  ]
}

const settleCounter = (counter: Counter, disposition: Disposition): Counter => ({
  pending: Math.max(0, counter.pending - 1),
  committed: disposition === 'commit' ? counter.committed + 1 : counter.committed,
})

const settleClassifiedCounters = (
  counters: ClassifiedCounters,
  category: Category,
  disposition: Disposition,
): ClassifiedCounters =>
  withCounter(counters, category, settleCounter(counterFor(counters, category), disposition))

export const settle = (
  state: State,
  options: Options,
  reservationId: ReservationId,
  disposition: Disposition,
  now: number,
): readonly [boolean, State] => {
  const current = normalizeWindows(state, options, now)
  const reservation = HashMap.get(current.reservations, reservationId)
  if (Option.isNone(reservation)) return [false, current]

  const minute =
    current.minute.startedAt === reservation.value.minuteWindowStartedAt
      ? {
          ...current.minute,
          counters: settleClassifiedCounters(
            current.minute.counters,
            reservation.value.category,
            disposition,
          ),
        }
      : current.minute
  const day =
    current.day.localDate === reservation.value.dayWindowLocalDate
      ? {
          ...current.day,
          counters: settleClassifiedCounters(
            current.day.counters,
            reservation.value.category,
            disposition,
          ),
        }
      : current.day

  return [
    true,
    {
      ...current,
      minute,
      day,
      reservations: HashMap.remove(current.reservations, reservationId),
    },
  ]
}

const usage = (counter: Counter, limit: CallCount): Usage =>
  Usage.make({
    limit,
    pending: CallCount.make(counter.pending),
    committed: CallCount.make(counter.committed),
    remaining: CallCount.make(Math.max(0, limit - occupied(counter))),
  })

const classifiedUsage = (
  counters: ClassifiedCounters,
  limits: ClassifiedLimits,
  window: 'minute' | 'day',
): ClassifiedUsage =>
  ClassifiedUsage.make({
    reserved: usage(counters.reserved, limits.reserved[window]),
    normal: usage(counters.normal, limits.normal[window]),
    background: usage(counters.background, limits.background[window]),
  })

export const snapshot = (
  state: State,
  options: Options,
  now: number,
): readonly [Snapshot, State] => {
  const current = normalizeWindows(state, options, now)
  return [
    Snapshot.make({
      minute: MinuteWindowSnapshot.make({
        startedAt: current.minute.startedAt,
        usage: classifiedUsage(current.minute.counters, options.limits, 'minute'),
      }),
      day: DayWindowSnapshot.make({
        localDate: current.day.localDate,
        usage: classifiedUsage(current.day.counters, options.limits, 'day'),
      }),
    }),
    current,
  ]
}
