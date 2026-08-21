import type { Model } from '@google/genai'
import { expect, it } from '@effect/vitest'
import { AdapterId, AdapterModelSnapshot, ModelReference } from '@yokai/protocol'
import { DateTime, Effect, Schema } from 'effect'

import { decodeListing } from '../../src/discovery/model'

const ADAPTER_ID = AdapterId.make('gemini-discovery-test')
const DISCOVERED_AT = DateTime.makeUnsafe('2026-08-21T08:00:00.000Z')

it.effect('filters, normalizes, deduplicates, and stably sorts Gemini model metadata', () =>
  Effect.gen(function* () {
    const models: ReadonlyArray<Model> = [
      {
        name: 'models/z-model',
        displayName: 'Z first',
        inputTokenLimit: 1_000_000,
        outputTokenLimit: 8_192,
        supportedActions: ['streamGenerateContent', 'generateContent', 'generateContent'],
      },
      {
        name: 'models/embedding-only',
        displayName: 'Embedding only',
        supportedActions: ['embedContent'],
      },
      {
        name: 'a-model',
        displayName: 'Alpha first',
        supportedActions: ['generateContent'],
      },
      {
        name: 'models/a-model',
        displayName: 'Alpha duplicate',
        supportedActions: ['generateContent', 'countTokens'],
      },
      {
        name: 'models/B-model',
        displayName: 'Uppercase B',
        supportedActions: ['generateContent'],
      },
    ]

    const snapshot = yield* decodeListing(ADAPTER_ID, models, DISCOVERED_AT)
    yield* Schema.encodeEffect(AdapterModelSnapshot)(snapshot)

    expect(snapshot.models.map((model) => model.id)).toEqual(['B-model', 'a-model', 'z-model'])
    expect(snapshot.models.every((model) => model.availability === 'available')).toBe(true)
    expect(snapshot.models.every((model) => model.discoveryFreshness === 'fresh')).toBe(true)

    const alpha = snapshot.models.find((model) => model.id === 'a-model')
    if (alpha === undefined) return yield* Effect.die('Expected normalized a-model metadata')
    expect(alpha.displayName).toBe('Alpha first')
    expect(alpha.supportedGenerationMethods).toEqual(['generateContent'])

    const zeta = snapshot.models.find((model) => model.id === 'z-model')
    if (zeta === undefined) return yield* Effect.die('Expected normalized z-model metadata')
    expect(zeta.inputTokenLimit).toBe(1_000_000)
    expect(zeta.outputTokenLimit).toBe(8_192)
    expect(zeta.supportedGenerationMethods).toEqual(['generateContent', 'streamGenerateContent'])
    expect(
      yield* Schema.encodeEffect(ModelReference)({
        adapterId: ADAPTER_ID,
        modelId: zeta.id,
      }),
    ).toBe('gemini-discovery-test/z-model')
  }),
)

it.effect('keeps an absent method list absent by excluding the model', () =>
  Effect.gen(function* () {
    const snapshot = yield* decodeListing(
      ADAPTER_ID,
      [
        {
          name: 'models/no-methods',
          displayName: 'No methods',
        },
      ],
      DISCOVERED_AT,
    )

    expect(snapshot.models).toEqual([])
  }),
)

it.effect('maps malformed eligible model metadata to a safe protocol decode error', () => {
  const invalidModels: ReadonlyArray<Model> = [
    {
      displayName: 'Missing name',
      supportedActions: ['generateContent'],
    },
    {
      name: 'models/missing-display-name',
      supportedActions: ['generateContent'],
    },
    {
      name: 'models/invalid-limit',
      displayName: 'Invalid limit',
      inputTokenLimit: 0,
      supportedActions: ['generateContent'],
    },
    {
      name: 'models/',
      displayName: 'Empty normalized ID',
      supportedActions: ['generateContent'],
    },
  ]

  return Effect.forEach(
    invalidModels,
    (model) =>
      Effect.gen(function* () {
        const failure = yield* decodeListing(ADAPTER_ID, [model], DISCOVERED_AT).pipe(Effect.flip)
        expect(failure._tag).toBe('AdapterProtocolDecodeError')
        expect(failure.adapterId).toBe(ADAPTER_ID)
        expect(failure.operation).toBe('discoverModels')
        expect(failure.message).toBe('Gemini returned an invalid model discovery response')
      }),
    { discard: true },
  )
})
