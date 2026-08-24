import { FunctionCallingConfigMode } from '@google/genai'
import { expect, it } from '@effect/vitest'
import { GenerateRequest } from 'yokai-protocol'
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

it.effect('compiles portable FeedbackTool declarations into closed Gemini JSON Schema', () =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(GenerateRequest)({
      modelId: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Find a memory' }],
      limits: { maxOutputTokens: 64 },
      feedbackTools: [
        {
          id: 'history.search',
          description: 'Search bounded conversation history',
          inputSchema: {
            _tag: 'Object',
            description: 'Search parameters',
            properties: [
              {
                name: 'query',
                required: true,
                schema: { _tag: 'String', description: 'Search query' },
              },
              {
                name: 'limit',
                required: false,
                schema: { _tag: 'Integer', minimum: 1, maximum: 5 },
              },
              {
                name: 'scopes',
                required: true,
                schema: {
                  _tag: 'Array',
                  items: { _tag: 'StringEnum', values: ['recent', 'archived'] },
                  minItems: 1,
                  maxItems: 2,
                },
              },
            ],
          },
        },
      ],
    })

    expect(encodeRequest(request).config).toEqual({
      maxOutputTokens: 64,
      candidateCount: 1,
      automaticFunctionCalling: { disable: true },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'history.search',
              description: 'Search bounded conversation history',
              parametersJsonSchema: {
                type: 'object',
                description: 'Search parameters',
                properties: {
                  query: { type: 'string', description: 'Search query' },
                  limit: { type: 'integer', minimum: 1, maximum: 5 },
                  scopes: {
                    type: 'array',
                    items: { type: 'string', enum: ['recent', 'archived'] },
                    minItems: 1,
                    maxItems: 2,
                  },
                },
                required: ['query', 'scopes'],
                additionalProperties: false,
              },
            },
          ],
        },
      ],
      toolConfig: {
        functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
      },
    })
  }),
)
