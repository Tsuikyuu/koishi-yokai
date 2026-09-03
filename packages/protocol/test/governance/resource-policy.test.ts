import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'

import {
  CALL_BUDGET_POLICY_VERSION,
  DEFAULT_CALL_BUDGET_POLICY,
  DEFAULT_TURN_RESOURCE_POLICY,
  MAX_LOGICAL_CALLS_PER_DAY,
  MAX_LOGICAL_CALLS_PER_MINUTE,
  PLATFORM_CALL_BUDGET_HARD_CAPS,
  PLATFORM_TURN_RESOURCE_HARD_CAPS,
  ResourceReasonCode,
  TURN_RESOURCE_POLICY_VERSION,
  CallBudgetPolicy,
  TurnResourcePolicy,
} from '../../src/governance/resource-policy'

interface BoundaryCase<A> {
  readonly name: string
  readonly minimum: number
  readonly maximum: number
  readonly read: (input: A) => number
  readonly withValue: (input: A, value: number) => A
}

type TurnPolicyInput = typeof TurnResourcePolicy.Encoded

const turnBoundaryCases: ReadonlyArray<BoundaryCase<TurnPolicyInput>> = [
  {
    name: 'recentContext.maxMessages',
    minimum: 20,
    maximum: 80,
    read: (input) => input.recentContext.maxMessages,
    withValue: (input, maxMessages) => ({
      ...input,
      recentContext: { ...input.recentContext, maxMessages },
    }),
  },
  {
    name: 'recentContext.maxTokens',
    minimum: 1,
    maximum: 4_096,
    read: (input) => input.recentContext.maxTokens,
    withValue: (input, maxTokens) => ({
      ...input,
      recentContext: { ...input.recentContext, maxTokens },
    }),
  },
  {
    name: 'contextProviders.maxSelected',
    minimum: 1,
    maximum: 8,
    read: (input) => input.contextProviders.maxSelected,
    withValue: (input, maxSelected) => ({
      ...input,
      contextProviders: { ...input.contextProviders, maxSelected },
    }),
  },
  {
    name: 'contextProviders.perProviderTokens',
    minimum: 1,
    maximum: 2_048,
    read: (input) => input.contextProviders.perProviderTokens,
    withValue: (input, perProviderTokens) => ({
      ...input,
      contextProviders: { ...input.contextProviders, perProviderTokens },
    }),
  },
  {
    name: 'contextProviders.totalTokens',
    minimum: 1,
    maximum: 4_096,
    read: (input) => input.contextProviders.totalTokens,
    withValue: (input, totalTokens) => ({
      ...input,
      contextProviders: { ...input.contextProviders, totalTokens },
    }),
  },
  {
    name: 'contextProviders.deadlineMs',
    minimum: 1,
    maximum: 400,
    read: (input) => input.contextProviders.deadlineMs,
    withValue: (input, deadlineMs) => ({
      ...input,
      contextProviders: { ...input.contextProviders, deadlineMs },
    }),
  },
  {
    name: 'skills.maxSelected',
    minimum: 1,
    maximum: 4,
    read: (input) => input.skills.maxSelected,
    withValue: (input, maxSelected) => ({
      ...input,
      skills: { ...input.skills, maxSelected },
    }),
  },
  {
    name: 'skills.instructionBytes',
    minimum: 1,
    maximum: 16_384,
    read: (input) => input.skills.instructionBytes,
    withValue: (input, instructionBytes) => ({
      ...input,
      skills: { ...input.skills, instructionBytes },
    }),
  },
  {
    name: 'prompt.systemInstructionBytes',
    minimum: 1,
    maximum: 65_536,
    read: (input) => input.prompt.systemInstructionBytes,
    withValue: (input, systemInstructionBytes) => ({
      ...input,
      prompt: { ...input.prompt, systemInstructionBytes },
    }),
  },
  {
    name: 'actionTools.maxVisible',
    minimum: 1,
    maximum: 16,
    read: (input) => input.actionTools.maxVisible,
    withValue: (input, maxVisible) => ({
      ...input,
      actionTools: { ...input.actionTools, maxVisible },
    }),
  },
  {
    name: 'actionTools.perDeclarationBytes',
    minimum: 1,
    maximum: 65_536,
    read: (input) => input.actionTools.perDeclarationBytes,
    withValue: (input, perDeclarationBytes) => ({
      ...input,
      actionTools: { ...input.actionTools, perDeclarationBytes },
    }),
  },
  {
    name: 'actionTools.totalDeclarationBytes',
    minimum: 1,
    maximum: 65_536,
    read: (input) => input.actionTools.totalDeclarationBytes,
    withValue: (input, totalDeclarationBytes) => ({
      ...input,
      actionTools: { ...input.actionTools, totalDeclarationBytes },
    }),
  },
  {
    name: 'actionTools.templateBytes',
    minimum: 1,
    maximum: 16_384,
    read: (input) => input.actionTools.templateBytes,
    withValue: (input, templateBytes) => ({
      ...input,
      actionTools: { ...input.actionTools, templateBytes },
    }),
  },
  {
    name: 'actionTools.maxActions',
    minimum: 1,
    maximum: 8,
    read: (input) => input.actionTools.maxActions,
    withValue: (input, maxActions) => ({
      ...input,
      actionTools: { ...input.actionTools, maxActions },
    }),
  },
  {
    name: 'actionTools.beforeSendDeadlineMs',
    minimum: 1,
    maximum: 750,
    read: (input) => input.actionTools.beforeSendDeadlineMs,
    withValue: (input, beforeSendDeadlineMs) => ({
      ...input,
      actionTools: { ...input.actionTools, beforeSendDeadlineMs },
    }),
  },
  {
    name: 'feedbackTools.maxVisible',
    minimum: 1,
    maximum: 16,
    read: (input) => input.feedbackTools.maxVisible,
    withValue: (input, maxVisible) => ({
      ...input,
      feedbackTools: { ...input.feedbackTools, maxVisible },
    }),
  },
  {
    name: 'feedbackTools.perDeclarationBytes',
    minimum: 1,
    maximum: 65_536,
    read: (input) => input.feedbackTools.perDeclarationBytes,
    withValue: (input, perDeclarationBytes) => ({
      ...input,
      feedbackTools: { ...input.feedbackTools, perDeclarationBytes },
    }),
  },
  {
    name: 'feedbackTools.totalDeclarationBytes',
    minimum: 1,
    maximum: 65_536,
    read: (input) => input.feedbackTools.totalDeclarationBytes,
    withValue: (input, totalDeclarationBytes) => ({
      ...input,
      feedbackTools: { ...input.feedbackTools, totalDeclarationBytes },
    }),
  },
  {
    name: 'feedbackTools.maxCalls',
    minimum: 1,
    maximum: 4,
    read: (input) => input.feedbackTools.maxCalls,
    withValue: (input, maxCalls) => ({
      ...input,
      feedbackTools: { ...input.feedbackTools, maxCalls },
    }),
  },
  {
    name: 'feedbackTools.totalResultTokens',
    minimum: 1,
    maximum: 8_192,
    read: (input) => input.feedbackTools.totalResultTokens,
    withValue: (input, totalResultTokens) => ({
      ...input,
      feedbackTools: { ...input.feedbackTools, totalResultTokens },
    }),
  },
  {
    name: 'feedbackTools.maxConcurrency',
    minimum: 1,
    maximum: 4,
    read: (input) => input.feedbackTools.maxConcurrency,
    withValue: (input, maxConcurrency) => ({
      ...input,
      feedbackTools: { ...input.feedbackTools, maxConcurrency },
    }),
  },
  {
    name: 'generation.maxOutputTokens',
    minimum: 1,
    maximum: 1_024,
    read: (input) => input.generation.maxOutputTokens,
    withValue: (input, maxOutputTokens) => ({
      ...input,
      generation: { ...input.generation, maxOutputTokens },
    }),
  },
  {
    name: 'generation.turnDeadlineMs',
    minimum: 1,
    maximum: 45_000,
    read: (input) => input.generation.turnDeadlineMs,
    withValue: (input, turnDeadlineMs) => ({
      ...input,
      generation: { ...input.generation, turnDeadlineMs },
    }),
  },
]

