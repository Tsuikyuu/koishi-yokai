import { Schema } from 'effect'

import { FeedbackToolId, ToolCallId } from './identity'
import { PortableToolInputSchema } from './portable-schema'

export const MAX_FEEDBACK_TOOL_DESCRIPTION_LENGTH = 2048
export const MAX_SAFE_TOOL_RESULT_MESSAGE_LENGTH = 1024

const wellFormedUnicode = Schema.isPattern(/^[^\uD800-\uDFFF]*$/u)

export const FeedbackToolDeclaration = Schema.Struct({
  id: FeedbackToolId,
  description: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_FEEDBACK_TOOL_DESCRIPTION_LENGTH),
    wellFormedUnicode,
  ),
  inputSchema: PortableToolInputSchema,
})

export interface FeedbackToolDeclaration extends Schema.Schema.Type<
  typeof FeedbackToolDeclaration
> {}

export const FeedbackToolDeclarations = Schema.Array(FeedbackToolDeclaration).check(
  Schema.makeFilter((declarations: ReadonlyArray<FeedbackToolDeclaration>) => {
    const ids = declarations.map((declaration) => declaration.id)
    return new Set(ids).size === ids.length ? true : 'Expected unique FeedbackTool IDs'
  }),
)

export type FeedbackToolDeclarations = typeof FeedbackToolDeclarations.Type

export const JsonObject = Schema.Record(Schema.String, Schema.Json)

export interface JsonObject extends Schema.Schema.Type<typeof JsonObject> {}

export const ToolCall = Schema.Struct({
  callId: ToolCallId,
  toolId: FeedbackToolId,
  input: JsonObject,
})

export interface ToolCall extends Schema.Schema.Type<typeof ToolCall> {}

export const ToolCalls = Schema.NonEmptyArray(ToolCall).check(
  Schema.makeFilter((calls: ReadonlyArray<ToolCall>) => {
    const ids = calls.map((call) => call.callId)
    return new Set(ids).size === ids.length ? true : 'Expected unique tool call IDs'
  }),
)

export type ToolCalls = typeof ToolCalls.Type

export const ToolFailureReason = Schema.Literals([
  'timeout',
  'unavailable',
  'execution-failed',
  'invalid-output',
  'result-too-large',
])

export type ToolFailureReason = typeof ToolFailureReason.Type

export const ToolResult = Schema.TaggedUnion({
  Success: {
    callId: ToolCallId,
    output: Schema.Json,
  },
  Failure: {
    callId: ToolCallId,
    reason: ToolFailureReason,
    message: Schema.optionalKey(
      Schema.String.check(
        Schema.isNonEmpty(),
        Schema.isMaxLength(MAX_SAFE_TOOL_RESULT_MESSAGE_LENGTH),
      ),
    ),
  },
})

export type ToolResult = typeof ToolResult.Type

export const ToolResultBatch = Schema.NonEmptyArray(ToolResult).check(
  Schema.makeFilter((results: ReadonlyArray<ToolResult>) => {
    const ids = results.map((result) => result.callId)
    return new Set(ids).size === ids.length ? true : 'Expected unique tool result IDs'
  }),
)

export type ToolResultBatch = typeof ToolResultBatch.Type
