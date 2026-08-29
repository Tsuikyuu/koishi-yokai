import { expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'

import { RoleResponseEnvelope } from '../../../src/index'
import { CONTEXT, PARSE_CONTEXT, makeReactionTool, makeRichTool } from './fixtures'

const response = (body: string): string => `<yokai-response version="1">${body}</yokai-response>`

it.effect('exhaustively decodes all five decisions and standard XML text entities', () =>
  Effect.gen(function* () {
    const protocol = yield* RoleResponseEnvelope.compile([], CONTEXT.scope)
    const documents = [
      response('<decision action="silence"></decision>'),
      response('<decision action="react"><message>&#x1F47B;</message></decision>'),
      response(
        '<decision action="reply" reply-to="focus-message"><message>three &amp; &lt;four&gt;</message></decision>',
      ),
      response('<decision action="follow-up"><message>still here</message></decision>'),
      response('<decision action="initiate"><message>new topic</message></decision>'),
    ]
    const envelopes = yield* Effect.forEach(documents, (document) =>
      protocol.parse(document, PARSE_CONTEXT),
    )

    expect(envelopes.map((envelope) => envelope.decision._tag)).toEqual([
      'Silence',
      'React',
      'Reply',
      'FollowUp',
      'Initiate',
    ])
    expect(envelopes[1]).toMatchObject({ decision: { _tag: 'React', message: '👻' } })
    expect(envelopes[2]).toMatchObject({
      decision: { _tag: 'Reply', message: 'three & <four>' },
    })
    const reply = envelopes[2]
    if (reply === undefined || reply.decision._tag !== 'Reply') {
      return yield* Effect.die('Expected a reply decision')
    }
    expect(reply.decision.replyTo).toEqual(Option.some('focus-message'))
  }),
)

it.effect('decodes the fixed engagement directive and optional absence', () =>
  Effect.gen(function* () {
    const protocol = yield* RoleResponseEnvelope.compile([], CONTEXT.scope)
    const extended = yield* protocol.parse(
      response(
        '<decision action="reply"><message>continue</message></decision><directives><engagement action="extend"></engagement></directives>',
      ),
      PARSE_CONTEXT,
    )
    const closed = yield* protocol.parse(
      response(
        '<decision action="reply"><message>done</message></decision><directives><engagement action="close"></engagement></directives>',
      ),
      PARSE_CONTEXT,
    )
    const absent = yield* protocol.parse(
      response('<decision action="reply"><message>neutral</message></decision>'),
      PARSE_CONTEXT,
    )

    expect(extended.engagement).toEqual(Option.some('extend'))
    expect(closed.engagement).toEqual(Option.some('close'))
    expect(Option.isNone(absent.engagement)).toBe(true)
  }),
)

it.effect('parses visible ActionTools recursively and preserves frozen registration policy', () =>
  Effect.gen(function* () {
    const reaction = yield* makeReactionTool()
    const schedule = yield* makeRichTool()
    const protocol = yield* RoleResponseEnvelope.compile([schedule, reaction], CONTEXT.scope)
    const envelope = yield* protocol.parse(
      response(`<decision action="reply"><message>scheduled</message></decision>
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
      response(`<decision action="react"><message>nice</message></decision><actions>
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