for (const boundary of turnBoundaryCases) {
  it.effect(`accepts the lower and platform-hard boundaries for ${boundary.name}`, () =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(TurnResourcePolicy)(
        boundary.withValue(PLATFORM_TURN_RESOURCE_HARD_CAPS, boundary.minimum),
      )
      yield* Schema.decodeUnknownEffect(TurnResourcePolicy)(
        boundary.withValue(PLATFORM_TURN_RESOURCE_HARD_CAPS, boundary.maximum),
      )
      expect(boundary.read(PLATFORM_TURN_RESOURCE_HARD_CAPS)).toBe(boundary.maximum)
    }),
  )

  it.effect(`rejects non-integer, unsafe, or out-of-range ${boundary.name}`, () =>
    Effect.gen(function* () {
      const errors = yield* Effect.all(
        [
          boundary.minimum - 1,
          boundary.maximum + 1,
          boundary.minimum + 0.5,
          Number.MAX_SAFE_INTEGER + 1,
        ].map((value) =>
          Schema.decodeUnknownEffect(TurnResourcePolicy)(
            boundary.withValue(PLATFORM_TURN_RESOURCE_HARD_CAPS, value),
          ).pipe(Effect.flip),
        ),
      )

      expect(errors.every(Schema.isSchemaError)).toBe(true)
    }),
  )
}

