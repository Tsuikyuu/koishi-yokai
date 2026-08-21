import {
  BlockedReason,
  FinishReason,
  GenerateContentResponse,
  GenerateContentResponsePromptFeedback,
} from '@google/genai'
import { expect, it } from '@effect/vitest'
import { AdapterId, AdapterModelId } from '@yokai/protocol'
import { Effect } from 'effect'

import { decodeResponse } from '../../src/generation/response'

const ADAPTER_ID = AdapterId.make('gemini-response-test')
const MODEL_ID = AdapterModelId.make('gemini-2.5-flash')

it.effect('decodes the first candidate text, finish reason, and incremental token usage', () =>
  Effect.gen(function* () {
    const response = Object.assign(new GenerateContentResponse(), {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'private reasoning', thought: true },
              { text: '<yokai-response>' },
              { text: 'hello</yokai-response>' },
            ],
          },
          finishReason: FinishReason.STOP,
        },
      ],
      usageMetadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 7,
        totalTokenCount: 21,
        cachedContentTokenCount: 3,
        thoughtsTokenCount: 2,
      },
    })

    expect(yield* decodeResponse(ADAPTER_ID, MODEL_ID, response)).toEqual({
      _tag: 'Text',
      text: '<yokai-response>hello</yokai-response>',
      finishReason: 'stop',
      usage: {
        _tag: 'Reported',
        inputTokens: 12,
        outputTokens: 7,
        totalTokens: 21,
        cachedInputTokens: 3,
        reasoningOutputTokens: 2,
      },
    })
  }),
)

it.effect('maps length and content filtering finish reasons without inventing usage', () =>
  Effect.gen(function* () {
    const lengthResponse = Object.assign(new GenerateContentResponse(), {
      candidates: [
        {
          content: { parts: [{ text: 'partial' }] },
          finishReason: FinishReason.MAX_TOKENS,
        },
      ],
    })
    const filteredResponse = Object.assign(new GenerateContentResponse(), {
      candidates: [
        {
          content: { parts: [{ text: 'safe partial' }] },
          finishReason: FinishReason.SAFETY,
        },
      ],
    })

    const length = yield* decodeResponse(ADAPTER_ID, MODEL_ID, lengthResponse)
    const filtered = yield* decodeResponse(ADAPTER_ID, MODEL_ID, filteredResponse)
    expect(length.finishReason).toBe('length')
    expect(length.usage).toEqual({ _tag: 'Unavailable' })
    expect(filtered.finishReason).toBe('content-filter')
  }),
)

it.effect('classifies empty candidates and prompt safety blocks as safe provider failures', () =>
  Effect.gen(function* () {
    const empty = new GenerateContentResponse()
    const blocked = Object.assign(new GenerateContentResponse(), {
      promptFeedback: Object.assign(new GenerateContentResponsePromptFeedback(), {
        blockReason: BlockedReason.SAFETY,
      }),
    })

    const emptyFailure = yield* decodeResponse(ADAPTER_ID, MODEL_ID, empty).pipe(Effect.flip)
    const blockedFailure = yield* decodeResponse(ADAPTER_ID, MODEL_ID, blocked).pipe(Effect.flip)
    expect(emptyFailure._tag).toBe('AdapterProviderResponseError')
    expect(emptyFailure.message).toBe('Gemini returned no usable text candidate')
    expect(blockedFailure._tag).toBe('AdapterProviderResponseError')
    expect(blockedFailure.message).toBe('Gemini blocked the generation request')
  }),
)

it.effect('maps malformed provider usage to a protocol decode error', () =>
  Effect.gen(function* () {
    const response = Object.assign(new GenerateContentResponse(), {
      candidates: [
        {
          content: { parts: [{ text: 'text' }] },
          finishReason: FinishReason.STOP,
        },
      ],
      usageMetadata: { totalTokenCount: -1 },
    })

    const failure = yield* decodeResponse(ADAPTER_ID, MODEL_ID, response).pipe(Effect.flip)
    expect(failure._tag).toBe('AdapterProtocolDecodeError')
    expect(failure.adapterId).toBe(ADAPTER_ID)
    expect(failure.modelId).toBe(MODEL_ID)
    expect(failure.operation).toBe('generate')
  }),
)
