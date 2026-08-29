import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { vi } from 'vitest'

import { RoleResponseEnvelope } from '../../../src/index'
import {
  CONTEXT,
  PARSE_CONTEXT,
  makeReactionTool,
  makeRichTool,
  makeTextBundleTool,
} from './fixtures'

const response = (body: string): string => `<output>${body}</output>`

it.effect('rejects malformed messages, legacy grammar, excess messages, and denied quotes', () =>
  Effect.gen(function* () {
    const protocol = yield* RoleResponseEnvelope.compile([], CONTEXT.scope)
    const malformed = [
      response('<message> </message>'),
      response('<message extra="value">x</message>'),
      response('<message quote="focus-message" extra="value">x</message>'),
      response('<message quote="">x</message>'),
    ]
    const malformedFailures = yield* Effect.forEach(malformed, (document) =>
      protocol.parse(document, PARSE_CONTEXT).pipe(Effect.flip),
    )
    expect(malformedFailures.every((failure) => failure.reason === 'invalid-message')).toBe(true)

    const tooMany = yield* protocol
      .parse(response('<message>x</message>'.repeat(5)), PARSE_CONTEXT)
      .pipe(Effect.flip)
    expect(tooMany.reason).toBe('too-many-messages')

    const legacy = [
      '<yokai-response version="1"><decision action="reply"><message>x</message></decision></yokai-response>',
      response('<decision action="reply"><message>x</message></decision>'),
    ]
    const legacyFailures = yield* Effect.forEach(legacy, (document) =>
      protocol.parse(document, PARSE_CONTEXT).pipe(Effect.flip),
    )
    expect(
      legacyFailures.every((failure) => failure._tag === 'RoleResponseEnvelopeParseError'),
    ).toBe(true)

    const denied = yield* protocol
      .parse(response('<message quote="outside-frozen-turn">x</message>'), PARSE_CONTEXT)
      .pipe(Effect.flip)
    expect(denied.reason).toBe('quote-scope-denied')
  }),
)

it.effect('rejects the removed directives section as an invalid envelope', () =>
  Effect.gen(function* () {
    const protocol = yield* RoleResponseEnvelope.compile([], CONTEXT.scope)
    const message = '<message>x</message>'
    const legacy = [
      response(`${message}<directives><engagement action="extend"></engagement></directives>`),
      response(`${message}<directives><engagement action="close"></engagement></directives>`),
      response('<directives><engagement action="extend"></engagement></directives>'),
    ]

    const failures = yield* Effect.forEach(legacy, (document) =>
      protocol.parse(document, PARSE_CONTEXT).pipe(Effect.flip),
    )
    expect(failures.map((failure) => failure.reason)).toEqual([
      'invalid-envelope',
      'invalid-envelope',
      'invalid-envelope',
    ])
  }),
)

it.effect('rejects malformed or out-of-order root sections', () =>
  Effect.gen(function* () {
    const protocol = yield* RoleResponseEnvelope.compile([], CONTEXT.scope)
    const message = '<message>x</message>'
    const invalid = [
      response(`${message}<actions></actions>`),
      response(`<actions></actions>${message}`),
      response(`${message}<unknown></unknown>`),
    ]

    const failures = yield* Effect.forEach(invalid, (document) =>
      protocol.parse(document, PARSE_CONTEXT).pipe(Effect.flip),
    )
    expect(failures.every((failure) => failure._tag === 'RoleResponseEnvelopeParseError')).toBe(
      true,
    )
  }),
)

it.effect('rejects unknown tools and every schema or structural mismatch before execution', () =>
  Effect.gen(function* () {
    const schedule = yield* makeRichTool()
    const protocol = yield* RoleResponseEnvelope.compile([schedule], CONTEXT.scope)
    const message = '<message>x</message>'
    const action = (body: string, attributes = '') =>
      response(
        `${message}<actions><action tool="schedule.create"${attributes}>${body}</action></actions>`,
      )
    const validTail =
      '<mode>once</mode><metadata><source>focus-message</source></metadata><tags><item>tag</item></tags>'
    const invalid = [
      response(`${message}<actions><action tool="unknown"><query>x</query></action></actions>`),
      action(`<query>x</query><count>1</count>${validTail}`, ' stage="deferred"'),
      action(`<query>x</query><count>1</count><extra>x</extra>${validTail}`),
      action(`<query>x</query><query>y</query><count>1</count>${validTail}`),
      action(`<count>1</count><query>x</query>${validTail}`),
      action(`<query>x</query>${validTail}`),
      action(`<query>x</query><count>4</count>${validTail}`),
      action(
        '<query>x</query><count>1</count><urgent>yes</urgent><mode>once</mode><metadata><source>focus-message</source></metadata><tags><item>tag</item></tags>',
      ),
      action(
        '<query>x</query><count>1</count><mode>never</mode><metadata><source>focus-message</source></metadata><tags><item>tag</item></tags>',
      ),
      action(
        '<query>x</query><count>1</count><mode>once</mode><metadata><source>focus-message</source><extra>x</extra></metadata><tags><item>tag</item></tags>',
      ),
      action(
        '<query>x</query><count>1</count><mode>once</mode><metadata><source>focus-message</source></metadata><tags><item>a</item><item>b</item><item>c</item></tags>',
      ),
    ]

    const failures = yield* Effect.forEach(invalid, (document) =>
      protocol.parse(document, PARSE_CONTEXT).pipe(Effect.flip),
    )
    expect(failures[0]).toMatchObject({ reason: 'unknown-action-tool' })
    expect(
      failures
        .slice(1)
        .every(
          (failure) =>
            failure.reason === 'invalid-action-input' || failure.reason === 'invalid-action',
        ),
    ).toBe(true)
  }),
)

