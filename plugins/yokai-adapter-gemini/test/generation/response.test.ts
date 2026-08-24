import {
  BlockedReason,
  FinishReason,
  GenerateContentResponse,
  GenerateContentResponsePromptFeedback,
} from '@google/genai'
import { expect, it } from '@effect/vitest'
import { AdapterId, AdapterModelId, FeedbackToolDeclarations } from 'yokai-protocol'
import { Effect, Schema } from 'effect'

import {
  decodeFinalResponse,
  decodeInitialResponse,
  decodeResponse,
} from '../../src/generation/response'

const ADAPTER_ID = AdapterId.make('gemini-response-test')
const MODEL_ID = AdapterModelId.make('gemini-2.5-flash')

const makeDeclarations = Schema.decodeUnknownEffect(FeedbackToolDeclarations)([
  {
    id: 'history.search',
    description: 'Search history',
    inputSchema: { _tag: 'Object', properties: [] },
  },
  {
    id: 'web.search',
    description: 'Search the web',
    inputSchema: { _tag: 'Object', properties: [] },
  },
])

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

it.effect('decodes ordered function calls and keeps every original model part opaque', () =>
  Effect.gen(function* () {
    const declarations = yield* makeDeclarations
    const modelContent = {
      role: 'model',
      parts: [
        { text: 'temporary draft', thoughtSignature: 'text-signature' },
        {
          functionCall: {
            id: 'provider-call-b',
            name: 'web.search',
            args: { query: 'weather' },
          },
          thoughtSignature: 'call-signature-b',
        },
        {
          functionCall: {
            name: 'history.search',
            args: { query: 'yesterday' },
          },
          thoughtSignature: 'call-signature-a',
        },
      ],
    }
    const response = Object.assign(new GenerateContentResponse(), {
      candidates: [{ content: modelContent, finishReason: FinishReason.STOP }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4 },
    })

    const decoded = yield* decodeInitialResponse(ADAPTER_ID, MODEL_ID, declarations, response)
    expect(decoded._tag).toBe('ToolCalls')
    if (decoded._tag !== 'ToolCalls') {
      return yield* Effect.die('Expected a Gemini tool-call response')
    }
    expect(decoded.calls).toEqual([
      {
        callId: 'provider-call-b',
        toolId: 'web.search',
        input: { query: 'weather' },
      },
      {
        callId: 'gemini-generated-call-1',
        toolId: 'history.search',
        input: { query: 'yesterday' },
      },
    ])
    expect(decoded.providerCalls).toEqual([
      {
        callId: 'provider-call-b',
        toolId: 'web.search',
        providerCallId: 'provider-call-b',
      },
      {
        callId: 'gemini-generated-call-1',
        toolId: 'history.search',
      },
    ])
    expect(decoded.modelContent).toBe(modelContent)
    expect(decoded).not.toHaveProperty('text')
  }),
)

it.effect('rejects undeclared tools and duplicate provider call IDs as protocol violations', () =>
  Effect.gen(function* () {
    const declarations = yield* makeDeclarations
    const duplicateResponse = Object.assign(new GenerateContentResponse(), {
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { id: 'duplicate', name: 'web.search', args: {} } },
              { functionCall: { id: 'duplicate', name: 'history.search', args: {} } },
            ],
          },
        },
      ],
    })
    const undeclaredResponse = Object.assign(new GenerateContentResponse(), {
      candidates: [
        {
          content: {
            parts: [{ functionCall: { id: 'call-a', name: 'private.tool', args: {} } }],
          },
        },
      ],
    })

    const duplicate = yield* decodeInitialResponse(
      ADAPTER_ID,
      MODEL_ID,
      declarations,
      duplicateResponse,
    ).pipe(Effect.flip)
    const undeclared = yield* decodeInitialResponse(
      ADAPTER_ID,
      MODEL_ID,
      declarations,
      undeclaredResponse,
    ).pipe(Effect.flip)
    expect(duplicate._tag).toBe('AdapterProtocolViolationError')
    if (duplicate._tag === 'AdapterProtocolViolationError') {
      expect(duplicate.reason).toBe('duplicate-call-id')
    }
    expect(undeclared._tag).toBe('AdapterProtocolViolationError')
    if (undeclared._tag === 'AdapterProtocolViolationError') {
      expect(undeclared.reason).toBe('undeclared-tool-call')
    }
  }),
)

it.effect('rejects a function call in the only final response', () =>
  Effect.gen(function* () {
    const response = Object.assign(new GenerateContentResponse(), {
      candidates: [
        {
          content: {
            parts: [{ functionCall: { id: 'second-round', name: 'web.search', args: {} } }],
          },
        },
      ],
    })

    const failure = yield* decodeFinalResponse(ADAPTER_ID, MODEL_ID, 'continue', response).pipe(
      Effect.flip,
    )
    expect(failure._tag).toBe('AdapterProtocolViolationError')
    if (failure._tag === 'AdapterProtocolViolationError') {
      expect(failure.operation).toBe('continue')
      expect(failure.reason).toBe('unexpected-tool-call')
    }
  }),
)
