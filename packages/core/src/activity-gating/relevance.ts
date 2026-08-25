import { Schema } from 'effect'

import { isExcludedMessage, MessageEligibility, Pressure, Score } from './value'

export const DEFAULT_HARD_TRIGGER_RELEVANCE = Score.make(10)

export const Signals = Schema.Struct({
  ...MessageEligibility.fields,
  explicitMention: Schema.Boolean,
  replyToSelf: Schema.Boolean,
  mentionDegree: Score,
  nameOrAliasEvidence: Score,
  questionOrHelpEvidence: Score,
  unfinishedItemEvidence: Score,
  threadOrInterestEvidence: Score,
  recentParticipationPressure: Pressure,
  sufficientResponsePressure: Pressure,
  cooldownPressure: Pressure,
  budgetPressure: Pressure,
})

export interface Signals extends Schema.Schema.Type<typeof Signals> {}

export const Result = Schema.Struct({
  positiveEvidence: Score,
  totalPressure: Score,
  hardTrigger: Schema.Boolean,
  relevance: Score,
})

export interface Result extends Schema.Schema.Type<typeof Result> {}

export const calculate = (
  signals: Signals,
  hardTriggerMinimum: Score = DEFAULT_HARD_TRIGGER_RELEVANCE,
): Result => {
  const totalPressure = Score.make(
    signals.recentParticipationPressure +
      signals.sufficientResponsePressure +
      signals.cooldownPressure +
      signals.budgetPressure,
  )

  if (isExcludedMessage(signals)) {
    return Result.make({
      positiveEvidence: Score.make(0),
      totalPressure,
      hardTrigger: false,
      relevance: Score.make(0),
    })
  }

  const positiveEvidence = Score.make(
    signals.mentionDegree +
      signals.nameOrAliasEvidence +
      signals.questionOrHelpEvidence +
      signals.unfinishedItemEvidence +
      signals.threadOrInterestEvidence,
  )
  const hardTrigger = signals.explicitMention || signals.replyToSelf
  const pressuredRelevance = Math.max(0, positiveEvidence - totalPressure)

  return Result.make({
    positiveEvidence,
    totalPressure,
    hardTrigger,
    relevance: Score.make(
      hardTrigger ? Math.max(hardTriggerMinimum, pressuredRelevance) : pressuredRelevance,
    ),
  })
}
