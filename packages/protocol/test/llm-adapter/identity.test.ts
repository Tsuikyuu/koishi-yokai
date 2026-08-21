import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'

import { AdapterId, ModelReference } from '../../src/llm-adapter/identity'

it.effect('round-trips a model reference by splitting only the first slash', () =>
  Effect.gen(function* () {
    const encoded = 'gemini/models/gemini-2.5-flash'
    const reference = yield* Schema.decodeUnknownEffect(ModelReference)(encoded)

    expect(reference.adapterId).toBe('gemini')
    expect(reference.modelId).toBe('models/gemini-2.5-flash')
    expect(yield* Schema.encodeEffect(ModelReference)(reference)).toBe(encoded)
  }),
)

it.effect('rejects empty or structurally invalid IDs and references', () =>
  Effect.gen(function* () {
    const adapterIdErrors = yield* Effect.all(
      ['', 'gemini/secondary', 'gemini adapter', 'gemini\u0000'].map((input) =>
        Schema.decodeUnknownEffect(AdapterId)(input).pipe(Effect.flip),
      ),
    )
    const modelReferenceErrors = yield* Effect.all(
      ['gemini', '/model', 'gemini/', 'gemini/ model '].map((input) =>
        Schema.decodeUnknownEffect(ModelReference)(input).pipe(Effect.flip),
      ),
    )

    expect(adapterIdErrors.every(Schema.isSchemaError)).toBe(true)
    expect(modelReferenceErrors.every(Schema.isSchemaError)).toBe(true)
  }),
)
