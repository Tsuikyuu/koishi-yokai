import { Effect, Schema, SchemaIssue, SchemaTransformation } from 'effect'

export const MAX_ADAPTER_ID_LENGTH = 128
export const MAX_ADAPTER_MODEL_ID_LENGTH = 512
export const MAX_MODEL_REFERENCE_LENGTH = MAX_ADAPTER_ID_LENGTH + 1 + MAX_ADAPTER_MODEL_ID_LENGTH
export const MAX_FEEDBACK_TOOL_ID_LENGTH = 128
export const MAX_TOOL_CALL_ID_LENGTH = 256

export const AdapterId = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_ADAPTER_ID_LENGTH),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9._-]*$/),
).pipe(Schema.brand('@yokai/protocol/AdapterId'))

export type AdapterId = typeof AdapterId.Type

export const AdapterModelId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_ADAPTER_MODEL_ID_LENGTH),
  Schema.isPattern(/^[^\p{C}]+$/u),
).pipe(Schema.brand('@yokai/protocol/AdapterModelId'))

export type AdapterModelId = typeof AdapterModelId.Type

export const FeedbackToolId = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_FEEDBACK_TOOL_ID_LENGTH),
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9._-]*$/),
).pipe(Schema.brand('@yokai/protocol/FeedbackToolId'))

export type FeedbackToolId = typeof FeedbackToolId.Type

export const ToolCallId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_TOOL_CALL_ID_LENGTH),
  Schema.isPattern(/^[^\p{C}]+$/u),
).pipe(Schema.brand('@yokai/protocol/ToolCallId'))

export type ToolCallId = typeof ToolCallId.Type

const ModelReferenceValue = Schema.Struct({
  adapterId: AdapterId,
  modelId: AdapterModelId,
})

const EncodedModelReference = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_MODEL_REFERENCE_LENGTH),
)

/**
 * A model reference is encoded as `<adapterId>/<adapter-local modelId>`.
 * Only the first slash is structural; every later slash belongs to the model ID.
 */
export const ModelReference = EncodedModelReference.pipe(
  Schema.decodeTo(
    ModelReferenceValue,
    SchemaTransformation.transformOrFail({
      decode: (encoded, options) => {
        const separator = encoded.indexOf('/')
        if (separator <= 0 || separator === encoded.length - 1) {
          return Effect.fail(
            new SchemaIssue.InvalidValue(
              { message: 'Expected <adapterId>/<modelId>' },
              encoded,
              options,
            ),
          )
        }

        return Effect.succeed({
          adapterId: encoded.slice(0, separator),
          modelId: encoded.slice(separator + 1),
        })
      },
      encode: (reference) => Effect.succeed(reference.adapterId + '/' + reference.modelId),
    }),
  ),
)

export interface ModelReference extends Schema.Schema.Type<typeof ModelReference> {}
