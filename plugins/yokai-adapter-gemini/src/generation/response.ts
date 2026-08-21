import type { GenerateContentResponse } from '@google/genai'
import {
  AdapterProtocolDecodeError,
  AdapterProviderResponseError,
  FinalTextResult,
  type AdapterId,
  type AdapterModelId,
  type FinalTextResult as FinalTextResultType,
  TokenCount,
} from '@yokai/protocol'
import { Effect, Schema } from 'effect'

const ProviderPart = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  thought: Schema.optionalKey(Schema.Boolean),
})

const ProviderContent = Schema.Struct({
  parts: Schema.optionalKey(Schema.Array(ProviderPart)),
})

const ProviderCandidate = Schema.Struct({
  content: Schema.optionalKey(ProviderContent),
  finishReason: Schema.optionalKey(Schema.String),
})

const ProviderPromptFeedback = Schema.Struct({
  blockReason: Schema.optionalKey(Schema.String),
})

const ProviderUsage = Schema.Struct({
  promptTokenCount: Schema.optionalKey(TokenCount),
  candidatesTokenCount: Schema.optionalKey(TokenCount),
  totalTokenCount: Schema.optionalKey(TokenCount),
  cachedContentTokenCount: Schema.optionalKey(TokenCount),
  thoughtsTokenCount: Schema.optionalKey(TokenCount),
})

const ProviderResponse = Schema.Struct({
  candidates: Schema.optionalKey(Schema.Array(ProviderCandidate)),
  promptFeedback: Schema.optionalKey(ProviderPromptFeedback),
  usageMetadata: Schema.optionalKey(ProviderUsage),
})

interface ProviderResponse extends Schema.Schema.Type<typeof ProviderResponse> {}

const decodeError = (adapterId: AdapterId, modelId: AdapterModelId) =>
  new AdapterProtocolDecodeError({
    adapterId,
    modelId,
    operation: 'generate',
    message: 'Gemini returned an invalid generation response',
  })

const emptyResponseError = (adapterId: AdapterId, modelId: AdapterModelId) =>
  new AdapterProviderResponseError({
    adapterId,
    modelId,
    operation: 'generate',
    message: 'Gemini returned no usable text candidate',
  })

const blockedResponseError = (adapterId: AdapterId, modelId: AdapterModelId) =>
  new AdapterProviderResponseError({
    adapterId,
    modelId,
    operation: 'generate',
    message: 'Gemini blocked the generation request',
  })

const isContentFilterReason = (reason: string | undefined): boolean => {
  switch (reason) {
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
    case 'IMAGE_PROHIBITED_CONTENT':
    case 'IMAGE_RECITATION':
      return true
    default:
      return false
  }
}

const decodeFinishReason = (reason: string | undefined): FinalTextResultType['finishReason'] => {
  switch (reason) {
    case 'STOP':
      return 'stop'
    case 'MAX_TOKENS':
      return 'length'
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
    case 'IMAGE_PROHIBITED_CONTENT':
    case 'IMAGE_RECITATION':
      return 'content-filter'
    case undefined:
    case 'FINISH_REASON_UNSPECIFIED':
      return 'unknown'
    default:
      return 'other'
  }
}

const decodeUsage = (usage: ProviderResponse['usageMetadata']) => {
  if (usage === undefined) return { _tag: 'Unavailable' as const }

  const inputTokens =
    usage.promptTokenCount === undefined ? {} : { inputTokens: usage.promptTokenCount }
  const outputTokens =
    usage.candidatesTokenCount === undefined ? {} : { outputTokens: usage.candidatesTokenCount }
  const totalTokens =
    usage.totalTokenCount === undefined ? {} : { totalTokens: usage.totalTokenCount }
  const cachedInputTokens =
    usage.cachedContentTokenCount === undefined
      ? {}
      : { cachedInputTokens: usage.cachedContentTokenCount }
  const reasoningOutputTokens =
    usage.thoughtsTokenCount === undefined
      ? {}
      : { reasoningOutputTokens: usage.thoughtsTokenCount }
  const hasReportedUsage =
    usage.promptTokenCount !== undefined ||
    usage.candidatesTokenCount !== undefined ||
    usage.totalTokenCount !== undefined ||
    usage.cachedContentTokenCount !== undefined ||
    usage.thoughtsTokenCount !== undefined

  return hasReportedUsage
    ? {
        _tag: 'Reported' as const,
        ...inputTokens,
        ...outputTokens,
        ...totalTokens,
        ...cachedInputTokens,
        ...reasoningOutputTokens,
      }
    : { _tag: 'Unavailable' as const }
}

export const decodeResponse = Effect.fn('GeminiTextGeneration.decodeResponse')(function* (
  adapterId: AdapterId,
  modelId: AdapterModelId,
  response: GenerateContentResponse,
) {
  const decoded = yield* Schema.decodeUnknownEffect(ProviderResponse)(response).pipe(
    Effect.mapError(() => decodeError(adapterId, modelId)),
  )
  const blockReason =
    decoded.promptFeedback === undefined ? undefined : decoded.promptFeedback.blockReason
  if (blockReason !== undefined) {
    return yield* Effect.fail(blockedResponseError(adapterId, modelId))
  }

  const candidate = decoded.candidates === undefined ? undefined : decoded.candidates[0]
  if (candidate === undefined) {
    return yield* Effect.fail(emptyResponseError(adapterId, modelId))
  }
  const parts = candidate.content === undefined ? undefined : candidate.content.parts
  const text =
    parts === undefined
      ? ''
      : parts
          .filter((part) => part.thought !== true && part.text !== undefined)
          .map((part) => (part.text === undefined ? '' : part.text))
          .join('')

  if (text.length === 0) {
    return yield* Effect.fail(
      isContentFilterReason(candidate.finishReason)
        ? blockedResponseError(adapterId, modelId)
        : emptyResponseError(adapterId, modelId),
    )
  }

  return yield* FinalTextResult.makeEffect({
    _tag: 'Text',
    text,
    finishReason: decodeFinishReason(candidate.finishReason),
    usage: decodeUsage(decoded.usageMetadata),
  }).pipe(Effect.mapError(() => decodeError(adapterId, modelId)))
})

export * as GeminiGenerationResponse from './response'
