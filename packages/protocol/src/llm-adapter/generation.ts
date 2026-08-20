import { Schema } from 'effect'

import { AdapterContinuation } from './continuation.js'
import { FeedbackToolDeclarations, ToolCalls, ToolResultBatch } from './feedback-tool.js'
import { AdapterModelId } from './identity.js'
import { ConversationMessage } from './message.js'
import { TokenCount, TokenLimit } from './token.js'

export const GenerationLimits = Schema.Struct({
  maxOutputTokens: TokenLimit,
})

export interface GenerationLimits extends Schema.Schema.Type<typeof GenerationLimits> {}

/**
 * Sampling controls and providerOptions are intentionally absent. Provider-only
 * transport and sampling details stay in adapter configuration.
 */
export const GenerateRequest = Schema.Struct({
  modelId: AdapterModelId,
  systemInstruction: Schema.optionalKey(Schema.NonEmptyString),
  messages: Schema.NonEmptyArray(ConversationMessage),
  limits: GenerationLimits,
  feedbackTools: FeedbackToolDeclarations,
})

export interface GenerateRequest extends Schema.Schema.Type<typeof GenerateRequest> {}

export interface ReportedGenerationUsage {
  readonly _tag: 'Reported'
  readonly inputTokens?: TokenCount
  readonly outputTokens?: TokenCount
  readonly totalTokens?: TokenCount
  readonly cachedInputTokens?: TokenCount
  readonly reasoningOutputTokens?: TokenCount
}

export const UnavailableGenerationUsage = Schema.TaggedStruct('Unavailable', {})

export interface UnavailableGenerationUsage extends Schema.Schema.Type<
  typeof UnavailableGenerationUsage
> {}

const ReportedGenerationUsageValue = Schema.TaggedStruct('Reported', {
  inputTokens: Schema.optionalKey(TokenCount),
  outputTokens: Schema.optionalKey(TokenCount),
  totalTokens: Schema.optionalKey(TokenCount),
  cachedInputTokens: Schema.optionalKey(TokenCount),
  reasoningOutputTokens: Schema.optionalKey(TokenCount),
})

export const ReportedGenerationUsage = ReportedGenerationUsageValue.check(
  Schema.makeFilter((usage: ReportedGenerationUsage) =>
    usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.totalTokens !== undefined ||
    usage.cachedInputTokens !== undefined ||
    usage.reasoningOutputTokens !== undefined
      ? true
      : 'Expected at least one reported token count',
  ),
)

export const GenerationUsage = Schema.Union([
  UnavailableGenerationUsage,
  ReportedGenerationUsage,
]).pipe(Schema.toTaggedUnion('_tag'))

export type GenerationUsage = typeof GenerationUsage.Type

export const TextFinishReason = Schema.Literals([
  'stop',
  'length',
  'content-filter',
  'other',
  'unknown',
])

export type TextFinishReason = typeof TextFinishReason.Type

export const FinalTextResult = Schema.TaggedStruct('Text', {
  text: Schema.NonEmptyString,
  finishReason: TextFinishReason,
  usage: GenerationUsage,
})

export interface FinalTextResult extends Schema.Schema.Type<typeof FinalTextResult> {}

/** Draft text accompanying provider tool calls is deliberately not represented. */
export const ToolCallBatch = Schema.TaggedStruct('ToolCallBatch', {
  calls: ToolCalls,
  continuation: AdapterContinuation,
  usage: GenerationUsage,
})

export interface ToolCallBatch extends Schema.Schema.Type<typeof ToolCallBatch> {}

export const InitialGenerationResult = Schema.Union([FinalTextResult, ToolCallBatch]).pipe(
  Schema.toTaggedUnion('_tag'),
)

export type InitialGenerationResult = typeof InitialGenerationResult.Type

/** No model, messages, or new tools can be supplied during the only continuation. */
export const ContinueRequest = Schema.Struct({
  continuation: AdapterContinuation,
  results: ToolResultBatch,
})

export interface ContinueRequest extends Schema.Schema.Type<typeof ContinueRequest> {}
