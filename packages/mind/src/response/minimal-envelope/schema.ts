import { Schema } from 'effect'

export const MAX_MESSAGE_LENGTH = 4096
export const MAX_XML_LENGTH = 16_384

export const Message = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_MESSAGE_LENGTH),
)

export type Message = typeof Message.Type

export const Decision = Schema.TaggedUnion({
  Reply: { message: Message },
  Silence: {},
})

export type Decision = typeof Decision.Type

export const ParseFailureReason = Schema.Literals([
  'document-too-large',
  'invalid-envelope',
  'invalid-message',
])

export type ParseFailureReason = typeof ParseFailureReason.Type

/** Deliberately excludes the provider text so protocol output cannot leak through errors. */
export class ParseError extends Schema.TaggedError<ParseError>(
  '@yokai/mind/MinimalResponseEnvelope.ParseError',
)('MinimalResponseEnvelopeParseError', {
  reason: ParseFailureReason,
}) {}
