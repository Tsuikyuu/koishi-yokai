import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'

import { makeAdapterContinuation } from '../../src/llm-adapter/continuation'
import {
  GenerateRequest,
  InitialGenerationResult,
  ToolCallBatch,
} from '../../src/llm-adapter/generation'

it.effect('round-trips final text with bounded provider-neutral usage', () =>
  Effect.gen(function* () {
    const encoded = {
      _tag: 'Text',
      text: '<yokai-response version="1"></yokai-response>',
      finishReason: 'stop',
      usage: {
        _tag: 'Reported',
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
      },
    }

    const result = yield* Schema.decodeUnknownEffect(InitialGenerationResult)(encoded)
    expect(yield* Schema.encodeEffect(InitialGenerationResult)(result)).toEqual(encoded)
  }),
)

it.effect('drops unknown minor fields and never forwards providerOptions', () =>
  Effect.gen(function* () {
    const encoded = {
      modelId: 'connection-a/models/flash',
      messages: [{ role: 'user', content: 'hello' }],
      limits: { maxOutputTokens: 512 },
      feedbackTools: [],
      providerOptions: { google: { thinkingBudget: 4096 } },
      futureOptionalField: true,
    }

    const request = yield* Schema.decodeUnknownEffect(GenerateRequest)(encoded)
    expect(request.systemInstruction).toBeUndefined()
    expect(yield* Schema.encodeEffect(GenerateRequest)(request)).toEqual({
      modelId: 'connection-a/models/flash',
      messages: [{ role: 'user', content: 'hello' }],
      limits: { maxOutputTokens: 512 },
      feedbackTools: [],
    })
  }),
)

it.effect('rejects invalid token usage, missing IDs, and unknown result variants', () =>
  Effect.gen(function* () {
    const invalidUsage = (inputTokens: number) => ({
      _tag: 'Text',
      text: 'text',
      finishReason: 'stop',
      usage: { _tag: 'Reported', inputTokens },
    })
    const resultErrors = yield* Effect.all([
      Schema.decodeUnknownEffect(InitialGenerationResult)(invalidUsage(-1)).pipe(Effect.flip),
      Schema.decodeUnknownEffect(InitialGenerationResult)(invalidUsage(1.5)).pipe(Effect.flip),
      Schema.decodeUnknownEffect(InitialGenerationResult)(
        invalidUsage(Number.MAX_SAFE_INTEGER + 1),
      ).pipe(Effect.flip),
      Schema.decodeUnknownEffect(InitialGenerationResult)({
        _tag: 'UnknownResult',
        text: 'text',
      }).pipe(Effect.flip),
    ])
    const requestError = yield* Schema.decodeUnknownEffect(GenerateRequest)({
      modelId: '',
      messages: [{ role: 'user', content: 'hello' }],
      limits: { maxOutputTokens: 512 },
      feedbackTools: [],
    }).pipe(Effect.flip)

    expect(resultErrors.every(Schema.isSchemaError)).toBe(true)
    expect(Schema.isSchemaError(requestError)).toBe(true)
  }),
)

it.effect('rejects duplicate FeedbackTool declarations before an adapter can map them', () =>
  Effect.gen(function* () {
    const tool = {
      id: 'history.search',
      description: 'Search bounded message history',
      inputSchema: {
        _tag: 'Object',
        properties: [
          {
            name: 'query',
            required: true,
            schema: { _tag: 'String' },
          },
        ],
      },
    }
    const error = yield* Schema.decodeUnknownEffect(GenerateRequest)({
      modelId: 'connection-a/models/flash',
      messages: [{ role: 'user', content: 'hello' }],
      limits: { maxOutputTokens: 512 },
      feedbackTools: [tool, tool],
    }).pipe(Effect.flip)

    expect(Schema.isSchemaError(error)).toBe(true)
  }),
)

it.effect('keeps continuation opaque in memory and forbids JSON persistence', () =>
  Effect.gen(function* () {
    const secretToken = 'turn-42-provider-state-key'
    const continuation = yield* makeAdapterContinuation(secretToken)
    const decoded = yield* Schema.decodeUnknownEffect(ToolCallBatch)({
      _tag: 'ToolCallBatch',
      calls: [
        { callId: 'call-1', toolId: 'history.search', input: { query: 'topic' } },
        { callId: 'call-2', toolId: 'web.search', input: { query: 'source' } },
      ],
      continuation,
      usage: { _tag: 'Unavailable' },
    })

    expect(String(decoded.continuation)).not.toContain(secretToken)
    expect(JSON.stringify(decoded.continuation)).not.toContain(secretToken)

    const memoryEncoded = yield* Schema.encodeEffect(ToolCallBatch)(decoded)
    const memoryRoundTrip = yield* Schema.decodeUnknownEffect(ToolCallBatch)(memoryEncoded)
    expect(memoryRoundTrip.calls).toEqual(decoded.calls)
    expect(String(memoryRoundTrip.continuation)).not.toContain(secretToken)

    const jsonError = yield* Schema.encodeEffect(Schema.toCodecJson(ToolCallBatch))(decoded).pipe(
      Effect.flip,
    )
    expect(Schema.isSchemaError(jsonError)).toBe(true)
  }),
)

it.effect('rejects an invalid continuation key as a typed SchemaError', () =>
  Effect.gen(function* () {
    const error = yield* makeAdapterContinuation('').pipe(Effect.flip)
    expect(Schema.isSchemaError(error)).toBe(true)
  }),
)

it.effect('rejects empty or duplicate tool call batches', () =>
  Effect.gen(function* () {
    const continuation = yield* makeAdapterContinuation('turn-42')
    const base = {
      _tag: 'ToolCallBatch',
      continuation,
      usage: { _tag: 'Unavailable' },
    }
    const call = {
      callId: 'call-1',
      toolId: 'history.search',
      input: { query: 'topic' },
    }
    const errors = yield* Effect.all(
      [
        { ...base, calls: [] },
        { ...base, calls: [call, call] },
        { ...base, calls: [{ ...call, input: [] }] },
      ].map((input) => Schema.decodeUnknownEffect(ToolCallBatch)(input).pipe(Effect.flip)),
    )

    expect(errors.every(Schema.isSchemaError)).toBe(true)
  }),
)
