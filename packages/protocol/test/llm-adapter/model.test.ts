import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'

import { AdapterModelSnapshot } from '../../src/llm-adapter/model'

const discoveredAt = '2026-08-20T04:00:00.000Z'

it.effect('round-trips immutable discovery data while preserving absent metadata', () =>
  Effect.gen(function* () {
    const encoded = {
      discoveredAt,
      models: [
        {
          id: 'connection-a/models/flash',
          displayName: 'Flash',
          availability: 'available',
          discoveryFreshness: 'stale',
        },
        {
          id: 'connection-a/models/pro',
          displayName: 'Pro',
          availability: 'available',
          discoveryFreshness: 'fresh',
          inputTokenLimit: 1_000_000,
          outputTokenLimit: 65_536,
          supportedGenerationMethods: ['generateContent'],
        },
      ],
    }

    const snapshot = yield* Schema.decodeUnknownEffect(AdapterModelSnapshot)(encoded)
    const first = snapshot.models[0]
    expect(first).toBeDefined()
    if (first === undefined) return
    expect(first.inputTokenLimit).toBeUndefined()
    expect(first.supportedGenerationMethods).toBeUndefined()
    expect(yield* Schema.encodeEffect(AdapterModelSnapshot)(snapshot)).toEqual(encoded)
  }),
)

it.effect('rejects duplicate, unstable, or invalid discovered models', () =>
  Effect.gen(function* () {
    const model = {
      id: 'connection-a/models/flash',
      displayName: 'Flash',
      availability: 'available',
      discoveryFreshness: 'fresh',
    }
    const errors = yield* Effect.all(
      [
        { discoveredAt, models: [model, model] },
        {
          discoveredAt,
          models: [
            { ...model, id: 'z-model' },
            { ...model, id: 'a-model' },
          ],
        },
        { discoveredAt, models: [{ ...model, inputTokenLimit: 0 }] },
        {
          discoveredAt,
          models: [{ ...model, outputTokenLimit: Number.MAX_SAFE_INTEGER + 1 }],
        },
        {
          discoveredAt,
          models: [
            {
              ...model,
              supportedGenerationMethods: ['streamGenerateContent', 'generateContent'],
            },
          ],
        },
      ].map((input) => Schema.decodeUnknownEffect(AdapterModelSnapshot)(input).pipe(Effect.flip)),
    )

    expect(errors.every(Schema.isSchemaError)).toBe(true)
  }),
)
