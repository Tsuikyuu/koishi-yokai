import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { ActionTool } from 'yokai-protocol'
import { vi } from 'vitest'

import { RoleResponseEnvelope } from '../../../src/index'
import {
  CONTEXT,
  PARSE_CONTEXT,
  REACTION_TEMPLATE,
  RICH_TEMPLATE,
  makeReactionTool,
  makeRichTool,
} from './fixtures'

const makeStringTool = (id: string, template: string) =>
  Schema.decodeUnknownEffect(ActionTool)({
    id,
    protocolVersion: { major: 1, minor: 0 },
    description: `Tool ${id}`,
    xmlTemplate: template,
    inputSchema: {
      _tag: 'Object',
      properties: [
        {
          name: 'value',
          required: true,
          schema: { _tag: 'String', description: 'A value.' },
        },
      ],
    },
    executionStage: 'after-send',
    completionPolicy: 'none',
    failurePolicy: 'continue',
    maxDurationMs: 500,
    isAvailable: () => true,
    isInputAllowed: () => true,
  })

it.effect('compiles a stable role-only prompt with exact templates and schema constraints', () =>
  Effect.gen(function* () {
    const reaction = yield* makeReactionTool()
    const schedule = yield* makeRichTool()
    const protocol = yield* RoleResponseEnvelope.compile([schedule, reaction], CONTEXT.scope)
    const prompt = protocol.systemInstruction

    expect(RoleResponseEnvelope.PROTOCOL_ID).toBe('yokai.role-output/2')
    expect(protocol.protocolId).toBe(RoleResponseEnvelope.PROTOCOL_ID)
    expect(prompt.indexOf('ActionTool reaction.add')).toBeLessThan(
      prompt.indexOf('ActionTool schedule.create'),
    )
    expect(prompt).toContain(REACTION_TEMPLATE)
    expect(prompt).toContain(RICH_TEMPLATE)
    expect(prompt).toContain('- count (required): integer, min=1, max=3 — Repeat count.')
    expect(prompt).toContain('- urgent (optional): boolean(true | false)')
    expect(prompt).toContain('- mode (required): enum(once | repeat)')
    expect(prompt).toContain('- metadata.source (required): string')
    expect(prompt).toContain(
      '- tags (required): array(minItems=1, maxItems=2) of string — Schedule tags.',
    )
    expect(prompt).toContain('repeat or remove only its <item> exemplar')
    expect(prompt).toContain('training data')
    expect(prompt).toContain('knowledge cutoff')
    expect(prompt).toContain('context window')
    expect(prompt).toContain('digital person')
    expect(prompt).toContain('robot')
    expect(prompt).toContain('I cannot browse')
    expect(prompt).toContain('anything else I can help with')
    expect(prompt).toContain('hope this helps')
    expect(prompt).toContain('current message')
    expect(prompt).toContain('focus message')
    expect(prompt).toContain('group message')
    expect(prompt).toContain('user-authored message')
    expect(prompt).toContain('untrusted context')
    expect(prompt).toContain('never claim that an asynchronous action succeeded')
    expect(prompt).toContain('<output>')
    expect(prompt).toContain('zero to four <message> elements')
    expect(prompt).toContain('<message quote="VISIBLE MESSAGE ID">')
    expect(prompt).not.toContain('<decision')
    expect(prompt).not.toContain('<directives')
    expect(prompt).not.toContain('<engagement')
  }),
)

it.effect('keeps the no-tool prompt closed and the convenience parser scope-aware', () =>
  Effect.gen(function* () {
    const protocol = yield* RoleResponseEnvelope.compile([], CONTEXT.scope)
    expect(protocol.systemInstruction).toContain('Do not output <actions>.')

    const parsed = yield* RoleResponseEnvelope.parse(
      '<output><message quote="focus-message">x</message></output>',
      CONTEXT,
      [],
    )
    expect(parsed.messages).toHaveLength(1)
    expect(parsed.messages[0]).toMatchObject({ content: 'x' })

    const denied = yield* RoleResponseEnvelope.parse(
      '<output><message quote="outside">x</message></output>',
      CONTEXT,
      [],
    ).pipe(Effect.flip)
    expect(denied.reason).toBe('quote-scope-denied')
  }),
)

