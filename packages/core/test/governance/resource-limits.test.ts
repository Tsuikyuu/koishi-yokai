import { RoleResponseEnvelope } from '@yokai-internal/mind'
import { expect, it } from '@effect/vitest'
import { DEFAULT_TURN_RESOURCE_POLICY, PLATFORM_TURN_RESOURCE_HARD_CAPS } from 'yokai-protocol'
import { Option } from 'effect'

import {
  ActionExecution,
  CapabilitySelection,
  ContextAssembly,
  ResourceLimits,
  TurnSnapshot,
  WakeTurn,
} from '../../src/index'

const absent = Option.none<number>()

it('takes the minimum of every applicable resource authority', () => {
  expect(
    ResourceLimits.minimumApplicable({
      platform: 80,
      policy: 64,
      registered: Option.some(48),
      model: Option.some(32),
      remaining: Option.some(16),
    }),
  ).toBe(16)

  expect(
    ResourceLimits.minimumApplicable({
      platform: 80,
      policy: 64,
      registered: Option.some(48),
      model: Option.some(32),
      remaining: absent,
    }),
  ).toBe(32)

  expect(
    ResourceLimits.minimumApplicable({
      platform: 80,
      policy: 64,
      registered: absent,
      model: absent,
      remaining: absent,
    }),
  ).toBe(64)
})

it('never lets policy widen platform, registration, or model limits', () => {
  const cases: ReadonlyArray<ResourceLimits.Input> = [
    {
      platform: 16,
      policy: 64,
      registered: Option.some(32),
      model: Option.some(48),
      remaining: absent,
    },
    {
      platform: 64,
      policy: 48,
      registered: Option.some(16),
      model: Option.some(32),
      remaining: absent,
    },
    {
      platform: 64,
      policy: 48,
      registered: Option.some(32),
      model: Option.some(16),
      remaining: absent,
    },
  ]

  expect(cases.map(ResourceLimits.minimumApplicable)).toEqual([16, 16, 16])
})

it('allows exhausted turn headroom to tighten an otherwise positive limit to zero', () => {
  expect(
    ResourceLimits.minimumApplicable({
      platform: 64,
      policy: 64,
      registered: absent,
      model: absent,
      remaining: Option.some(0),
    }),
  ).toBe(0)
})

it('keeps the default resource policy equivalent to the current runtime constants', () => {
  expect(DEFAULT_TURN_RESOURCE_POLICY.recentContext).toEqual({
    maxMessages: TurnSnapshot.DEFAULT_MESSAGE_COUNT,
    maxTokens: TurnSnapshot.DEFAULT_TOKEN_BUDGET,
  })
  expect(DEFAULT_TURN_RESOURCE_POLICY.contextProviders).toEqual({
    maxSelected: ContextAssembly.MAX_CONTEXT_PROVIDERS,
    perProviderTokens: ContextAssembly.MAX_CONTEXT_PROVIDER_TOKENS,
    totalTokens: ContextAssembly.MAX_CONTEXT_TOTAL_TOKENS,
    deadlineMs: ContextAssembly.CONTEXT_TOTAL_DEADLINE_MS,
  })
  expect(DEFAULT_TURN_RESOURCE_POLICY.skills).toEqual({
    maxSelected: CapabilitySelection.MAX_SELECTED_SKILLS,
    instructionBytes: CapabilitySelection.MAX_SKILL_SYSTEM_INSTRUCTION_BYTES,
  })
  expect(DEFAULT_TURN_RESOURCE_POLICY.prompt.systemInstructionBytes).toBe(
    WakeTurn.MAX_TURN_SYSTEM_INSTRUCTION_BYTES,
  )
  expect(DEFAULT_TURN_RESOURCE_POLICY.actionTools).toEqual({
    maxVisible: RoleResponseEnvelope.MAX_VISIBLE_ACTION_TOOLS,
    perDeclarationBytes: 65_536,
    totalDeclarationBytes: 65_536,
    templateBytes: RoleResponseEnvelope.MAX_ACTION_TEMPLATE_BYTES,
    maxActions: RoleResponseEnvelope.MAX_ACTIONS,
    beforeSendDeadlineMs: ActionExecution.BEFORE_SEND_TOTAL_DEADLINE_MS,
  })
  expect(DEFAULT_TURN_RESOURCE_POLICY.feedbackTools).toEqual({
    maxVisible: CapabilitySelection.MAX_SELECTED_FEEDBACK_TOOLS,
    perDeclarationBytes: 65_536,
    totalDeclarationBytes: 65_536,
    maxCalls: 4,
    totalResultTokens: 8_192,
    maxConcurrency: 4,
  })
  expect(DEFAULT_TURN_RESOURCE_POLICY.generation).toEqual({
    maxOutputTokens: 1_024,
    turnDeadlineMs: WakeTurn.MODEL_TURN_DEADLINE_MS,
  })
})

it('publishes declaration exposure defaults at the platform hard caps', () => {
  expect(DEFAULT_TURN_RESOURCE_POLICY.actionTools.perDeclarationBytes).toBe(
    PLATFORM_TURN_RESOURCE_HARD_CAPS.actionTools.perDeclarationBytes,
  )
  expect(DEFAULT_TURN_RESOURCE_POLICY.actionTools.totalDeclarationBytes).toBe(
    PLATFORM_TURN_RESOURCE_HARD_CAPS.actionTools.totalDeclarationBytes,
  )
  expect(DEFAULT_TURN_RESOURCE_POLICY.feedbackTools.perDeclarationBytes).toBe(
    PLATFORM_TURN_RESOURCE_HARD_CAPS.feedbackTools.perDeclarationBytes,
  )
  expect(DEFAULT_TURN_RESOURCE_POLICY.feedbackTools.totalDeclarationBytes).toBe(
    PLATFORM_TURN_RESOURCE_HARD_CAPS.feedbackTools.totalDeclarationBytes,
  )
})
