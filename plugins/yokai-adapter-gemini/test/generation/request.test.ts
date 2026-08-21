import { expect, it } from '@effect/vitest'
import { GenerateRequest } from '@yokai/protocol'
import { Effect, Schema } from 'effect'

import { encodeRequest } from '../../src/generation/request'

it.effect('maps system instruction, conversation roles, limits, and model ID', () =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(GenerateRequest)({
      modelId: 'gemini-2.5-flash',
      systemInstruction: 'Stay inside the assigned character.',
      messages: [
        { role: 'user', content: 'First user turn' },
        { role: 'assistant', content: 'First model turn' },
        { role: 'user', content: 'Second user turn' },
      ],
      limits: { maxOutputTokens: 512 },
      feedbackTools: [],
    })

    expect(encodeRequest(request)).toEqual({
      model: 'gemini-2.5-flash',
      contents: [
        { role: 'user', parts: [{ text: 'First user turn' }] },
        { role: 'model', parts: [{ text: 'First model turn' }] },
        { role: 'user', parts: [{ text: 'Second user turn' }] },
      ],
      config: {
        systemInstruction: 'Stay inside the assigned character.',
        maxOutputTokens: 512,
        candidateCount: 1,
        automaticFunctionCalling: { disable: true },
      },
    })
  }),
)

it.effect('omits the system instruction when it is absent', () =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(GenerateRequest)({
      modelId: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Hello' }],
      limits: { maxOutputTokens: 64 },
      feedbackTools: [],
    })

    const encoded = encodeRequest(request)
    expect(encoded.config).toEqual({
      maxOutputTokens: 64,
      candidateCount: 1,
      automaticFunctionCalling: { disable: true },
    })
  }),
)
