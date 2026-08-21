import type { Content, GenerateContentParameters } from '@google/genai'
import type { GenerateRequest } from '@yokai/protocol'

const encodeMessage = (message: GenerateRequest['messages'][number]): Content => ({
  role: message.role === 'assistant' ? 'model' : 'user',
  parts: [{ text: message.content }],
})

export const encodeRequest = (request: GenerateRequest): GenerateContentParameters => {
  const systemInstruction =
    request.systemInstruction === undefined ? {} : { systemInstruction: request.systemInstruction }

  return {
    model: request.modelId,
    contents: request.messages.map(encodeMessage),
    config: {
      ...systemInstruction,
      maxOutputTokens: request.limits.maxOutputTokens,
      candidateCount: 1,
      automaticFunctionCalling: { disable: true },
    },
  }
}

export * as GeminiGenerationRequest from './request'