it('publishes the versioned default Turn resource policy', () => {
  expect(DEFAULT_TURN_RESOURCE_POLICY).toEqual({
    version: TURN_RESOURCE_POLICY_VERSION,
    recentContext: { maxMessages: 40, maxTokens: 4_096 },
    contextProviders: {
      maxSelected: 8,
      perProviderTokens: 2_048,
      totalTokens: 4_096,
      deadlineMs: 400,
    },
    skills: { maxSelected: 4, instructionBytes: 16_384 },
    prompt: { systemInstructionBytes: 65_536 },
    actionTools: {
      maxVisible: 16,
      perDeclarationBytes: 65_536,
      totalDeclarationBytes: 65_536,
      templateBytes: 16_384,
      maxActions: 8,
      beforeSendDeadlineMs: 750,
    },
    feedbackTools: {
      maxVisible: 16,
      perDeclarationBytes: 65_536,
      totalDeclarationBytes: 65_536,
      maxCalls: 4,
      totalResultTokens: 8_192,
      maxConcurrency: 4,
    },
    generation: { maxOutputTokens: 1_024, turnDeadlineMs: 45_000 },
  })
})

it.effect('round-trips the Turn policy wire shape and rejects another version', () =>
  Effect.gen(function* () {
    expect(yield* Schema.encodeEffect(TurnResourcePolicy)(DEFAULT_TURN_RESOURCE_POLICY)).toEqual(
      DEFAULT_TURN_RESOURCE_POLICY,
    )

    const invalid = yield* Schema.decodeUnknownEffect(TurnResourcePolicy)({
      ...DEFAULT_TURN_RESOURCE_POLICY,
      version: TURN_RESOURCE_POLICY_VERSION + 1,
    }).pipe(Effect.flip)
    expect(Schema.isSchemaError(invalid)).toBe(true)
  }),
)

type CallBudgetPolicyInput = typeof CallBudgetPolicy.Encoded

const callBudgetBoundaryCases: ReadonlyArray<BoundaryCase<CallBudgetPolicyInput>> = [
  ...(['reserved', 'normal', 'background'] as const).flatMap((category) => [
    {
      name: `${category}.minute`,
      minimum: 0,
      maximum: MAX_LOGICAL_CALLS_PER_MINUTE,
      read: (input: CallBudgetPolicyInput) => input[category].minute,
      withValue: (input: CallBudgetPolicyInput, minute: number) => ({
        ...input,
        [category]: { ...input[category], minute },
      }),
    },
    {
      name: `${category}.day`,
      minimum: 0,
      maximum: MAX_LOGICAL_CALLS_PER_DAY,
      read: (input: CallBudgetPolicyInput) => input[category].day,
      withValue: (input: CallBudgetPolicyInput, day: number) => ({
        ...input,
        [category]: { ...input[category], day },
      }),
    },
  ]),
]

