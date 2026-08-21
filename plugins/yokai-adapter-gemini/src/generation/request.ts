import {
  FunctionCallingConfigMode,
  type Content,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type Part,
} from '@google/genai'
import {
  AdapterProtocolViolationError,
  type FeedbackToolDeclaration,
  type GenerateRequest,
  type PortableObjectSchema,
  type PortableValueSchema,
  type ToolResult,
  type ToolResultBatch,
} from '@yokai/protocol'
import { Effect } from 'effect'

import type { ClaimedContinuation, PendingFunctionCall } from '../continuation/store'

type ProviderSchemaType = 'array' | 'boolean' | 'integer' | 'number' | 'object' | 'string'

interface ProviderJsonSchema {
  readonly type: ProviderSchemaType
  readonly description?: string
  readonly minimum?: number
  readonly maximum?: number
  readonly enum?: ReadonlyArray<string>
  readonly items?: ProviderJsonSchema
  readonly minItems?: number
  readonly maxItems?: number
  readonly properties?: Readonly<Record<string, ProviderJsonSchema>>
  readonly required?: ReadonlyArray<string>
  readonly additionalProperties?: boolean
}

export interface EncodedRequest extends GenerateContentParameters {
  readonly contents: Array<Content>
  readonly config: GenerateContentConfig
}

const withDescription = (schema: PortableValueSchema | PortableObjectSchema) =>
  schema.description === undefined ? {} : { description: schema.description }

const withMinimum = (
  schema: Extract<PortableValueSchema, { readonly _tag: 'Number' | 'Integer' }>,
) => (schema.minimum === undefined ? {} : { minimum: schema.minimum })

const withMaximum = (
  schema: Extract<PortableValueSchema, { readonly _tag: 'Number' | 'Integer' }>,
) => (schema.maximum === undefined ? {} : { maximum: schema.maximum })

const encodeObjectSchema = (schema: PortableObjectSchema): ProviderJsonSchema => {
  const properties = schema.properties.reduce<Readonly<Record<string, ProviderJsonSchema>>>(
    (current, property) => ({
      ...current,
      [property.name]: encodePortableSchema(property.schema),
    }),
    {},
  )
  const required = schema.properties
    .filter((property) => property.required)
    .map((property) => property.name)

  return {
    type: 'object',
    ...withDescription(schema),
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
  }
}

const encodePortableSchema = (schema: PortableValueSchema): ProviderJsonSchema => {
  switch (schema._tag) {
    case 'String':
      return { type: 'string', ...withDescription(schema) }
    case 'Number':
      return {
        type: 'number',
        ...withDescription(schema),
        ...withMinimum(schema),
        ...withMaximum(schema),
      }
    case 'Integer':
      return {
        type: 'integer',
        ...withDescription(schema),
        ...withMinimum(schema),
        ...withMaximum(schema),
      }
    case 'Boolean':
      return { type: 'boolean', ...withDescription(schema) }
    case 'StringEnum':
      return { type: 'string', ...withDescription(schema), enum: schema.values }
    case 'Array':
      return {
        type: 'array',
        ...withDescription(schema),
        items: encodePortableSchema(schema.items),
        minItems: schema.minItems,
        maxItems: schema.maxItems,
      }
    case 'Object':
      return encodeObjectSchema(schema)
  }
}

const encodeDeclaration = (declaration: FeedbackToolDeclaration) => ({
  name: declaration.id,
  description: declaration.description,
  parametersJsonSchema: encodeObjectSchema(declaration.inputSchema),
})

const encodeMessage = (message: GenerateRequest['messages'][number]): Content => ({
  role: message.role === 'assistant' ? 'model' : 'user',
  parts: [{ text: message.content }],
})

export const encodeRequest = (request: GenerateRequest): EncodedRequest => {
  const systemInstruction =
    request.systemInstruction === undefined ? {} : { systemInstruction: request.systemInstruction }
  const feedbackTools =
    request.feedbackTools.length === 0
      ? {}
      : {
          tools: [{ functionDeclarations: request.feedbackTools.map(encodeDeclaration) }],
          toolConfig: {
            functionCallingConfig: {
              mode: FunctionCallingConfigMode.AUTO,
            },
          },
        }

  return {
    model: request.modelId,
    contents: request.messages.map(encodeMessage),
    config: {
      ...systemInstruction,
      maxOutputTokens: request.limits.maxOutputTokens,
      candidateCount: 1,
      automaticFunctionCalling: { disable: true },
      ...feedbackTools,
    },
  }
}

const resultSetMismatch = (claimed: ClaimedContinuation) =>
  new AdapterProtocolViolationError({
    adapterId: claimed.adapterId,
    modelId: claimed.modelId,
    operation: 'continue',
    message: 'Gemini continuation results do not match pending calls',
    reason: 'result-set-mismatch',
  })

const encodeResult = (result: ToolResult) => {
  if (result._tag === 'Success') return { ok: true, value: result.output }
  return {
    ok: false,
    reason: result.reason,
    ...(result.message === undefined ? {} : { message: result.message }),
  }
}

const encodeResponsePart = Effect.fn('GeminiGenerationRequest.encodeResponsePart')(function* (
  claimed: ClaimedContinuation,
  call: PendingFunctionCall,
  results: ToolResultBatch,
) {
  const result = results.find((candidate) => candidate.callId === call.callId)
  if (result === undefined) return yield* Effect.fail(resultSetMismatch(claimed))

  return {
    functionResponse: {
      name: call.toolId,
      ...(call.providerCallId === undefined ? {} : { id: call.providerCallId }),
      response: encodeResult(result),
    },
  } satisfies Part
})

export const encodeContinuationRequest = Effect.fn(
  'GeminiGenerationRequest.encodeContinuationRequest',
)(function* (claimed: ClaimedContinuation, results: ToolResultBatch) {
  if (
    claimed.providerCalls.length !== results.length ||
    claimed.providerCalls.some(
      (call) => !results.some((candidate) => candidate.callId === call.callId),
    )
  ) {
    return yield* Effect.fail(resultSetMismatch(claimed))
  }

  const parts = yield* Effect.forEach(claimed.providerCalls, (call) =>
    encodeResponsePart(claimed, call, results),
  )

  return {
    model: claimed.modelId,
    contents: [
      ...claimed.contents,
      claimed.modelContent,
      {
        role: 'user',
        parts,
      },
    ],
    config: {
      ...claimed.config,
      automaticFunctionCalling: { disable: true },
      toolConfig: {
        functionCallingConfig: {
          mode: FunctionCallingConfigMode.NONE,
        },
      },
    },
  } satisfies GenerateContentParameters
})

export * as GeminiGenerationRequest from './request'
