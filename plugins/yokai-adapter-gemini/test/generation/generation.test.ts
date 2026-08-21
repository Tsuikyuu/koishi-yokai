import { FinishReason, GenerateContentResponse } from '@google/genai'
import { expect, it } from '@effect/vitest'
import { AdapterId, GenerateRequest, type AdapterInvocationError } from '@yokai/protocol'
import { Effect, Layer, Ref, Schema } from 'effect'

import { GeminiConnection } from '../../src/connection/connection'
import { GeminiContinuationStore } from '../../src/continuation/store'
import { GeminiContinuationTokenGenerator } from '../../src/continuation/token-generator'
import { GeminiTextGeneration } from '../../src/generation/generation'

const ADAPTER_ID = AdapterId.make('gemini-generation-test')

const makeRequest = (withFeedbackTools: boolean) =>
  Schema.decodeUnknownEffect(GenerateRequest)({
    modelId: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'Hello' }],
    limits: { maxOutputTokens: 128 },
    feedbackTools: withFeedbackTools
      ? [
          {
            id: 'history.search',
            description: 'Search history',
            inputSchema: {
              _tag: 'Object',
              properties: [],
            },
          },
        ]
      : [],
  })

const response = Object.assign(new GenerateContentResponse(), {
  candidates: [
    {
      content: { parts: [{ text: 'Hello back' }] },
      finishReason: FinishReason.STOP,
    },
  ],
})

const makeLayer = (calls: Ref.Ref<number>) => {
  const connection = GeminiConnection.Service.of({
    adapterId: ADAPTER_ID,
    discoveryRetry: {
      maxAttempts: 3,
      initialDelayMs: 1_000,
      maxDelayMs: 10_000,
      backoffMultiplier: 2,
    },
    listModels: () => Effect.die('Unexpected model discovery request'),
    generateContent: Effect.fn('GeminiTextGenerationTest.Connection.generateContent')(function* <
      A,
      R,
    >(
      _operation: Parameters<GeminiConnection.Interface['generateContent']>[0],
      _modelId: (typeof GenerateRequest.Type)['modelId'],
      _params: Parameters<GeminiConnection.Interface['generateContent']>[2],
      accept: (value: GenerateContentResponse) => Effect.Effect<A, AdapterInvocationError, R>,
    ) {
      yield* Ref.update(calls, (count) => count + 1)
      return yield* accept(response)
    }),
    close: () => Effect.succeed(true),
  })
  const connectionLayer = Layer.succeed(GeminiConnection.Service, connection)
  const continuationLayer = GeminiContinuationStore.layer.pipe(
    Layer.provide(GeminiContinuationTokenGenerator.layer),
    Layer.provideMerge(connectionLayer),
  )
  return GeminiTextGeneration.layer.pipe(Layer.provide(continuationLayer))
}

it.effect('returns a text result through the logical connection', () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    const request = yield* makeRequest(false)
    const result = yield* GeminiTextGeneration.Service.pipe(
      Effect.flatMap((generation) => generation.generate(request)),
      Effect.provide(makeLayer(calls)),
    )

    expect(result).toEqual({
      _tag: 'Text',
      text: 'Hello back',
      finishReason: 'stop',
      usage: { _tag: 'Unavailable' },
    })
    expect(yield* Ref.get(calls)).toBe(1)
  }),
)

it.effect('allows selected feedback tools when Gemini returns final text directly', () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    const request = yield* makeRequest(true)
    const result = yield* GeminiTextGeneration.Service.pipe(
      Effect.flatMap((generation) => generation.generate(request)),
      Effect.provide(makeLayer(calls)),
    )

    expect(result._tag).toBe('Text')
    expect(yield* Ref.get(calls)).toBe(1)
  }),
)
