import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { ActivityGateValue, LocalRelevance } from '../../src/index'

const baseSignals = LocalRelevance.Signals.make({
  isDuplicate: false,
  isOtherBot: false,
  isSelf: false,
  hardTrigger: false,
  mentionDegree: ActivityGateValue.Score.make(0),
  replyToSelfEvidence: ActivityGateValue.Score.make(0),
  nameOrAliasEvidence: ActivityGateValue.Score.make(0),
  questionOrHelpEvidence: ActivityGateValue.Score.make(0),
  unfinishedItemEvidence: ActivityGateValue.Score.make(0),
  threadOrInterestEvidence: ActivityGateValue.Score.make(0),
  recentParticipationPressure: ActivityGateValue.Pressure.make(0),
  sufficientResponsePressure: ActivityGateValue.Pressure.make(0),
  cooldownPressure: ActivityGateValue.Pressure.make(0),
  budgetPressure: ActivityGateValue.Pressure.make(0),
})

const signals = (overrides: Partial<LocalRelevance.Signals> = {}): LocalRelevance.Signals =>
  LocalRelevance.Signals.make({ ...baseSignals, ...overrides })

it.effect('combines only local positive evidence and pressure', () =>
  Effect.sync(() => {
    const result = LocalRelevance.calculate(
      signals({
        mentionDegree: ActivityGateValue.Score.make(0.5),
        replyToSelfEvidence: ActivityGateValue.Score.make(0.5),
        nameOrAliasEvidence: ActivityGateValue.Score.make(0.5),
        questionOrHelpEvidence: ActivityGateValue.Score.make(0.75),
        unfinishedItemEvidence: ActivityGateValue.Score.make(1),
        threadOrInterestEvidence: ActivityGateValue.Score.make(0.75),
        recentParticipationPressure: ActivityGateValue.Pressure.make(0.25),
        sufficientResponsePressure: ActivityGateValue.Pressure.make(0.25),
        cooldownPressure: ActivityGateValue.Pressure.make(0.5),
        budgetPressure: ActivityGateValue.Pressure.make(0.5),
      }),
    )

    expect(result.positiveEvidence).toBe(4)
    expect(result.totalPressure).toBe(1.5)
    expect(result.relevance).toBe(2.5)
    expect(result.hardTrigger).toBe(false)
  }),
)

it.effect('keeps a disabled reply-to-self hard match as local relevance evidence', () =>
  Effect.sync(() => {
    const result = LocalRelevance.calculate(
      signals({ replyToSelfEvidence: ActivityGateValue.Score.make(10) }),
    )

    expect(result.positiveEvidence).toBe(10)
    expect(result.relevance).toBe(10)
    expect(result.hardTrigger).toBe(false)
  }),
)

it.effect('keeps configured hard replies at relevance ten or above', () =>
  Effect.sync(() => {
    const maximumPressure = {
      recentParticipationPressure: ActivityGateValue.Pressure.make(1),
      sufficientResponsePressure: ActivityGateValue.Pressure.make(1),
      cooldownPressure: ActivityGateValue.Pressure.make(1),
      budgetPressure: ActivityGateValue.Pressure.make(1),
    }

    const result = LocalRelevance.calculate(signals({ ...maximumPressure, hardTrigger: true }))
    expect(result.hardTrigger).toBe(true)
    expect(result.relevance).toBe(10)
  }),
)

it.effect('gives no relevance to duplicate, other-bot, or self messages', () =>
  Effect.sync(() => {
    const cases = [
      signals({ isDuplicate: true, hardTrigger: true }),
      signals({ isOtherBot: true, hardTrigger: true }),
      signals({ isSelf: true, hardTrigger: true }),
    ]

    for (const candidate of cases) {
      const result = LocalRelevance.calculate(candidate)
      expect(result.positiveEvidence).toBe(0)
      expect(result.relevance).toBe(0)
      expect(result.hardTrigger).toBe(false)
    }
  }),
)

it.effect('does not let pressure make relevance negative', () =>
  Effect.sync(() => {
    const result = LocalRelevance.calculate(
      signals({
        nameOrAliasEvidence: ActivityGateValue.Score.make(0.5),
        cooldownPressure: ActivityGateValue.Pressure.make(1),
      }),
    )

    expect(result.relevance).toBe(0)
  }),
)
