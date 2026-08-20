import { Schema } from 'effect'

export const UserMessage = Schema.Struct({
  role: Schema.tag('user'),
  content: Schema.NonEmptyString,
})

export interface UserMessage extends Schema.Schema.Type<typeof UserMessage> {}

export const AssistantMessage = Schema.Struct({
  role: Schema.tag('assistant'),
  content: Schema.NonEmptyString,
})

export interface AssistantMessage extends Schema.Schema.Type<typeof AssistantMessage> {}

/** Text-only history accepted by the first generation request. */
export const ConversationMessage = Schema.Union([UserMessage, AssistantMessage]).pipe(
  Schema.toTaggedUnion('role'),
)

export type ConversationMessage = typeof ConversationMessage.Type
