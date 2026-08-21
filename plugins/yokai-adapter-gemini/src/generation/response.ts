import type { Content, GenerateContentResponse } from '@google/genai'
import {
  AdapterProtocolDecodeError,
  AdapterProtocolViolationError,
  AdapterProviderResponseError,
  FinalTextResult,
  JsonObject,
  ToolCalls,
  type AdapterId,
  type AdapterModelId,
  type FeedbackToolDeclarations,
  type FinalTextResult as FinalTextResultType,
  type GenerationUsage,
  type ToolCall,
  TokenCount,
} from '@yokai/protocol'
import { Data, Effect, HashSet, Schema } from 'effect'

import type { PendingFunctionCall } from '../continuation/store'

type GenerationOperation = 'continue' | 'generate'

const ProviderFunctionCall = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(JsonObject),
})

interface ProviderFunctionCall extends Schema.Schema.Type<typeof ProviderFunctionCall> {}

const ProviderPart = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  thought: Schema.optionalKey(Schema.Boolean),
  thoughtSignature: Schema.optionalKey(Schema.String),
  functionCall: Schema.optionalKey(ProviderFunctionCall),
})

interface ProviderPart extends Schema.Schema.Type<typeof ProviderPart> {}

const ProviderContent = Schema.Struct({
  role: Schema.optionalKey(Schema.String),
  parts: Schema.optionalKey(Schema.Array(ProviderPart)),
})

const ProviderCandidate = Schema.Struct({
  content: Schema.optionalKey(ProviderContent),
  finishReason: Schema.optionalKey(Schema.String),
})

interface ProviderCandidate extends Schema.Schema.Type<typeof ProviderCandidate> {}

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

export type InitialResponse = Data.TaggedEnum<{
  readonly Text: {
    readonly result: FinalTextResultType
  }
  readonly ToolCalls: {
    readonly calls: ToolCalls
    readonly providerCalls: ReadonlyArray<PendingFunctionCall>
    readonly modelContent: Content
    readonly usage: GenerationUsage
  }
}>

export const InitialResponse = Data.taggedEnum<InitialResponse>()

const decodeError = (
  adapterId: AdapterId,
  modelId: AdapterModelId,
  operation: GenerationOperation,
) =>
  new AdapterProtocolDecodeError({
    adapterId,
    modelId,
    operation,
    message: 'Gemini returned an invalid generation response',
  })

const emptyResponseError = (
  adapterId: AdapterId,
  modelId: AdapterModelId,
  operation: GenerationOperation,
) =>
  new AdapterProviderResponseError({
    adapterId,
    modelId,
    operation,
    message: 'Gemini returned no usable text candidate',
  })

const blockedResponseError = (
  adapterId: AdapterId,
  modelId: AdapterModelId,
  operation: GenerationOperation,
) =>
  new AdapterProviderResponseError({
    adapterId,
    modelId,
    operation,
    message: 'Gemini blocked the generation request',
  })

