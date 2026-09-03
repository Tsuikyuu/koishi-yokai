import { DateTime, Option, Schema } from 'effect'

export const TURN_RESOURCE_POLICY_VERSION = 1
export const CALL_BUDGET_POLICY_VERSION = 1

export const MIN_RECENT_CONTEXT_MESSAGES = 20
export const MAX_RECENT_CONTEXT_MESSAGES = 80
export const MAX_LOGICAL_CALLS_PER_MINUTE = 10_000
export const MAX_LOGICAL_CALLS_PER_DAY = 1_000_000
export const MAX_CALL_BUDGET_TIME_ZONE_ID_LENGTH = 128

const IANA_TIME_ZONE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/

const positiveSafeInteger = (maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum }))

const recentContextMessages = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_RECENT_CONTEXT_MESSAGES,
    maximum: MAX_RECENT_CONTEXT_MESSAGES,
  }),
)

const RecentContextResourcePolicy = Schema.Struct({
  maxMessages: recentContextMessages,
  maxTokens: positiveSafeInteger(4_096),
})

const ContextProviderResourcePolicy = Schema.Struct({
  maxSelected: positiveSafeInteger(8),
  perProviderTokens: positiveSafeInteger(2_048),
  totalTokens: positiveSafeInteger(4_096),
  deadlineMs: positiveSafeInteger(400),
})

const SkillResourcePolicy = Schema.Struct({
  maxSelected: positiveSafeInteger(4),
  instructionBytes: positiveSafeInteger(16_384),
})

const PromptResourcePolicy = Schema.Struct({
  systemInstructionBytes: positiveSafeInteger(65_536),
})

const ActionToolResourcePolicy = Schema.Struct({
  maxVisible: positiveSafeInteger(16),
  perDeclarationBytes: positiveSafeInteger(65_536),
  totalDeclarationBytes: positiveSafeInteger(65_536),
  templateBytes: positiveSafeInteger(16_384),
  maxActions: positiveSafeInteger(8),
  beforeSendDeadlineMs: positiveSafeInteger(750),
})

const FeedbackToolResourcePolicy = Schema.Struct({
  maxVisible: positiveSafeInteger(16),
  perDeclarationBytes: positiveSafeInteger(65_536),
  totalDeclarationBytes: positiveSafeInteger(65_536),
  maxCalls: positiveSafeInteger(4),
  totalResultTokens: positiveSafeInteger(8_192),
  maxConcurrency: positiveSafeInteger(4),
})

const GenerationResourcePolicy = Schema.Struct({
  maxOutputTokens: positiveSafeInteger(1_024),
  turnDeadlineMs: positiveSafeInteger(45_000),
})

export const TurnResourcePolicy = Schema.Struct({
  version: Schema.Literal(TURN_RESOURCE_POLICY_VERSION),
  recentContext: RecentContextResourcePolicy,
  contextProviders: ContextProviderResourcePolicy,
  skills: SkillResourcePolicy,
  prompt: PromptResourcePolicy,
  actionTools: ActionToolResourcePolicy,
  feedbackTools: FeedbackToolResourcePolicy,
  generation: GenerationResourcePolicy,
})

export interface TurnResourcePolicy extends Schema.Schema.Type<typeof TurnResourcePolicy> {}

export const PLATFORM_TURN_RESOURCE_HARD_CAPS = TurnResourcePolicy.make({
  version: TURN_RESOURCE_POLICY_VERSION,
  recentContext: {
    maxMessages: MAX_RECENT_CONTEXT_MESSAGES,
    maxTokens: 4_096,
  },
  contextProviders: {
    maxSelected: 8,
    perProviderTokens: 2_048,
    totalTokens: 4_096,
    deadlineMs: 400,
  },
  skills: {
    maxSelected: 4,
    instructionBytes: 16_384,
  },
  prompt: {
    systemInstructionBytes: 65_536,
  },
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
  generation: {
    maxOutputTokens: 1_024,
    turnDeadlineMs: 45_000,
  },
})

export const DEFAULT_TURN_RESOURCE_POLICY = TurnResourcePolicy.make({
  ...PLATFORM_TURN_RESOURCE_HARD_CAPS,
  recentContext: {
    ...PLATFORM_TURN_RESOURCE_HARD_CAPS.recentContext,
    maxMessages: 40,
  },
})

export const CallBudgetTimeZoneId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_CALL_BUDGET_TIME_ZONE_ID_LENGTH),
  Schema.isPattern(IANA_TIME_ZONE_ID_PATTERN),
  Schema.makeFilter((timeZone: string) =>
    Option.isSome(DateTime.zoneMakeNamed(timeZone))
      ? true
      : 'Expected an IANA time zone identifier',
  ),
).pipe(Schema.brand('@yokai/protocol/CallBudgetTimeZoneId'))

export type CallBudgetTimeZoneId = typeof CallBudgetTimeZoneId.Type

const CallBudgetWindowPolicy = Schema.Struct({
  minute: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_LOGICAL_CALLS_PER_MINUTE })),
  day: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_LOGICAL_CALLS_PER_DAY })),
})

const ClassifiedCallBudgetPolicy = Schema.Struct({
  reserved: CallBudgetWindowPolicy,
  normal: CallBudgetWindowPolicy,
  background: CallBudgetWindowPolicy,
})

export const CallBudgetPolicy = Schema.Struct({
  version: Schema.Literal(CALL_BUDGET_POLICY_VERSION),
  timeZone: CallBudgetTimeZoneId,
  ...ClassifiedCallBudgetPolicy.fields,
})

export interface CallBudgetPolicy extends Schema.Schema.Type<typeof CallBudgetPolicy> {}

export const PLATFORM_CALL_BUDGET_HARD_CAPS = ClassifiedCallBudgetPolicy.make({
  reserved: { minute: MAX_LOGICAL_CALLS_PER_MINUTE, day: MAX_LOGICAL_CALLS_PER_DAY },
  normal: { minute: MAX_LOGICAL_CALLS_PER_MINUTE, day: MAX_LOGICAL_CALLS_PER_DAY },
  background: { minute: MAX_LOGICAL_CALLS_PER_MINUTE, day: MAX_LOGICAL_CALLS_PER_DAY },
})

export const DEFAULT_CALL_BUDGET_POLICY = CallBudgetPolicy.make({
  version: CALL_BUDGET_POLICY_VERSION,
  timeZone: CallBudgetTimeZoneId.make('UTC'),
  reserved: { minute: 6, day: 200 },
  normal: { minute: 2, day: 100 },
  background: { minute: 1, day: 20 },
})

export const ResourceReasonCode = Schema.Literals([
  'count-cap',
  'token-cap',
  'declaration-item-byte-cap',
  'declaration-total-byte-cap',
  'template-byte-cap',
  'system-prompt-cap',
])

export type ResourceReasonCode = typeof ResourceReasonCode.Type
