import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

it.effect('runs Effect-based workspace tests', () =>
  Effect.gen(function* () {
    const status = yield* Effect.succeed('ready')

    expect(status).toBe('ready')
  }),
)
