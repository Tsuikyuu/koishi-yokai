import { expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'

import { RoleResponseEnvelope } from '../../../src/index'
import { CONTEXT, PARSE_CONTEXT, makeReactionTool, makeRichTool } from './fixtures'

const response = (body: string): string => `<output>${body}</output>`

it.effect('decodes silence, ordered plain messages, and per-message quotes', () =>
  Effect.gen(function* () {
    const protocol = yield* RoleResponseEnvelope.compile([], CONTEXT.scope)
    const documents = [
      response(''),
      response('<message>&#x1F47B;</message><message>still here</message>'),
      response(
        '<message>first</message><message quote="focus-message">three &amp; &lt;four&gt;</message><message quote="recent-message">last</message>',
      ),
      response(
        '<message>one</message><message>two</message><message>three</message><message>four</message>',
      ),
    ]
    const envelopes = yield* Effect.forEach(documents, (document) =>
      protocol.parse(document, PARSE_CONTEXT),
    )

    expect(
      envelopes.map((envelope) =>
        envelope.messages.map((message) => ({
          content: message.content,
          quote: Option.getOrNull(message.quote),
        })),
      ),
    ).toEqual([
      [],
      [
        { content: '👻', quote: null },
        { content: 'still here', quote: null },
      ],
      [
        { content: 'first', quote: null },
        { content: 'three & <four>', quote: 'focus-message' },
        { content: 'last', quote: 'recent-message' },
      ],
      [
        { content: 'one', quote: null },
        { content: 'two', quote: null },
        { content: 'three', quote: null },
        { content: 'four', quote: null },
      ],
    ])
  }),
)

it.effect('parses visible ActionTools recursively and preserves frozen registration policy', () =>
  Effect.gen(function* () {
    const reaction = yield* makeReactionTool()
    const schedule = yield* makeRichTool()
    const protocol = yield* RoleResponseEnvelope.compile([schedule, reaction], CONTEXT.scope)
    const envelope = yield* protocol.parse(
      response(`<message>scheduled</message>
        <actions>
          <action tool="reaction.add"><emoji>👍</emoji></action>
          <action tool="schedule.create">
            <query>class</query>
            <count>2</count>
            <mode>once</mode>
            <metadata><source>focus-message</source></metadata>
            <tags><item>school</item><item>today</item></tags>
          </action>
        </actions>`),
      PARSE_CONTEXT,
    )

    expect(envelope.actions).toHaveLength(2)
    expect(envelope.actions[0]).toMatchObject({ input: { emoji: '👍' } })
    expect(envelope.actions[1]).toMatchObject({
      input: {
        query: 'class',
        count: 2,
        mode: 'once',
        metadata: { source: 'focus-message' },
        tags: ['school', 'today'],
      },
    })
    const parsedSchedule = envelope.actions[1]
    if (parsedSchedule === undefined) return yield* Effect.die('Expected a schedule action')
    expect(parsedSchedule.tool).not.toBe(schedule)
    expect(parsedSchedule.tool).toEqual(schedule)
    expect(parsedSchedule.tool.executionStage).toBe('after-send')
    expect(parsedSchedule.tool.completionPolicy).toBe('none')
    expect(parsedSchedule.tool.failurePolicy).toBe('continue')
  }),
)

it.effect('allows repeated calls to the same visible ActionTool', () =>
  Effect.gen(function* () {
    const reaction = yield* makeReactionTool()
    const protocol = yield* RoleResponseEnvelope.compile([reaction], CONTEXT.scope)
    const envelope = yield* protocol.parse(
      response(`<message>nice</message><actions>
        <action tool="reaction.add"><emoji>👍</emoji></action>
        <action tool="reaction.add"><emoji>✨</emoji></action>
      </actions>`),
      PARSE_CONTEXT,
    )

    expect(envelope.actions.map((action) => action.input)).toEqual([
      { emoji: '👍' },
      { emoji: '✨' },
    ])
  }),
)