for (const boundary of callBudgetBoundaryCases) {
  it.effect(`accepts zero and the platform-hard boundary for ${boundary.name}`, () =>
    Effect.gen(function* () {
      const atHardCaps: CallBudgetPolicyInput = {
        ...DEFAULT_CALL_BUDGET_POLICY,
        ...PLATFORM_CALL_BUDGET_HARD_CAPS,
      }
      yield* Schema.decodeUnknownEffect(CallBudgetPolicy)(
        boundary.withValue(atHardCaps, boundary.minimum),
      )
      yield* Schema.decodeUnknownEffect(CallBudgetPolicy)(
        boundary.withValue(atHardCaps, boundary.maximum),
      )
      expect(boundary.read(atHardCaps)).toBe(boundary.maximum)
    }),
  )

  it.effect(`rejects non-integer, unsafe, or out-of-range ${boundary.name}`, () =>
    Effect.gen(function* () {
      const errors = yield* Effect.all(
        [-1, boundary.maximum + 1, 0.5, Number.MAX_SAFE_INTEGER + 1].map((value) =>
          Schema.decodeUnknownEffect(CallBudgetPolicy)(
            boundary.withValue(DEFAULT_CALL_BUDGET_POLICY, value),
          ).pipe(Effect.flip),
        ),
      )

      expect(errors.every(Schema.isSchemaError)).toBe(true)
    }),
  )
}

it.effect('validates the Call budget version and IANA day-window time zone', () =>
  Effect.gen(function* () {
    const accepted = yield* Schema.decodeUnknownEffect(CallBudgetPolicy)({
      ...DEFAULT_CALL_BUDGET_POLICY,
      timeZone: 'Asia/Shanghai',
    })
    expect(accepted.timeZone).toBe('Asia/Shanghai')
    expect(yield* Schema.encodeEffect(CallBudgetPolicy)(accepted)).toEqual({
      ...DEFAULT_CALL_BUDGET_POLICY,
      timeZone: 'Asia/Shanghai',
    })
    const etcZone = yield* Schema.decodeUnknownEffect(CallBudgetPolicy)({
      ...DEFAULT_CALL_BUDGET_POLICY,
      timeZone: 'Etc/GMT+8',
    })
    expect(etcZone.timeZone).toBe('Etc/GMT+8')

    const errors = yield* Effect.all(
      [
        { ...DEFAULT_CALL_BUDGET_POLICY, version: CALL_BUDGET_POLICY_VERSION + 1 },
        { ...DEFAULT_CALL_BUDGET_POLICY, timeZone: 'Mars/Olympus' },
        { ...DEFAULT_CALL_BUDGET_POLICY, timeZone: ' UTC ' },
        { ...DEFAULT_CALL_BUDGET_POLICY, timeZone: '+08:00' },
        { ...DEFAULT_CALL_BUDGET_POLICY, timeZone: '-05:30' },
      ].map((input) => Schema.decodeUnknownEffect(CallBudgetPolicy)(input).pipe(Effect.flip)),
    )
    expect(errors.every(Schema.isSchemaError)).toBe(true)
  }),
)

it('publishes the existing classified Call budget defaults', () => {
  expect(DEFAULT_CALL_BUDGET_POLICY).toEqual({
    version: CALL_BUDGET_POLICY_VERSION,
    timeZone: 'UTC',
    reserved: { minute: 6, day: 200 },
    normal: { minute: 2, day: 100 },
    background: { minute: 1, day: 20 },
  })
})

it.effect('keeps the documented resource omission reason codes stable', () =>
  Effect.gen(function* () {
    const reasons = [
      'count-cap',
      'token-cap',
      'declaration-item-byte-cap',
      'declaration-total-byte-cap',
      'template-byte-cap',
      'system-prompt-cap',
    ] as const
    const decoded = yield* Effect.forEach(reasons, (reason) =>
      Schema.decodeUnknownEffect(ResourceReasonCode)(reason),
    )
    expect(decoded).toEqual(reasons)

    const invalid = yield* Schema.decodeUnknownEffect(ResourceReasonCode)('duration-cap').pipe(
      Effect.flip,
    )
    expect(Schema.isSchemaError(invalid)).toBe(true)
  }),
)
