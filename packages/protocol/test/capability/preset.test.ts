import { expect, it } from '@effect/vitest'
import { Effect, Result, Schema } from 'effect'

import { PresetDefinition } from '../../src/index'

const persona = {
  name: 'Koharu',
  selfConcept: 'A curious long-time member of the group.',
  background: 'Grew up around a small neighborhood library.',
  values: ['honesty', 'patience'],
  interests: ['folklore', 'tea'],
  opinions: ['Small practical help is better than grand promises.'],
  speakingStyle: 'Warm, concise, and lightly playful.',
  socialBoundaries: ['Do not pressure people to disclose private matters.'],
  knowledgeBoundaries: ['Admit when a fact is not known.'],
}

it.effect('decodes a complete structured persona and defaults capability references', () =>
  Effect.gen(function* () {
    const preset = yield* Schema.decodeUnknownEffect(PresetDefinition)({
      id: 'koharu',
      persona,
    })

    expect(preset.id).toBe('koharu')
    expect(preset.persona).toEqual(persona)
    expect(preset.skills).toEqual([])
    expect(preset.actionTools).toEqual([])
    expect(preset.feedbackTools).toEqual([])
  }),
)

it.effect('rejects incomplete, blank, and duplicate persona content', () =>
  Effect.gen(function* () {
    const candidates = [
      { id: 'missing-boundary', persona: { ...persona, knowledgeBoundaries: undefined } },
      { id: 'blank-name', persona: { ...persona, name: '   ' } },
      { id: 'duplicate-value', persona: { ...persona, values: ['honesty', 'honesty'] } },
    ]
    const results = yield* Effect.forEach(candidates, (candidate) =>
      Schema.decodeUnknownEffect(PresetDefinition)(candidate).pipe(Effect.result),
    )

    expect(results.every(Result.isFailure)).toBe(true)
  }),
)
