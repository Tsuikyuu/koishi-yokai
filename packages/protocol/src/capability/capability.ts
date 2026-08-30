import { Effect, Schema, type Option } from 'effect'

import {
  FeedbackToolDeclaration,
  MAX_FEEDBACK_TOOL_DESCRIPTION_LENGTH,
} from '../llm-adapter/feedback-tool'
import { FeedbackToolId } from '../llm-adapter/identity'
import { PortableToolInputSchema, PortableToolOutputSchema } from '../llm-adapter/portable-schema'
import { TokenCount, TokenLimit } from '../llm-adapter/token'

const capabilityIdChecks = [
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9._-]*$/),
] as const

export const ContextProviderId = Schema.String.check(...capabilityIdChecks).pipe(
  Schema.brand('@yokai/protocol/ContextProviderId'),
)

export type ContextProviderId = typeof ContextProviderId.Type

export const HISTORY_CONTEXT_PROVIDER_ID = ContextProviderId.make('history.context')

export const NOTEBOOK_CONTEXT_PROVIDER_ID = ContextProviderId.make('notebook.context')

export const ActionToolId = Schema.String.check(...capabilityIdChecks).pipe(
  Schema.brand('@yokai/protocol/ActionToolId'),
)

export type ActionToolId = typeof ActionToolId.Type

export const NOTEBOOK_WRITE_ACTION_TOOL_ID = ActionToolId.make('notebook.write')

export const SkillId = Schema.String.check(...capabilityIdChecks).pipe(
  Schema.brand('@yokai/protocol/SkillId'),
)

export type SkillId = typeof SkillId.Type

export const McpServerId = Schema.String.check(...capabilityIdChecks).pipe(
  Schema.brand('@yokai/protocol/McpServerId'),
)

export type McpServerId = typeof McpServerId.Type

export const PresetSourceId = Schema.String.check(...capabilityIdChecks).pipe(
  Schema.brand('@yokai/protocol/PresetSourceId'),
)

export type PresetSourceId = typeof PresetSourceId.Type

export const ResponseMechanismId = Schema.String.check(...capabilityIdChecks).pipe(
  Schema.brand('@yokai/protocol/ResponseMechanismId'),
)

export type ResponseMechanismId = typeof ResponseMechanismId.Type

export const CapabilityProtocolVersion = Schema.Struct({
  major: Schema.Natural,
  minor: Schema.Natural,
})

export interface CapabilityProtocolVersion extends Schema.Schema.Type<
  typeof CapabilityProtocolVersion
> {}

export const CapabilityDurationMilliseconds = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand('@yokai/protocol/CapabilityDurationMilliseconds'),
)

export type CapabilityDurationMilliseconds = typeof CapabilityDurationMilliseconds.Type

const CapabilityScopeIdentifier = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(512),
  Schema.isPattern(/^[^\p{C}]+$/u),
)

export const CapabilityScope = Schema.Struct({
  instanceId: CapabilityScopeIdentifier,
  platform: CapabilityScopeIdentifier,
  guildId: CapabilityScopeIdentifier,
  channelId: CapabilityScopeIdentifier,
})

export interface CapabilityScope extends Schema.Schema.Type<typeof CapabilityScope> {}

export const FocusMessage = Schema.Struct({
  messageId: CapabilityScopeIdentifier,
  authorId: CapabilityScopeIdentifier,
  timestamp: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  content: Schema.String,
})

export interface FocusMessage extends Schema.Schema.Type<typeof FocusMessage> {}

export const ContextProviderRequest = Schema.Struct({
  scope: CapabilityScope,
  focus: FocusMessage,
  tokenBudget: TokenLimit,
})

export interface ContextProviderRequest extends Schema.Schema.Type<typeof ContextProviderRequest> {}

export const MAX_CONTEXT_FRAGMENT_LABEL_LENGTH = 256
export const MAX_CONTEXT_FRAGMENT_CONTENT_LENGTH = 8_192
export const MAX_CONTEXT_FRAGMENT_SOURCE_REFS = 128
export const MAX_CONTEXT_FRAGMENT_SOURCE_REF_LENGTH = 512

export const ContextFragment = Schema.Struct({
  providerId: ContextProviderId,
  label: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_CONTEXT_FRAGMENT_LABEL_LENGTH),
  ),
  content: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_CONTEXT_FRAGMENT_CONTENT_LENGTH),
  ),
  sourceRefs: Schema.Array(
    Schema.String.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(MAX_CONTEXT_FRAGMENT_SOURCE_REF_LENGTH),
    ),
  ).check(Schema.isMaxLength(MAX_CONTEXT_FRAGMENT_SOURCE_REFS)),
  untrusted: Schema.Boolean,
  estimatedTokens: TokenCount,
})

export interface ContextFragment extends Schema.Schema.Type<typeof ContextFragment> {}

export const ContextProviderFailureReason = Schema.Literals([
  'unavailable',
  'invalid-scope',
  'budget-exceeded',
  'execution-failed',
])

