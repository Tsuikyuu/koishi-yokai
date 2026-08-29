import { expect, it } from '@effect/vitest'
import { Effect, Result, Schema } from 'effect'

import {
  ActionTool,
  ActionToolInput,
  MAX_ACTION_TOOL_DESCRIPTION_LENGTH,
  MAX_ACTION_TOOL_XML_TEMPLATE_LENGTH,
} from '../../src/index'

const definition = {
  id: 'reaction.add',
  protocolVersion: { major: 1, minor: 0 },
  description: 'Add one reaction to the focused message.',
  xmlTemplate: '<action tool="reaction.add"><emoji>XML_ESCAPED_EMOJI</emoji></action>',
  inputSchema: {
    _tag: 'Object',
    properties: [
      {
        name: 'emoji',
        required: true,
        schema: { _tag: 'String', description: 'One reaction emoji.' },
      },
    ],
  },
  executionStage: 'before-send',
  completionPolicy: 'none',
  failurePolicy: 'block-reply',
  maxDurationMs: 250,
  isAvailable: () => true,
  isInputAllowed: () => true,
}

it.effect('decodes the complete static ActionTool registration contract', () =>
  Effect.gen(function* () {
    const tool = yield* Schema.decodeUnknownEffect(ActionTool)(definition)
    const input = yield* Schema.decodeUnknownEffect(ActionToolInput)({ emoji: '👻' })

    expect(tool.id).toBe('reaction.add')
    expect(tool.xmlTemplate).toBe(definition.xmlTemplate)
    expect(tool.inputSchema.properties.map((property) => property.name)).toEqual(['emoji'])
    expect(tool.executionStage).toBe('before-send')
    expect(tool.completionPolicy).toBe('none')
    expect(tool.failurePolicy).toBe('block-reply')
    expect(tool.maxDurationMs).toBe(250)
    expect(
      tool.isAvailable({
        instanceId: 'instance',
        platform: 'test',
        guildId: 'guild',
        channelId: 'channel',
      }),
    ).toBe(true)
    expect(
      tool.isInputAllowed(
        {
          instanceId: 'instance',
          platform: 'test',
          guildId: 'guild',
          channelId: 'channel',
        },
        input,
      ),
    ).toBe(true)
  }),
)

it.effect('exhaustively accepts the registered execution and outcome policy literals', () =>
  Effect.gen(function* () {
    const variants = [
      {
        executionStage: 'before-send',
        completionPolicy: 'none',
        failurePolicy: 'block-reply',
      },
      {
        executionStage: 'after-send',
        completionPolicy: 'none',
        failurePolicy: 'continue',
      },
      {
        executionStage: 'deferred',
        completionPolicy: 'wake',
        failurePolicy: 'continue',
      },
    ]

    const tools = yield* Effect.forEach(variants, (variant) =>
      Schema.decodeUnknownEffect(ActionTool)({ ...definition, ...variant }),
    )

    expect(tools.map((tool) => tool.executionStage)).toEqual([
      'before-send',
      'after-send',
      'deferred',
    ])
    expect(tools.map((tool) => tool.completionPolicy)).toEqual(['none', 'none', 'wake'])
    expect(tools.map((tool) => tool.failurePolicy)).toEqual(['block-reply', 'continue', 'continue'])
  }),
)

it.effect('rejects unknown policies and invalid duration or visibility contracts', () =>
  Effect.gen(function* () {
    const candidates = [
      { ...definition, executionStage: 'during-send' },
      { ...definition, completionPolicy: 'resume' },
      { ...definition, failurePolicy: 'retry' },
      { ...definition, maxDurationMs: 0 },
      { ...definition, maxDurationMs: 1.5 },
      { ...definition, isAvailable: true },
      { ...definition, isInputAllowed: true },
    ]
    const results = yield* Effect.forEach(candidates, (candidate) =>
      Schema.decodeUnknownEffect(ActionTool)(candidate).pipe(Effect.result),
    )

    expect(results.every(Result.isFailure)).toBe(true)
  }),
)

it.effect('rejects policies that cannot be honored at their execution stage', () =>
  Effect.gen(function* () {
    const candidates = [
      { ...definition, executionStage: 'after-send', failurePolicy: 'block-reply' },
      { ...definition, executionStage: 'deferred', failurePolicy: 'block-reply' },
      { ...definition, executionStage: 'before-send', completionPolicy: 'wake' },
      { ...definition, executionStage: 'after-send', completionPolicy: 'wake' },
    ]
    const results = yield* Effect.forEach(candidates, (candidate) =>
      Schema.decodeUnknownEffect(ActionTool)(candidate).pipe(Effect.result),
    )

    expect(results.every(Result.isFailure)).toBe(true)
  }),
)

it.effect('bounds ActionTool descriptions and static XML templates', () =>
  Effect.gen(function* () {
    const candidates = [
      { ...definition, description: '' },
      { ...definition, description: ' ' },
      { ...definition, description: 'description with trailing whitespace ' },
      { ...definition, description: 'x'.repeat(MAX_ACTION_TOOL_DESCRIPTION_LENGTH + 1) },
      { ...definition, xmlTemplate: '' },
      { ...definition, xmlTemplate: ' <action tool="reaction.add"></action>' },
      { ...definition, xmlTemplate: 'x'.repeat(MAX_ACTION_TOOL_XML_TEMPLATE_LENGTH + 1) },
    ]
    const results = yield* Effect.forEach(candidates, (candidate) =>
      Schema.decodeUnknownEffect(ActionTool)(candidate).pipe(Effect.result),
    )

    expect(results.every(Result.isFailure)).toBe(true)
  }),
)
