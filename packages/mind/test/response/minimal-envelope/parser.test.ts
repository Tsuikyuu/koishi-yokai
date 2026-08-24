import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { MinimalResponseEnvelope } from '../../../src/index'

it.effect('strictly parses one reply and decodes XML text entities', () =>
  Effect.gen(function* () {
    const decision = yield* MinimalResponseEnvelope.parse(`
      <yokai-response version="1">
        <decision action="reply">
          <message>三点 &amp; &lt;四点&gt; &#x1F47B;</message>
        </decision>
      </yokai-response>
    `)

    expect(decision).toEqual({
      _tag: 'Reply',
      message: '三点 & <四点> 👻',
    })
  }),
)

it.effect('parses silence without inventing a message', () =>
  MinimalResponseEnvelope.parse(
    '<yokai-response version="1"><decision action="silence"></decision></yokai-response>',
  ).pipe(
    Effect.map((decision) => {
      expect(decision).toEqual({ _tag: 'Silence' })
    }),
  ),
)

it.effect('rejects malformed, extended, nested, and protocol-prefixed output', () => {
  const invalidDocuments = [
    '<yokai-response><decision action="silence"></decision></yokai-response>',
    '<yokai-response version="1"><decision action="react"></decision></yokai-response>',
    '<yokai-response version="1"><decision action="reply"><message></message></decision></yokai-response>',
    '<yokai-response version="1"><decision action="reply"><message><b>nested</b></message></decision></yokai-response>',
    '<yokai-response version="1"><decision action="silence"><message>leak</message></decision></yokai-response>',
    '<?xml version="1.0"?><yokai-response version="1"><decision action="silence"></decision></yokai-response>',
    '<!DOCTYPE yokai-response><yokai-response version="1"><decision action="silence"></decision></yokai-response>',
    '<yokai-response version="1"><decision action="reply"><message><![CDATA[leak]]></message></decision></yokai-response>',
    '<yokai-response version="1"><decision action="reply"><message>&external;</message></decision></yokai-response>',
    '<yokai-response version="1"><decision action="silence"></decision></yokai-response>explanation',
  ]

  return Effect.forEach(invalidDocuments, (document) =>
    MinimalResponseEnvelope.parse(document).pipe(
      Effect.flip,
      Effect.map((failure) => {
        expect(failure._tag).toBe('MinimalResponseEnvelopeParseError')
        expect(failure).not.toHaveProperty('source')
      }),
    ),
  )
})

it.effect('bounds the complete XML document before parsing', () => {
  const document = 'x'.repeat(MinimalResponseEnvelope.MAX_XML_LENGTH + 1)

  return MinimalResponseEnvelope.parse(document).pipe(
    Effect.flip,
    Effect.map((failure) => {
      expect(failure.reason).toBe('document-too-large')
    }),
  )
})
