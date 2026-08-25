import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { vi } from 'vitest'

import {
  ActivityGateValue,
  ActivityScoring,
  DynamicThreshold,
  GatePressure,
  LocalRelevance,
} from '../../src/index'

it.effect('performs the complete scoring path without network I/O', () =>
  Effect.acquireUseRelease(
    Effect.sync(() => vi.spyOn(globalThis, 'fetch')),
    (fetchSpy) =>
      Effect.sync(() => {
        const activity = ActivityScoring.update(
          ActivityScoring.UpdateInput.make({
            previousActivity: ActivityGateValue.Score.make(6),
            elapsedMs: ActivityGateValue.Milliseconds.make(60_000),
            message: ActivityScoring.Message.make({
              isDuplicate: false,
              isOtherBot: false,
              isSelf: false,
              isEffective: true,
              isFirstParticipantInWindow: true,
              isQuestion: true,
              hasQuote: false,
              hasMedia: false,
            }),
          }),
        )
        const cooldownPressure = GatePressure.cooldown(
          GatePressure.CooldownInput.make({
            elapsedSinceWakeMs: ActivityGateValue.Milliseconds.make(10_000),
            cooldownMs: GatePressure.DEFAULT_COOLDOWN_MS,
          }),
        )
        const budgetPressure = GatePressure.budget(
          GatePressure.BudgetInput.make({
            used: ActivityGateValue.UsageCount.make(2),
            limit: ActivityGateValue.UsageCount.make(10),
          }),
        )
        const relevance = LocalRelevance.calculate(
          LocalRelevance.Signals.make({
            isDuplicate: false,
            isOtherBot: false,
            isSelf: false,
            explicitMention: false,
            replyToSelf: false,
            mentionDegree: ActivityGateValue.Score.make(0),
            nameOrAliasEvidence: ActivityGateValue.Score.make(1),
            questionOrHelpEvidence: ActivityGateValue.Score.make(1),
            unfinishedItemEvidence: ActivityGateValue.Score.make(0),
            threadOrInterestEvidence: ActivityGateValue.Score.make(0.5),
            recentParticipationPressure: ActivityGateValue.Pressure.make(0),
            sufficientResponsePressure: ActivityGateValue.Pressure.make(0),
            cooldownPressure,
            budgetPressure,
          }),
        )
        const threshold = DynamicThreshold.calculate(
          DynamicThreshold.Input.make({
            baseThreshold: DynamicThreshold.DEFAULT_ACTIVITY_THRESHOLD,
            recentCallPressure: budgetPressure,
            dailyBudgetPressure: budgetPressure,
            recentParticipationPressure: ActivityGateValue.Pressure.make(0),
          }),
        )

        expect(activity.activity).toBeGreaterThan(0)
        expect(relevance.relevance).toBeGreaterThanOrEqual(0)
        expect(threshold).toBeGreaterThanOrEqual(DynamicThreshold.DEFAULT_ACTIVITY_THRESHOLD)
        expect(fetchSpy).not.toHaveBeenCalled()
      }),
    (fetchSpy) => Effect.sync(() => fetchSpy.mockRestore()),
  ),
)