it.effect('authorizes decoded input and converts false or throwing checks into typed denial', () =>
  Effect.gen(function* () {
    const isInputAllowed = vi.fn(() => false)
    const unavailable = yield* makeReactionTool(() => true, isInputAllowed)
    const throwing = yield* makeReactionTool(
      () => true,
      () => {
        throw new Error('third-party input authorization defect')
      },
    )
    const document = response(
      '<message>x</message><actions><action tool="reaction.add"><emoji>👍</emoji></action></actions>',
    )
    const failures = yield* Effect.forEach([unavailable, throwing], (tool) =>
      RoleResponseEnvelope.compile([tool], CONTEXT.scope).pipe(
        Effect.flatMap((protocol) => protocol.parse(document, PARSE_CONTEXT)),
        Effect.flip,
      ),
    )

    expect(failures.map((failure) => failure.reason)).toEqual([
      'action-scope-denied',
      'action-scope-denied',
    ])
    expect(isInputAllowed).toHaveBeenCalledWith(CONTEXT.scope, { emoji: '👍' })
    expect(failures.every((failure) => !Object.hasOwn(failure, 'input'))).toBe(true)

    const protocol = yield* RoleResponseEnvelope.compile([unavailable], CONTEXT.scope)
    const invalidInput = yield* protocol
      .parse(
        response(
          '<message>x</message><actions><action tool="reaction.add"><emoji><nested>not text</nested></emoji></action></actions>',
        ),
        PARSE_CONTEXT,
      )
      .pipe(Effect.flip)
    expect(invalidInput.reason).toBe('invalid-action-input')
    expect(isInputAllowed).toHaveBeenCalledTimes(1)
  }),
)

it.effect('rejects DTD, entities, PI, CDATA, comments, nested markup, and non-canonical XML', () =>
  Effect.gen(function* () {
    const protocol = yield* RoleResponseEnvelope.compile([], CONTEXT.scope)
    const valid = response('<message>x</message>')
    const invalid = [
      `<!DOCTYPE output>${valid}`,
      `<!DOCTYPE output [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${valid}`,
      '<?xml version="1.0"?>' + valid,
      '<!--comment-->' + valid,
      response('<message><![CDATA[x]]></message>'),
      response('<message>&external;</message>'),
      response('<message>&#x110000;</message>'),
      response('<message><b>x</b></message>'),
      '<output version="1"></output>',
      '<output/>',
      valid + 'explanation',
      'explanation' + valid,
      '<output version="1" version="1"></output>',
    ]
    const failures = yield* Effect.forEach(invalid, (document) =>
      protocol.parse(document, PARSE_CONTEXT).pipe(Effect.flip),
    )

    expect(failures.every((failure) => failure._tag === 'RoleResponseEnvelopeParseError')).toBe(
      true,
    )
    expect(failures.every((failure) => !Object.hasOwn(failure, 'source'))).toBe(true)
  }),
)

it.effect('enforces byte, depth, breadth, attribute, text, total-text, and action limits', () =>
  Effect.gen(function* () {
    const empty = yield* RoleResponseEnvelope.compile([], CONTEXT.scope)
    const reaction = yield* makeReactionTool()
    const reactionProtocol = yield* RoleResponseEnvelope.compile([reaction], CONTEXT.scope)
    const bundle = yield* makeTextBundleTool()
    const bundleProtocol = yield* RoleResponseEnvelope.compile([bundle], CONTEXT.scope)
    const message = '<message>x</message>'

    const oversized = '鬼'.repeat(RoleResponseEnvelope.MAX_XML_BYTES)
    const tooDeep = `<output>${'<x>'.repeat(16)}${'</x>'.repeat(16)}</output>`
    const tooWide = `<output>${'<x></x>'.repeat(RoleResponseEnvelope.MAX_XML_ELEMENTS)}</output>`
    const attributes = Array.from(
      { length: RoleResponseEnvelope.MAX_XML_ATTRIBUTES + 1 },
      (_, index) => ` a${index}="x"`,
    ).join('')
    const tooManyAttributes = `<output${attributes}></output>`
    const tooLongText = response(
      `<message>${'x'.repeat(RoleResponseEnvelope.MAX_TEXT_LENGTH + 1)}</message>`,
    )
    const text = 'x'.repeat(RoleResponseEnvelope.MAX_TEXT_LENGTH)
    const tooMuchText = response(
      `${message}<actions><action tool="text.bundle"><one>${text}</one><two>${text}</two><three>${text}</three></action></actions>`,
    )
    const calls = '<action tool="reaction.add"><emoji>👍</emoji></action>'.repeat(
      RoleResponseEnvelope.MAX_ACTIONS + 1,
    )
    const tooManyActions = response(`${message}<actions>${calls}</actions>`)

    const failures = yield* Effect.all([
      empty.parse(oversized, PARSE_CONTEXT).pipe(Effect.flip),
      empty.parse(tooDeep, PARSE_CONTEXT).pipe(Effect.flip),
      empty.parse(tooWide, PARSE_CONTEXT).pipe(Effect.flip),
      empty.parse(tooManyAttributes, PARSE_CONTEXT).pipe(Effect.flip),
      empty.parse(tooLongText, PARSE_CONTEXT).pipe(Effect.flip),
      bundleProtocol.parse(tooMuchText, PARSE_CONTEXT).pipe(Effect.flip),
      reactionProtocol.parse(tooManyActions, PARSE_CONTEXT).pipe(Effect.flip),
    ])

    expect(failures.map((failure) => failure.reason)).toEqual([
      'document-too-large',
      'maximum-depth-exceeded',
      'too-many-elements',
      'too-many-attributes',
      'text-too-large',
      'text-too-large',
      'too-many-actions',
    ])
  }),
)
