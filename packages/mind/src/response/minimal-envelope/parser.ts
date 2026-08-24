import { Effect, Schema } from 'effect'

import { Decision, MAX_XML_LENGTH, ParseError } from './schema'

interface Cursor {
  readonly source: string
  readonly offset: number
}

interface ParsedDecision {
  readonly decision: Decision
  readonly cursor: Cursor
}

const ROOT_OPEN = '<yokai-response version="1">'
const ROOT_CLOSE = '</yokai-response>'
const REPLY_OPEN = '<decision action="reply">'
const SILENCE_OPEN = '<decision action="silence">'
const DECISION_CLOSE = '</decision>'
const MESSAGE_OPEN = '<message>'
const MESSAGE_CLOSE = '</message>'
const ENTITY_TOKEN = /(&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9A-Fa-f]+);)/g

const parseError = (reason: 'document-too-large' | 'invalid-envelope' | 'invalid-message') =>
  new ParseError({ reason })

const isXmlWhitespace = (character: string): boolean =>
  character === '\u0009' ||
  character === '\u000a' ||
  character === '\u000d' ||
  character === '\u0020'

const skipWhitespace = (cursor: Cursor): Cursor => {
  const remaining = cursor.source.slice(cursor.offset)
  const firstNonWhitespace = Array.from(remaining).findIndex(
    (character) => !isXmlWhitespace(character),
  )
  const length = firstNonWhitespace < 0 ? remaining.length : firstNonWhitespace
  return { source: cursor.source, offset: cursor.offset + length }
}

const expectLiteral = (cursor: Cursor, literal: string): Effect.Effect<Cursor, ParseError> =>
  cursor.source.startsWith(literal, cursor.offset)
    ? Effect.succeed({ source: cursor.source, offset: cursor.offset + literal.length })
    : Effect.fail(parseError('invalid-envelope'))

const isXmlCodePoint = (value: number): boolean =>
  value === 0x09 ||
  value === 0x0a ||
  value === 0x0d ||
  (value >= 0x20 && value <= 0xd7ff) ||
  (value >= 0xe000 && value <= 0xfffd) ||
  (value >= 0x10000 && value <= 0x10ffff)

const isXmlText = (value: string): boolean =>
  Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && isXmlCodePoint(codePoint)
  })

const decodeNumericEntity = (token: string, radix: 10 | 16, prefixLength: number) => {
  const digits = token.slice(prefixLength, -1)
  const codePoint = Number.parseInt(digits, radix)
  return Number.isSafeInteger(codePoint) && isXmlCodePoint(codePoint)
    ? Effect.succeed(String.fromCodePoint(codePoint))
    : Effect.fail(parseError('invalid-envelope'))
}

const decodeEntity = (token: string): Effect.Effect<string, ParseError> => {
  if (token === '&amp;') return Effect.succeed('&')
  if (token === '&lt;') return Effect.succeed('<')
  if (token === '&gt;') return Effect.succeed('>')
  if (token === '&quot;') return Effect.succeed('"')
  if (token === '&apos;') return Effect.succeed("'")
  if (token.startsWith('&#x')) return decodeNumericEntity(token, 16, 3)
  if (token.startsWith('&#')) return decodeNumericEntity(token, 10, 2)
  return Effect.fail(parseError('invalid-envelope'))
}

const decodeTextPart = (part: string): Effect.Effect<string, ParseError> =>
  part.startsWith('&')
    ? decodeEntity(part)
    : part.includes('&')
      ? Effect.fail(parseError('invalid-envelope'))
      : Effect.succeed(part)

const decodeXmlText = (encoded: string): Effect.Effect<string, ParseError> =>
  encoded.includes(']]>')
    ? Effect.fail(parseError('invalid-envelope'))
    : Effect.forEach(encoded.split(ENTITY_TOKEN), decodeTextPart).pipe(
        Effect.map((parts) => parts.join('')),
        Effect.filterOrFail(isXmlText, () => parseError('invalid-envelope')),
      )

const decodeDecision = (input: {
  readonly _tag: 'Reply'
  readonly message: string
}): Effect.Effect<Decision, ParseError> =>
  Schema.decodeUnknownEffect(Decision)(input).pipe(
    Effect.mapError(() => parseError('invalid-message')),
  )

const parseReply = Effect.fn('MinimalResponseEnvelope.parseReply')(function* (cursor: Cursor) {
  const afterReply = yield* expectLiteral(cursor, REPLY_OPEN)
  const afterMessageOpen = yield* expectLiteral(skipWhitespace(afterReply), MESSAGE_OPEN)
  const messageEnd = afterMessageOpen.source.indexOf(MESSAGE_CLOSE, afterMessageOpen.offset)
  if (messageEnd < 0) return yield* Effect.fail(parseError('invalid-envelope'))

  const encodedMessage = afterMessageOpen.source.slice(afterMessageOpen.offset, messageEnd)
  if (encodedMessage.includes('<')) {
    return yield* Effect.fail(parseError('invalid-envelope'))
  }
  const message = yield* decodeXmlText(encodedMessage)
  const decision = yield* decodeDecision({ _tag: 'Reply', message })
  const afterMessage = {
    source: afterMessageOpen.source,
    offset: messageEnd + MESSAGE_CLOSE.length,
  }
  const afterDecision = yield* expectLiteral(skipWhitespace(afterMessage), DECISION_CLOSE)
  return { decision, cursor: afterDecision } satisfies ParsedDecision
})

const parseSilence = Effect.fn('MinimalResponseEnvelope.parseSilence')(function* (cursor: Cursor) {
  const afterSilence = yield* expectLiteral(cursor, SILENCE_OPEN)
  const afterDecision = yield* expectLiteral(skipWhitespace(afterSilence), DECISION_CLOSE)
  return {
    decision: Decision.cases.Silence.make({}),
    cursor: afterDecision,
  } satisfies ParsedDecision
})

const parseDecision = (cursor: Cursor): Effect.Effect<ParsedDecision, ParseError> => {
  if (cursor.source.startsWith(REPLY_OPEN, cursor.offset)) return parseReply(cursor)
  if (cursor.source.startsWith(SILENCE_OPEN, cursor.offset)) return parseSilence(cursor)
  return Effect.fail(parseError('invalid-envelope'))
}

export const parse = Effect.fn('MinimalResponseEnvelope.parse')(function* (source: string) {
  if (source.length > MAX_XML_LENGTH) {
    return yield* Effect.fail(parseError('document-too-large'))
  }

  const initial: Cursor = { source, offset: 0 }
  const afterRoot = yield* expectLiteral(skipWhitespace(initial), ROOT_OPEN)
  const parsed = yield* parseDecision(skipWhitespace(afterRoot))
  const afterClose = yield* expectLiteral(skipWhitespace(parsed.cursor), ROOT_CLOSE)
  const completed = skipWhitespace(afterClose)
  if (completed.offset !== source.length) {
    return yield* Effect.fail(parseError('invalid-envelope'))
  }
  return parsed.decision
})
