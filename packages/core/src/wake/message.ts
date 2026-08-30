import { CapabilityScope, FocusMessage } from 'yokai-protocol'
import { Schema } from 'effect'

import { Pressure, Score } from '../activity-gating/value'

export const LocalStateSignals = Schema.Struct({
  unfinishedItemEvidence: Score,
  threadOrInterestEvidence: Score,
  recentParticipationPressure: Pressure,
  sufficientResponsePressure: Pressure,
})

export interface LocalStateSignals extends Schema.Schema.Type<typeof LocalStateSignals> {}

export const emptyLocalStateSignals = (): LocalStateSignals =>
  LocalStateSignals.make({
    unfinishedItemEvidence: Score.make(0),
    threadOrInterestEvidence: Score.make(0),
    recentParticipationPressure: Pressure.make(0),
    sufficientResponsePressure: Pressure.make(0),
  })

export const PresetNameMatch = Schema.Literals(['none', 'prefix', 'contains'])

export type PresetNameMatch = typeof PresetNameMatch.Type

export const HardReplyKind = Schema.Literals([
  'none',
  'explicit-mention',
  'reply-to-self',
  'role-name-prefix',
  'role-name-contains',
])

export type HardReplyKind = typeof HardReplyKind.Type

export const Message = Schema.Struct({
  scope: CapabilityScope,
  focus: FocusMessage,
  isDuplicate: Schema.Boolean,
  isOtherBot: Schema.Boolean,
  isSelf: Schema.Boolean,
  isEffective: Schema.Boolean,
  explicitMention: Schema.Boolean,
  replyToSelf: Schema.Boolean,
  presetNameMatch: PresetNameMatch,
  hardReplyKind: HardReplyKind,
  isQuestionOrHelp: Schema.Boolean,
  hasQuote: Schema.Boolean,
  hasMedia: Schema.Boolean,
  localState: LocalStateSignals,
})

export interface Message extends Schema.Schema.Type<typeof Message> {}

export const isHardTrigger = (message: Message): boolean =>
  !message.isDuplicate &&
  !message.isOtherBot &&
  !message.isSelf &&
  message.isEffective &&
  message.hardReplyKind !== 'none'

export const isLeaseAnchorTrigger = (message: Message): boolean =>
  isHardTrigger(message) &&
  (message.hardReplyKind === 'explicit-mention' || message.hardReplyKind === 'reply-to-self')

export const isDirectedToSelf = (message: Message): boolean =>
  message.explicitMention ||
  message.replyToSelf ||
  message.presetNameMatch === 'prefix' ||
  message.hardReplyKind === 'role-name-contains'

export const withLocalState = (message: Message, localState: LocalStateSignals): Message =>
  Message.make({ ...message, localState })

export * as WakeMessage from './message'