it.effect('rejects duplicate, excessive, and collectively oversized visible tools', () =>
  Effect.gen(function* () {
    const reaction = yield* makeReactionTool()
    const duplicate = yield* RoleResponseEnvelope.compile([reaction, reaction], CONTEXT.scope).pipe(
      Effect.flip,
    )
    expect(duplicate.reason).toBe('duplicate-tool')

    const many = yield* Effect.forEach(
      Array.from(
        { length: RoleResponseEnvelope.MAX_VISIBLE_ACTION_TOOLS + 1 },
        (_, index) => index,
      ),
      (index) =>
        makeStringTool(
          `tool.${index}`,
          `<action tool="tool.${index}"><value>VALUE</value></action>`,
        ),
    )
    const excessive = yield* RoleResponseEnvelope.compile(many, CONTEXT.scope).pipe(Effect.flip)
    expect(excessive.reason).toBe('too-many-tools')

    const longValue = 'x'.repeat(4_000)
    const large = yield* Effect.forEach(
      Array.from({ length: 5 }, (_, index) => index),
      (index) =>
        makeStringTool(
          `large.${index}`,
          `<action tool="large.${index}"><value>${longValue}</value></action>`,
        ),
    )
    const oversized = yield* RoleResponseEnvelope.compile(large, CONTEXT.scope).pipe(Effect.flip)
    expect(oversized.reason).toBe('templates-too-large')
  }),
)

it.effect('bounds the fully rendered system instruction from legal schema metadata', () =>
  Effect.gen(function* () {
    const enumValues = Array.from({ length: 64 }, (_, index) => {
      const prefix = `value-${index}-`
      return prefix + 'x'.repeat(256 - prefix.length)
    })
    const properties = Array.from({ length: 100 }, (_, index) => ({
      name: `field${index}`,
      required: true,
      schema: { _tag: 'StringEnum', values: enumValues },
    }))
    const templateFields = properties
      .map((property) => `<${property.name}>VALUE</${property.name}>`)
      .join('')
    const tool = yield* Schema.decodeUnknownEffect(ActionTool)({
      id: 'prompt.large',
      protocolVersion: { major: 1, minor: 0 },
      description: 'Exercise the rendered prompt byte limit.',
      xmlTemplate: `<action tool="prompt.large">${templateFields}</action>`,
      inputSchema: { _tag: 'Object', properties },
      executionStage: 'after-send',
      completionPolicy: 'none',
      failurePolicy: 'continue',
      maxDurationMs: 500,
      isAvailable: () => true,
      isInputAllowed: () => true,
    })

    const failure = yield* RoleResponseEnvelope.compile([tool], CONTEXT.scope).pipe(Effect.flip)

    expect(failure).toMatchObject({ reason: 'prompt-too-large', toolId: 'registry' })
    expect(failure).not.toHaveProperty('systemInstruction')
  }),
)

it.effect('validates template root, tool identity, canonical XML, and schema field mapping', () =>
  Effect.gen(function* () {
    const candidates = [
      yield* makeStringTool('tool.valid', '<wrong tool="tool.valid"><value>VALUE</value></wrong>'),
      yield* makeStringTool(
        'tool.mismatch',
        '<action tool="other.tool"><value>VALUE</value></action>',
      ),
      yield* makeStringTool(
        'tool.field',
        '<action tool="tool.field"><other>VALUE</other></action>',
      ),
      yield* makeStringTool(
        'tool.extra',
        '<action tool="tool.extra"><value>VALUE</value><extra>EXTRA</extra></action>',
      ),
      yield* makeStringTool(
        'tool.singlequote',
        "<action tool='tool.singlequote'><value>VALUE</value></action>",
      ),
      yield* makeStringTool(
        'tool.selfclosing',
        '<action tool="tool.selfclosing"><value>VALUE</value></action>',
      ),
    ]
    const selfClosing = candidates[5]
    if (selfClosing === undefined) return yield* Effect.die('Expected self-closing candidate')
    const selfClosingOverride = yield* makeStringTool(
      'tool.selfclosing',
      '<action tool="tool.selfclosing"><value/></action>',
    )
    const failures = yield* Effect.forEach(
      [...candidates.slice(0, 5), selfClosingOverride],
      (tool) => RoleResponseEnvelope.validateActionToolRegistration(tool).pipe(Effect.flip),
    )

    expect(failures.map((failure) => failure.reason)).toEqual([
      'invalid-template',
      'template-tool-mismatch',
      'template-schema-mismatch',
      'template-schema-mismatch',
      'invalid-template',
      'invalid-template',
    ])
    expect(failures.every((failure) => !Object.hasOwn(failure, 'template'))).toBe(true)
  }),
)