const violation = (
  adapterId: AdapterId,
  modelId: AdapterModelId,
  operation: GenerationOperation,
  reason: 'duplicate-call-id' | 'undeclared-tool-call' | 'unexpected-tool-call',
) =>
  new AdapterProtocolViolationError({
    adapterId,
    modelId,
    operation,
    message: 'Gemini violated the FeedbackTool protocol',
    reason,
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

const decodeUsage = (usage: ProviderResponse['usageMetadata']): GenerationUsage => {
  if (usage === undefined) return { _tag: 'Unavailable' }

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
        _tag: 'Reported',
        ...inputTokens,
        ...outputTokens,
        ...totalTokens,
        ...cachedInputTokens,
        ...reasoningOutputTokens,
      }
    : { _tag: 'Unavailable' }
}

interface DecodedCandidate {
  readonly candidate: ProviderCandidate
  readonly content: Content
  readonly usage: GenerationUsage
}

const decodeCandidate = Effect.fn('GeminiGenerationResponse.decodeCandidate')(function* (
  adapterId: AdapterId,
  modelId: AdapterModelId,
  operation: GenerationOperation,
  response: GenerateContentResponse,
) {
  const decoded = yield* Schema.decodeUnknownEffect(ProviderResponse)(response).pipe(
    Effect.mapError(() => decodeError(adapterId, modelId, operation)),
  )
  const blockReason =
    decoded.promptFeedback === undefined ? undefined : decoded.promptFeedback.blockReason
  if (blockReason !== undefined) {
    return yield* Effect.fail(blockedResponseError(adapterId, modelId, operation))
  }

  const candidate = decoded.candidates === undefined ? undefined : decoded.candidates[0]
  if (candidate === undefined) {
    return yield* Effect.fail(emptyResponseError(adapterId, modelId, operation))
  }

  const rawCandidates = response.candidates
  const rawCandidate = rawCandidates === undefined ? undefined : rawCandidates[0]
  const content = rawCandidate === undefined ? undefined : rawCandidate.content
  if (content === undefined) {
    return yield* Effect.fail(emptyResponseError(adapterId, modelId, operation))
  }

  return {
    candidate,
    content,
    usage: decodeUsage(decoded.usageMetadata),
  } satisfies DecodedCandidate
})

const decodeText = Effect.fn('GeminiGenerationResponse.decodeText')(function* (
  adapterId: AdapterId,
  modelId: AdapterModelId,
  operation: GenerationOperation,
  decoded: DecodedCandidate,
) {
  const parts =
    decoded.candidate.content === undefined ? undefined : decoded.candidate.content.parts
  const text =
    parts === undefined
      ? ''
      : parts
          .filter((part) => part.thought !== true && part.text !== undefined)
          .map((part) => (part.text === undefined ? '' : part.text))
          .join('')

  if (text.length === 0) {
    return yield* Effect.fail(
      isContentFilterReason(decoded.candidate.finishReason)
        ? blockedResponseError(adapterId, modelId, operation)
        : emptyResponseError(adapterId, modelId, operation),
    )
  }

  return yield* FinalTextResult.makeEffect({
    _tag: 'Text',
    text,
    finishReason: decodeFinishReason(decoded.candidate.finishReason),
    usage: decoded.usage,
  }).pipe(Effect.mapError(() => decodeError(adapterId, modelId, operation)))
})

const functionCallsFrom = (candidate: ProviderCandidate): ReadonlyArray<ProviderFunctionCall> => {
  const parts = candidate.content === undefined ? undefined : candidate.content.parts
  if (parts === undefined) return []
  return parts.reduce<ReadonlyArray<ProviderFunctionCall>>(
    (calls, part) => (part.functionCall === undefined ? calls : [...calls, part.functionCall]),
    [],
  )
}

const nextSyntheticId = (usedIds: HashSet.HashSet<string>, start: number) => {
  let sequence = start
  let candidate = `gemini-generated-call-${sequence}`
  while (HashSet.has(usedIds, candidate)) {
    sequence += 1
    candidate = `gemini-generated-call-${sequence}`
  }
  return { callId: candidate, nextSequence: sequence + 1 }
}

interface RawCallState {
  readonly calls: ReadonlyArray<{
    readonly callId: string
    readonly toolId: string
    readonly input: JsonObject
    readonly providerCallId?: string
  }>
  readonly usedIds: HashSet.HashSet<string>
  readonly nextSequence: number
}

const decodeToolCalls = Effect.fn('GeminiGenerationResponse.decodeToolCalls')(function* (
  adapterId: AdapterId,
  modelId: AdapterModelId,
  declarations: FeedbackToolDeclarations,
  providerCalls: ReadonlyArray<ProviderFunctionCall>,
) {
  const explicitIds = providerCalls.reduce<ReadonlyArray<string>>(
    (ids, call) => (call.id === undefined ? ids : [...ids, call.id]),
    [],
  )
  if (new Set(explicitIds).size !== explicitIds.length) {
    return yield* Effect.fail(violation(adapterId, modelId, 'generate', 'duplicate-call-id'))
  }

  const declaredIds = declarations.map((declaration) => declaration.id)
  const initialState: RawCallState = {
    calls: [],
    usedIds: HashSet.fromIterable(explicitIds),
    nextSequence: 1,
  }
  const raw = yield* Effect.reduce(
    providerCalls,
    () => initialState,
    (state, call) =>
      Effect.gen(function* () {
        const toolId = call.name
        if (toolId === undefined || toolId.length === 0) {
          return yield* Effect.fail(decodeError(adapterId, modelId, 'generate'))
        }
        if (!declaredIds.some((declaredId) => declaredId === toolId)) {
          return yield* Effect.fail(
            violation(adapterId, modelId, 'generate', 'undeclared-tool-call'),
          )
        }

        const synthetic = nextSyntheticId(state.usedIds, state.nextSequence)
        const callId = call.id === undefined ? synthetic.callId : call.id
        return {
          calls: [
            ...state.calls,
            {
              callId,
              toolId,
              input: call.args === undefined ? {} : call.args,
              ...(call.id === undefined ? {} : { providerCallId: call.id }),
            },
          ],
          usedIds: HashSet.add(state.usedIds, callId),
          nextSequence: call.id === undefined ? synthetic.nextSequence : state.nextSequence,
        }
      }),
  )

  const calls = yield* Schema.decodeUnknownEffect(ToolCalls)(raw.calls).pipe(
    Effect.mapError(() => decodeError(adapterId, modelId, 'generate')),
  )
  const pending = yield* Effect.forEach(calls, (call: ToolCall) => {
    const provider = raw.calls.find((candidate) => candidate.callId === call.callId)
    if (provider === undefined) {
      return Effect.die('Expected every normalized Gemini call to retain provider state')
    }
    return Effect.succeed({
      callId: call.callId,
      toolId: call.toolId,
      ...(provider.providerCallId === undefined ? {} : { providerCallId: provider.providerCallId }),
    } satisfies PendingFunctionCall)
  })

  return { calls, pending }
})

export const decodeInitialResponse = Effect.fn('GeminiGenerationResponse.decodeInitialResponse')(
  function* (
    adapterId: AdapterId,
    modelId: AdapterModelId,
    declarations: FeedbackToolDeclarations,
    response: GenerateContentResponse,
  ) {
    const decoded = yield* decodeCandidate(adapterId, modelId, 'generate', response)
    const providerCalls = functionCallsFrom(decoded.candidate)
    if (providerCalls.length === 0) {
      return InitialResponse.Text({
        result: yield* decodeText(adapterId, modelId, 'generate', decoded),
      })
    }

    const calls = yield* decodeToolCalls(adapterId, modelId, declarations, providerCalls)
    return InitialResponse.ToolCalls({
      calls: calls.calls,
      providerCalls: calls.pending,
      modelContent: decoded.content,
      usage: decoded.usage,
    })
  },
)

export const decodeFinalResponse = Effect.fn('GeminiGenerationResponse.decodeFinalResponse')(
  function* (
    adapterId: AdapterId,
    modelId: AdapterModelId,
    operation: GenerationOperation,
    response: GenerateContentResponse,
  ) {
    const decoded = yield* decodeCandidate(adapterId, modelId, operation, response)
    if (functionCallsFrom(decoded.candidate).length > 0) {
      return yield* Effect.fail(violation(adapterId, modelId, operation, 'unexpected-tool-call'))
    }
    return yield* decodeText(adapterId, modelId, operation, decoded)
  },
)

export const decodeResponse = (
  adapterId: AdapterId,
  modelId: AdapterModelId,
  response: GenerateContentResponse,
) => decodeFinalResponse(adapterId, modelId, 'generate', response)

export * as GeminiGenerationResponse from './response'