export type ContextProviderFailureReason = typeof ContextProviderFailureReason.Type

export class ContextProviderError extends Schema.TaggedError<ContextProviderError>(
  '@yokai/protocol/ContextProviderError',
)('ContextProviderError', {
  providerId: ContextProviderId,
  reason: ContextProviderFailureReason,
}) {}

export type ContextProviderProvide = (
  request: ContextProviderRequest,
) => Effect.Effect<Option.Option<ContextFragment>, ContextProviderError>

const ContextProviderProvideSchema = Schema.declare(
  (value): value is ContextProviderProvide => typeof value === 'function',
)

/** A synchronous, side-effect-free visibility check for the frozen turn scope. */
export type ContextProviderIsAvailable = (scope: CapabilityScope) => boolean

const ContextProviderIsAvailableSchema = Schema.declare(
  (value): value is ContextProviderIsAvailable => typeof value === 'function',
)

export const ContextProvider = Schema.Struct({
  id: ContextProviderId,
  protocolVersion: CapabilityProtocolVersion,
  description: Schema.NonEmptyString,
  maxTokens: TokenLimit,
  maxDurationMs: CapabilityDurationMilliseconds,
  isAvailable: ContextProviderIsAvailableSchema,
  provide: ContextProviderProvideSchema,
})

export interface ContextProvider extends Schema.Schema.Type<typeof ContextProvider> {}

export const MAX_ACTION_TOOL_DESCRIPTION_LENGTH = 2048
export const MAX_ACTION_TOOL_XML_TEMPLATE_LENGTH = 16_384

export const ActionToolXmlTemplate = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_ACTION_TOOL_XML_TEMPLATE_LENGTH),
).pipe(Schema.brand('@yokai/protocol/ActionToolXmlTemplate'))

export type ActionToolXmlTemplate = typeof ActionToolXmlTemplate.Type

export const ActionToolExecutionStage = Schema.Literals(['before-send', 'after-send', 'deferred'])

export type ActionToolExecutionStage = typeof ActionToolExecutionStage.Type

export const ActionToolCompletionPolicy = Schema.Literals(['none', 'wake'])

export type ActionToolCompletionPolicy = typeof ActionToolCompletionPolicy.Type

export const ActionToolFailurePolicy = Schema.Literals(['continue', 'block-reply'])

export type ActionToolFailurePolicy = typeof ActionToolFailurePolicy.Type

/** @deprecated Use CapabilityDurationMilliseconds for all capability time limits. */
export const ActionToolDurationMilliseconds = CapabilityDurationMilliseconds

/** @deprecated Use CapabilityDurationMilliseconds for all capability time limits. */
export type ActionToolDurationMilliseconds = CapabilityDurationMilliseconds

/** A synchronous, side-effect-free visibility check for the frozen turn scope. */
export type ActionToolIsAvailable = (scope: CapabilityScope) => boolean

const ActionToolIsAvailableSchema = Schema.declare(
  (value): value is ActionToolIsAvailable => typeof value === 'function',
)

export const ActionToolInput = Schema.Record(Schema.String, Schema.Json)

export interface ActionToolInput extends Schema.Schema.Type<typeof ActionToolInput> {}

export const ActionToolRequest = Schema.Struct({
  scope: CapabilityScope,
  input: ActionToolInput,
})

export interface ActionToolRequest extends Schema.Schema.Type<typeof ActionToolRequest> {}

export const ActionToolExecutionReason = Schema.Literals([
  'timeout',
  'unavailable',
  'execution-failed',
])

export type ActionToolExecutionReason = typeof ActionToolExecutionReason.Type

export class ActionToolExecutionError extends Schema.TaggedError<ActionToolExecutionError>(
  '@yokai/protocol/ActionToolExecutionError',
)('ActionToolExecutionError', {
  toolId: ActionToolId,
  reason: ActionToolExecutionReason,
}) {}

export type ActionToolExecute = (
  request: ActionToolRequest,
) => Effect.Effect<void, ActionToolExecutionError>

const ActionToolExecuteSchema = Schema.declare(
  (value): value is ActionToolExecute => typeof value === 'function',
)

/** A synchronous, side-effect-free authorization check over fully decoded input. */
export type ActionToolIsInputAllowed = (scope: CapabilityScope, input: ActionToolInput) => boolean

const ActionToolIsInputAllowedSchema = Schema.declare(
  (value): value is ActionToolIsInputAllowed => typeof value === 'function',
)

const ActionToolRegistration = Schema.Struct({
  id: ActionToolId,
  protocolVersion: CapabilityProtocolVersion,
  description: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_ACTION_TOOL_DESCRIPTION_LENGTH),
  ),
  xmlTemplate: ActionToolXmlTemplate,
  inputSchema: PortableToolInputSchema,
  executionStage: ActionToolExecutionStage,
  completionPolicy: ActionToolCompletionPolicy,
  failurePolicy: ActionToolFailurePolicy,
  maxDurationMs: CapabilityDurationMilliseconds,
  isAvailable: ActionToolIsAvailableSchema,
  isInputAllowed: ActionToolIsInputAllowedSchema,
  execute: ActionToolExecuteSchema,
})

