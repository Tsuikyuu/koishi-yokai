import { expect, it } from '@effect/vitest'
import { Effect, Result, Schema } from 'effect'

import {
  MAX_LOCAL_SELECTION_KEYWORDS,
  MAX_SKILL_CAPABILITY_REFERENCES,
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_PROMPT_LENGTH,
  Skill,
} from '../../src/index'

const definition = {
  id: 'calendar',
  protocolVersion: { major: 0, minor: 1 },
  description: 'Use locally cached calendar capabilities when they are relevant.',
  prompt: 'Reason about dates carefully and preserve the configured time zone.',
  selection: {
    _tag: 'MatchAny',
    keywords: ['calendar', 'schedule'],
    responseMechanisms: ['schedule'],
    eventKinds: ['schedule'],
  },
  contextProviders: ['schedule.context'],
  actionTools: ['schedule.create'],
  feedbackTools: ['schedule.query'],
}

it.effect('decodes a complete locally selectable Skill bundle', () =>
  Effect.gen(function* () {
    const skill = yield* Schema.decodeUnknownEffect(Skill)(definition)

    expect(skill.id).toBe('calendar')
    expect(skill.selection).toEqual(definition.selection)
    expect(skill.contextProviders).toEqual(['schedule.context'])
    expect(skill.actionTools).toEqual(['schedule.create'])
    expect(skill.feedbackTools).toEqual(['schedule.query'])
  }),
)

it.effect('accepts an explicit always-selected Skill', () =>
  Effect.gen(function* () {
    const skill = yield* Schema.decodeUnknownEffect(Skill)({
      ...definition,
      selection: { _tag: 'Always' },
    })

    expect(skill.selection).toEqual({ _tag: 'Always' })
  }),
)

it.effect('rejects empty, malformed, duplicate, and oversized Skill selection data', () =>
  Effect.gen(function* () {
    const candidates = [
      {
        ...definition,
        selection: { _tag: 'MatchAny', keywords: [], responseMechanisms: [], eventKinds: [] },
      },
      {
        ...definition,
        selection: {
          _tag: 'MatchAny',
          keywords: [' calendar'],
          responseMechanisms: [],
          eventKinds: [],
        },
      },
      {
        ...definition,
        selection: {
          _tag: 'MatchAny',
          keywords: ['calendar', 'calendar'],
          responseMechanisms: [],
          eventKinds: [],
        },
      },
      {
        ...definition,
        selection: {
          _tag: 'MatchAny',
          keywords: Array.from(
            { length: MAX_LOCAL_SELECTION_KEYWORDS + 1 },
            (_, index) => `keyword-${String(index)}`,
          ),
          responseMechanisms: [],
          eventKinds: [],
        },
      },
      {
        ...definition,
        selection: {
          _tag: 'MatchAny',
          keywords: [],
          responseMechanisms: [],
          eventKinds: ['direct', 'direct'],
        },
      },
    ]
    const results = yield* Effect.forEach(candidates, (candidate) =>
      Schema.decodeUnknownEffect(Skill)(candidate).pipe(Effect.result),
    )

    expect(results.every(Result.isFailure)).toBe(true)
  }),
)

it.effect('bounds Skill prompt metadata and bundled capability references', () =>
  Effect.gen(function* () {
    const candidates = [
      { ...definition, description: 'x'.repeat(MAX_SKILL_DESCRIPTION_LENGTH + 1) },
      { ...definition, prompt: 'x'.repeat(MAX_SKILL_PROMPT_LENGTH + 1) },
      { ...definition, actionTools: ['duplicate', 'duplicate'] },
      {
        ...definition,
        contextProviders: Array.from(
          { length: MAX_SKILL_CAPABILITY_REFERENCES + 1 },
          (_, index) => `provider-${String(index)}`,
        ),
      },
    ]
    const results = yield* Effect.forEach(candidates, (candidate) =>
      Schema.decodeUnknownEffect(Skill)(candidate).pipe(Effect.result),
    )

    expect(results.every(Result.isFailure)).toBe(true)
  }),
)
