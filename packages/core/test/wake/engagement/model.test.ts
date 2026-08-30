import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'

import { EngagementLease, WakeProposal } from '../../../src/index'

const validOptions = () => ({
  enabled: true,
  idleTtlMs: 1_000,
  maxDurationMs: 5_000,
  maxRounds: 3,
  debounceMs: 500,
  proposalTtlMs: 10_000,
})

it.effect('validates positive bounded lease options with Effect Schema', () =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(EngagementLease.Options)(validOptions())
    expect(decoded).toEqual(
      EngagementLease.Options.make({
        enabled: true,
        idleTtlMs: EngagementLease.PositiveDurationMilliseconds.make(1_000),
        maxDurationMs: EngagementLease.PositiveDurationMilliseconds.make(5_000),
        maxRounds: EngagementLease.RoundCount.make(3),
        debounceMs: WakeProposal.DurationMilliseconds.make(500),
        proposalTtlMs: EngagementLease.PositiveDurationMilliseconds.make(10_000),
      }),
    )

    const invalid = [
      { ...validOptions(), idleTtlMs: 0 },
      { ...validOptions(), maxDurationMs: 0 },
      { ...validOptions(), maxRounds: 0 },
      { ...validOptions(), maxRounds: 1.5 },
      { ...validOptions(), idleTtlMs: 5_001 },
      { ...validOptions(), proposalTtlMs: 500 },
    ]
    for (const candidate of invalid) {
      expect(
        yield* Schema.decodeUnknownEffect(EngagementLease.Options)(candidate).pipe(
          Effect.isFailure,
        ),
      ).toBe(true)
    }
  }),
)