interface ActionToolRegistration extends Schema.Schema.Type<typeof ActionToolRegistration> {}

export const ActionTool = ActionToolRegistration.check(
  Schema.makeFilter((tool: ActionToolRegistration) => {
    if (tool.failurePolicy === 'block-reply' && tool.executionStage !== 'before-send') {
      return 'Expected block-reply ActionTool failure policy only at before-send stage'
    }
    return tool.completionPolicy === 'wake' && tool.executionStage !== 'deferred'
      ? 'Expected wake ActionTool completion policy only at deferred stage'
      : true
  }),
)

export interface ActionTool extends Schema.Schema.Type<typeof ActionTool> {}

export const FeedbackToolRequest = Schema.Struct({
  scope: CapabilityScope,
  input: Schema.Record(Schema.String, Schema.Json),
})

export interface FeedbackToolRequest extends Schema.Schema.Type<typeof FeedbackToolRequest> {}

export const FeedbackToolValidationReason = Schema.Literals([
  'invalid-input',
  'scope-denied',
  'budget-exceeded',
  'unavailable',
])

export type FeedbackToolValidationReason = typeof FeedbackToolValidationReason.Type

export class FeedbackToolValidationError extends Schema.TaggedError<FeedbackToolValidationError>(
  '@yokai/protocol/FeedbackToolValidationError',
)('FeedbackToolValidationError', {
  toolId: FeedbackToolId,
  reason: FeedbackToolValidationReason,
}) {}

export const FeedbackToolExecutionReason = Schema.Literals([
  'timeout',
  'unavailable',
  'execution-failed',
  'invalid-output',
  'result-too-large',
])

export type FeedbackToolExecutionReason = typeof FeedbackToolExecutionReason.Type

export class FeedbackToolExecutionError extends Schema.TaggedError<FeedbackToolExecutionError>(
  '@yokai/protocol/FeedbackToolExecutionError',
)('FeedbackToolExecutionError', {
  toolId: FeedbackToolId,
  reason: FeedbackToolExecutionReason,
}) {}

export interface PreparedFeedbackToolCall {
  readonly execute: () => Effect.Effect<Schema.Json, FeedbackToolExecutionError>
}

export type FeedbackToolPrepare = (
  request: FeedbackToolRequest,
) => Effect.Effect<PreparedFeedbackToolCall, FeedbackToolValidationError>

const FeedbackToolPrepareSchema = Schema.declare(
  (value): value is FeedbackToolPrepare => typeof value === 'function',
)

/** A synchronous, side-effect-free visibility check for the frozen turn scope. */
export type FeedbackToolIsAvailable = (scope: CapabilityScope) => boolean

const FeedbackToolIsAvailableSchema = Schema.declare(
  (value): value is FeedbackToolIsAvailable => typeof value === 'function',
)

export const FeedbackTool = Schema.Struct({
  id: FeedbackToolId,
  protocolVersion: CapabilityProtocolVersion,
  description: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_FEEDBACK_TOOL_DESCRIPTION_LENGTH),
  ),
  inputSchema: PortableToolInputSchema,
  outputSchema: PortableToolOutputSchema,
  maxResultTokens: TokenLimit,
  maxDurationMs: CapabilityDurationMilliseconds,
  isAvailable: FeedbackToolIsAvailableSchema,
  prepare: FeedbackToolPrepareSchema,
})

export interface FeedbackTool extends Schema.Schema.Type<typeof FeedbackTool> {}

export const HISTORY_SEARCH_FEEDBACK_TOOL_ID = FeedbackToolId.make('history.search')

export const feedbackToolDeclaration = (tool: FeedbackTool): FeedbackToolDeclaration =>
  FeedbackToolDeclaration.make({
    id: tool.id,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })

export const Skill = Schema.Struct({
  id: SkillId,
  protocolVersion: CapabilityProtocolVersion,
})

export interface Skill extends Schema.Schema.Type<typeof Skill> {}

export const McpServer = Schema.Struct({
  id: McpServerId,
  protocolVersion: CapabilityProtocolVersion,
})

export interface McpServer extends Schema.Schema.Type<typeof McpServer> {}

export const PresetSource = Schema.Struct({
  id: PresetSourceId,
  protocolVersion: CapabilityProtocolVersion,
})

export interface PresetSource extends Schema.Schema.Type<typeof PresetSource> {}

export const ResponseMechanism = Schema.Struct({
  id: ResponseMechanismId,
  protocolVersion: CapabilityProtocolVersion,
})

export interface ResponseMechanism extends Schema.Schema.Type<typeof ResponseMechanism> {}
