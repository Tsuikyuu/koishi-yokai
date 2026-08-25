import { Schema } from 'effect'

import {
  isExcludedMessage,
  MessageEligibility,
  Milliseconds,
  PositiveMilliseconds,
  Score,
} from './value'

export const DEFAULT_HALF_LIFE_MS = PositiveMilliseconds.make(120_000)
export const NEW_PARTICIPANT_WINDOW_MS = PositiveMilliseconds.make(300_000)
export const DEFAULT_BASE_IMPULSE = Score.make(1)
export const DEFAULT_NEW_PARTICIPANT_BONUS = Score.make(0.5)
export const DEFAULT_LOCAL_SIGNAL_BONUS = Score.make(0.25)
export const DEFAULT_MAXIMUM_IMPULSE = Score.make(1.75)

export const Parameters = Schema.Struct({
  halfLifeMs: PositiveMilliseconds,
  baseImpulse: Score,
  newParticipantBonus: Score,
  localSignalBonus: Score,
  maximumImpulse: Score,
})

export interface Parameters extends Schema.Schema.Type<typeof Parameters> {}

export const DEFAULT_PARAMETERS = Parameters.make({
  halfLifeMs: DEFAULT_HALF_LIFE_MS,
  baseImpulse: DEFAULT_BASE_IMPULSE,
  newParticipantBonus: DEFAULT_NEW_PARTICIPANT_BONUS,
  localSignalBonus: DEFAULT_LOCAL_SIGNAL_BONUS,
  maximumImpulse: DEFAULT_MAXIMUM_IMPULSE,
})

export const Message = Schema.Struct({
  ...MessageEligibility.fields,
  isEffective: Schema.Boolean,
  isFirstParticipantInWindow: Schema.Boolean,
  isQuestion: Schema.Boolean,
  hasQuote: Schema.Boolean,
  hasMedia: Schema.Boolean,
})

export interface Message extends Schema.Schema.Type<typeof Message> {}

export const UpdateInput = Schema.Struct({
  previousActivity: Score,
  elapsedMs: Milliseconds,
  message: Message,
})

export interface UpdateInput extends Schema.Schema.Type<typeof UpdateInput> {}

export const Update = Schema.Struct({
  decayedActivity: Score,
  impulse: Score,
  activity: Score,
})

export interface Update extends Schema.Schema.Type<typeof Update> {}

export const decay = (
  previousActivity: Score,
  elapsedMs: Milliseconds,
  halfLifeMs: PositiveMilliseconds = DEFAULT_HALF_LIFE_MS,
): Score => Score.make(previousActivity * 2 ** (-elapsedMs / halfLifeMs))

export const impulse = (message: Message, parameters: Parameters = DEFAULT_PARAMETERS): Score => {
  if (!message.isEffective || isExcludedMessage(message)) return Score.make(0)

  const participantBonus = message.isFirstParticipantInWindow ? parameters.newParticipantBonus : 0
  const localSignalCount =
    (message.isQuestion ? 1 : 0) + (message.hasQuote ? 1 : 0) + (message.hasMedia ? 1 : 0)
  const uncapped =
    parameters.baseImpulse + participantBonus + localSignalCount * parameters.localSignalBonus

  return Score.make(Math.min(parameters.maximumImpulse, uncapped))
}

export const update = (input: UpdateInput, parameters: Parameters = DEFAULT_PARAMETERS): Update => {
  const decayedActivity = decay(input.previousActivity, input.elapsedMs, parameters.halfLifeMs)
  const messageImpulse = impulse(input.message, parameters)

  return Update.make({
    decayedActivity,
    impulse: messageImpulse,
    activity: Score.make(decayedActivity + messageImpulse),
  })
}
