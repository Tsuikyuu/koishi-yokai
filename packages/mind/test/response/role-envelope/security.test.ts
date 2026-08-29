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

const response = (body: string): string => `<yokai-response version="1">${body}</yokai-response>`

it.effect('rejects missing, duplicate, unknown, and scope-invalid decision content', () =>
  Effect.gen(function* () {
    const protocol = yield* RoleResponseEnvelope.compile([], CONTEXT.scope)
    const documents = [
      response('<decision action="silence"><message>leak</message></decision>'),
      response('<decision action="react"></decision>'),
      response('<decision action="reply"></decision>'),
      response('<decision action="reply"><message>one</message><message>two</message></decision>'),
      response('<decision action="reply"><message> </message></decision>'),
      response('<decision action="unknown"><message>text</message></decision>'),
      response(
        '<decision action="follow-up" reply-to="focus-message"><message>x</message></decision>',
      ),
      response('<decision action="reply" extra="value"><message>x</message></decision>'),
    ]
    const failures = yield* Effect.forEach(documents, (document) =>
      protocol.parse(document, PARSE_CONTEXT).pipe(Effect.flip),
    )

    expect(failures.every((failure) => failure.reason === 'invalid-decision')).toBe(true)

    const denied = yield* protocol
      .parse(
        response(
          '<decision action="reply" reply-to="outside-frozen-turn"><message>x</message></decision>',
        ),
        PARSE_CONTEXT,
      )
      .pipe(Effect.flip)
    expect(denied.reason).toBe('reply-scope-denied')
  }),
)

it.effect('rejects unknown, duplicate, malformed, or out-of-order directives and sections', () =>
  Effect.gen(function* () {
    const protocol = yield* RoleResponseEnvelope.compile([], CONTEXT.scope)
    const decision = '<decision action="reply"><message>x</message></decision>'
    const invalid = [
      response(`${decision}<directives></directives>`),
      response(`${decision}<directives><unknown action="extend"></unknown></directives>`),
      response(`${decision}<directives><engagement action="keep"></engagement></directives>`),
      response(`${decision}<directives><engagement action="extend">text</engagement></directives>`),
      response(
        `${decision}<directives><engagement action="extend" extra="x"></engagement></directives>`,
      ),
      response(
        `${decision}<directives><engagement action="extend"></engagement><engagement action="close"></engagement></directives>`,
      ),
      response(
        `${decision}<directives><engagement action="extend"></engagement></directives><directives><engagement action="close"></engagement></directives>`,
      ),
      response(`${decision}<actions></actions>`),
      response(`<actions></actions>${decision}`),
      response(`${decision}<unknown></unknown>`),
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
    const decision = '<decision action="reply"><message>x</message></decision>'
    const action = (body: string, attributes = '') =>
      response(
        `${decision}<actions><action tool="schedule.create"${attributes}>${body}</action></actions>`,
      )
    const validTail =
      '<mode>once</mode><metadata><source>focus-message</source></metadata><tags><item>tag</item></tags>'
    const invalid = [
      response(`${decision}<actions><action tool="unknown"><query>x</query></action></actions>`),
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
      '<decision action="react"><message>x</message></decision><actions><action tool="reaction.add"><emoji>👍</emoji></action></actions>',
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
          '<decision action="react"><message>x</message></decision><actions><action tool="reaction.add"><emoji><nested>not text</nested></emoji></action></actions>',
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
    const valid = response('<decision action="reply"><message>x</message></decision>')
    const invalid = [
      `<!DOCTYPE yokai-response>${valid}`,
      `<!DOCTYPE yokai-response [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${valid}`,
      '<?xml version="1.0"?>' + valid,
      '<!--comment-->' + valid,
      response('<decision action="reply"><message><![CDATA[x]]></message></decision>'),
      response('<decision action="reply"><message>&external;</message></decision>'),
      response('<decision action="reply"><message>&#x110000;</message></decision>'),
      response('<decision action="reply"><message><b>x</b></message></decision>'),
      '<yokai-response version=\'1\'><decision action="silence"></decision></yokai-response>',
      '<yokai-response version="1"><decision action="silence"/></yokai-response>',
      valid + 'explanation',
      'explanation' + valid,
      '<yokai-response version="1" version="1"><decision action="silence"></decision></yokai-response>',
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
    const decision = '<decision action="reply"><message>x</message></decision>'

    const oversized = '鬼'.repeat(RoleResponseEnvelope.MAX_XML_BYTES)
    const tooDeep = `<yokai-response version="1">${'<x>'.repeat(16)}${'</x>'.repeat(16)}</yokai-response>`
    const tooWide = `<yokai-response version="1">${'<x></x>'.repeat(RoleResponseEnvelope.MAX_XML_ELEMENTS)}</yokai-response>`
    const attributes = Array.from(
      { length: RoleResponseEnvelope.MAX_XML_ATTRIBUTES },
      (_, index) => ` a${index}="x"`,
    ).join('')
    const tooManyAttributes = `<yokai-response version="1"${attributes}></yokai-response>`
    const tooLongText = response(
      `<decision action="reply"><message>${'x'.repeat(RoleResponseEnvelope.MAX_TEXT_LENGTH + 1)}</message></decision>`,
    )
    const text = 'x'.repeat(RoleResponseEnvelope.MAX_TEXT_LENGTH)
    const tooMuchText = response(
      `${decision}<actions><action tool="text.bundle"><one>${text}</one><two>${text}</two><three>${text}</three></action></actions>`,
    )
    const calls = '<action tool="reaction.add"><emoji>👍</emoji></action>'.repeat(
      RoleResponseEnvelope.MAX_ACTIONS + 1,
    )
    const tooManyActions = response(`${decision}<actions>${calls}</actions>`)

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
