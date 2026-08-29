import { type Effect, type Option, Schema } from 'effect'
import type { ActionTool, ActionToolInput, CapabilityScope } from 'yokai-protocol'

export const MAX_XML_BYTES = 16_384
export const MAX_XML_DEPTH = 16
export const MAX_XML_ELEMENTS = 1_024
export const MAX_XML_ATTRIBUTES = 128
export const MAX_TEXT_LENGTH = 4_096
export const MAX_TOTAL_TEXT_LENGTH = 12_288
export const MAX_ACTIONS = 8
export const MAX_VISIBLE_ACTION_TOOLS = 16
export const MAX_ACTION_TEMPLATE_BYTES = 16_384
export const MAX_SYSTEM_INSTRUCTION_BYTES = 65_536

export const Message = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_TEXT_LENGTH),
)

export type Message = typeof Message.Type

export const ReplyTarget = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(512),
  Schema.isPattern(/^[^\p{C}]+$/u),
)

export type ReplyTarget = typeof ReplyTarget.Type

export const Decision = Schema.TaggedUnion({
  Silence: {},
  React: { message: Message },
  Reply: {
    message: Message,
    replyTo: Schema.OptionFromNullOr(ReplyTarget),
  },
  FollowUp: { message: Message },
  Initiate: { message: Message },
})

export type Decision = typeof Decision.Type

export const EngagementDirective = Schema.Literals(['extend', 'close'])

export type EngagementDirective = typeof EngagementDirective.Type

export interface ParsedAction {
  readonly tool: ActionTool
  readonly input: ActionToolInput
}

export interface Envelope {
  readonly decision: Decision
  readonly engagement: Option.Option<EngagementDirective>
  readonly actions: ReadonlyArray<ParsedAction>
}

export interface ParseContext {
  readonly replyToMessageIds: ReadonlyArray<string>
}

export interface TurnContext extends ParseContext {
  readonly scope: CapabilityScope
}

export const CompileFailureReason = Schema.Literals([
  'invalid-tool',
  'too-many-tools',
  'duplicate-tool',
  'templates-too-large',
  'prompt-too-large',
  'invalid-template',
  'template-tool-mismatch',
  'template-schema-mismatch',
  'availability-check-failed',
])

export type CompileFailureReason = typeof CompileFailureReason.Type

/** Excludes template text so registration failures cannot leak prompt content. */
export class CompileError extends Schema.TaggedError<CompileError>(
  '@yokai/mind/RoleResponseEnvelope.CompileError',
)('RoleResponseEnvelopeCompileError', {
  reason: CompileFailureReason,
  toolId: Schema.String,
}) {}

export const ParseFailureReason = Schema.Literals([
  'document-too-large',
  'maximum-depth-exceeded',
  'too-many-elements',
  'too-many-attributes',
  'text-too-large',
  'invalid-xml',
  'invalid-envelope',
  'invalid-decision',
  'reply-scope-denied',
  'invalid-directive',
  'too-many-actions',
  'unknown-action-tool',
  'action-scope-denied',
  'invalid-action',
  'invalid-action-input',
])

export type ParseFailureReason = typeof ParseFailureReason.Type

/** Deliberately excludes provider text and model-supplied identifiers. */
export class ParseError extends Schema.TaggedError<ParseError>(
  '@yokai/mind/RoleResponseEnvelope.ParseError',
)('RoleResponseEnvelopeParseError', {
  reason: ParseFailureReason,
}) {}

export interface CompiledProtocol {
  readonly systemInstruction: string
  readonly parse: (source: string, context: ParseContext) => Effect.Effect<Envelope, ParseError>
}