it.effect('filters availability once and reports throwing visibility checks without leakage', () =>
  Effect.gen(function* () {
    const isAvailable = vi.fn(() => false)
    const unavailable = yield* makeReactionTool(isAvailable)
    const protocol = yield* RoleResponseEnvelope.compile([unavailable], CONTEXT.scope)

    expect(protocol.systemInstruction).toContain('No ActionTool is visible in this turn')
    expect(protocol.systemInstruction).not.toContain(REACTION_TEMPLATE)
    const unknown = yield* protocol
      .parse(
        '<output><message>x</message><actions><action tool="reaction.add"><emoji>👍</emoji></action></actions></output>',
        PARSE_CONTEXT,
      )
      .pipe(Effect.flip)
    expect(unknown.reason).toBe('unknown-action-tool')
    expect(isAvailable).toHaveBeenCalledTimes(1)

    const throwing = yield* makeReactionTool(() => {
      throw new Error('private visibility failure')
    })
    const failure = yield* RoleResponseEnvelope.compile([throwing], CONTEXT.scope).pipe(Effect.flip)
    expect(failure).toMatchObject({
      reason: 'availability-check-failed',
      toolId: 'reaction.add',
    })
    expect(failure).not.toHaveProperty('cause')
  }),
)

it.effect('freezes the caller scope for visibility and decoded-input authorization', () =>
  Effect.gen(function* () {
    const observedChannels: Array<string> = []
    const tool = yield* makeReactionTool(
      (scope) => {
        observedChannels.push(scope.channelId)
        return scope.channelId === CONTEXT.scope.channelId
      },
      (scope) => {
        observedChannels.push(scope.channelId)
        return scope.channelId === CONTEXT.scope.channelId
      },
    )
    const mutableScope = { ...CONTEXT.scope }
    const protocol = yield* RoleResponseEnvelope.compile([tool], mutableScope)
    mutableScope.channelId = 'mutated-after-compile'

    const envelope = yield* protocol.parse(
      '<output><message>x</message><actions><action tool="reaction.add"><emoji>👍</emoji></action></actions></output>',
      PARSE_CONTEXT,
    )

    expect(envelope.actions).toHaveLength(1)
    expect(observedChannels).toEqual([CONTEXT.scope.channelId, CONTEXT.scope.channelId])
  }),
)

it.effect('rejects an ActionTool array template whose schema permits no items', () =>
  Effect.gen(function* () {
    const tool = yield* Schema.decodeUnknownEffect(ActionTool)({
      id: 'array.empty',
      protocolVersion: { major: 1, minor: 0 },
      description: 'Represent an empty-only array.',
      xmlTemplate: '<action tool="array.empty"><values><item>VALUE</item></values></action>',
      inputSchema: {
        _tag: 'Object',
        properties: [
          {
            name: 'values',
            required: true,
            schema: {
              _tag: 'Array',
              items: { _tag: 'String' },
              minItems: 0,
              maxItems: 0,
            },
          },
        ],
      },
      executionStage: 'after-send',
      completionPolicy: 'none',
      failurePolicy: 'continue',
      maxDurationMs: 500,
      isAvailable: () => true,
      isInputAllowed: () => true,
    })

    const failure = yield* RoleResponseEnvelope.validateActionToolRegistration(tool).pipe(
      Effect.flip,
    )
    expect(failure).toMatchObject({
      reason: 'template-schema-mismatch',
      toolId: 'array.empty',
    })
  }),
)
