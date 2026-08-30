import { RoleResponseEnvelope } from '@yokai-internal/mind'
import { expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'

import { MessagePacing } from '../../src/index'

const message = (content: string): RoleResponseEnvelope.ResponseMessage =>
  RoleResponseEnvelope.ResponseMessage.make({ content, quote: Option.none() })

it.effect('returns a zero-delay plan when there are no message segments', () =>
  Effect.sync(() => {
    const plan = MessagePacing.plan('initiative', [])

    expect(plan).toEqual({ firstDelayMs: 0, betweenDelayMs: [], totalDelayMs: 0 })
  }),
)

it.effect('applies the wake scenario base delay to the same message content', () =>
  Effect.sync(() => {
    const content = [message('hey')]

    expect({
      direct: MessagePacing.plan('direct', content).firstDelayMs,
      schedule: MessagePacing.plan('schedule', content).firstDelayMs,
      engagement: MessagePacing.plan('engagement', content).firstDelayMs,
      activity: MessagePacing.plan('activity', content).firstDelayMs,
      initiative: MessagePacing.plan('initiative', content).firstDelayMs,
    }).toEqual({
      direct: 49,
      schedule: 69,
      engagement: 89,
      activity: 129,
      initiative: 169,
    })
  }),
)

it.effect('counts Unicode code points and caps the content-based first delay', () =>
  Effect.sync(() => {
    expect(MessagePacing.plan('direct', [message('A👻中')]).firstDelayMs).toBe(49)
    expect(MessagePacing.plan('direct', [message('👻'.repeat(100))]).firstDelayMs).toBe(280)
  }),
)

it.effect('keeps adjacent segment delays in document order and includes each in the total', () =>
  Effect.sync(() => {
    const plan = MessagePacing.plan('direct', [message('a'), message('bbbb'), message('cc')])

    expect(plan.firstDelayMs).toBe(43)
    expect(plan.betweenDelayMs).toEqual([76, 80])
    expect(plan.totalDelayMs).toBe(199)
    expect(plan.totalDelayMs).toBe(
      plan.firstDelayMs + plan.betweenDelayMs.reduce((total, delay) => total + delay, 0),
    )
  }),
)
