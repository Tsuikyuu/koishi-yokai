import { CapabilityScope, FocusMessage } from 'yokai-protocol'
import { Schema } from 'effect'

export const Message = Schema.Struct({
  scope: CapabilityScope,
  focus: FocusMessage,
  isDuplicate: Schema.Boolean,
  isOtherBot: Schema.Boolean,
  isSelf: Schema.Boolean,
  isEffective: Schema.Boolean,
  explicitMention: Schema.Boolean,
  replyToSelf: Schema.Boolean,
  nameHit: Schema.Boolean,
  isQuestionOrHelp: Schema.Boolean,
  hasQuote: Schema.Boolean,
  hasMedia: Schema.Boolean,
})

export interface Message extends Schema.Schema.Type<typeof Message> {}

export const isHardTrigger = (message: Message): boolean =>
  !message.isDuplicate &&
  !message.isOtherBot &&
  !message.isSelf &&
  message.isEffective &&
  (message.explicitMention || message.replyToSelf || message.nameHit)

export * as WakeMessage from './message'
