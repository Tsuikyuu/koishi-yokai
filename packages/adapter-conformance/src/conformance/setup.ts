import { Schema } from 'effect'

import {
  AdapterModelId,
  FinalTextResult,
  GenerationMethodName,
  GenerationUsage,
  JsonObject,
  ModelAvailability,
  ModelDiscoveryFreshness,
  TokenLimit,
  ToolCallId,
  FeedbackToolId,
} from 'yokai-protocol'

/** Provider-neutral failure classes that every adapter test harness must be able to inject. */
export const AdapterConformanceErrorCategory = Schema.Literals([
  'configuration',
  'authentication',
  'rate-limit',
  'timeout',
  'provider-cancelled',
  'transport',
  'provider-response',
  'protocol-decode',
  'internal',
  'unsupported',
])

export type AdapterConformanceErrorCategory = typeof AdapterConformanceErrorCategory.Type

/**
 * A simulated provider failure. `providerMessage` is deliberately untrusted and
 * must never be copied into the adapter's public error.
 */
export const AdapterConformanceFailure = Schema.Struct({
  category: AdapterConformanceErrorCategory,
  providerMessage: Schema.String,
  retryAfterMs: Schema.optionalKey(Schema.Natural),
  statusCode: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  ),
})

export interface AdapterConformanceFailure extends Schema.Schema.Type<
  typeof AdapterConformanceFailure
> {}

/**
 * Source discovery data before an adapter validates, deduplicates, and sorts
 * it. Arrays intentionally allow duplicate and unstable entries.
 */
export const AdapterConformanceRawModel = Schema.Struct({
  id: AdapterModelId,
  displayName: Schema.NonEmptyString,
  availability: ModelAvailability,
  discoveryFreshness: ModelDiscoveryFreshness,
  inputTokenLimit: Schema.optionalKey(TokenLimit),
  outputTokenLimit: Schema.optionalKey(TokenLimit),
  supportedGenerationMethods: Schema.optionalKey(Schema.Array(GenerationMethodName)),
})

export interface AdapterConformanceRawModel extends Schema.Schema.Type<
  typeof AdapterConformanceRawModel
> {}

export const AdapterConformanceRawToolCall = Schema.Struct({
  callId: ToolCallId,
  toolId: FeedbackToolId,
  input: JsonObject,
})

export interface AdapterConformanceRawToolCall extends Schema.Schema.Type<
  typeof AdapterConformanceRawToolCall
> {}

export const AdapterDiscoveryStep = Schema.TaggedUnion({
  Success: {
    discoveredAt: Schema.String,
    models: Schema.Array(AdapterConformanceRawModel),
    blocked: Schema.Boolean,
  },
  Failure: {
    failure: AdapterConformanceFailure,
    blocked: Schema.Boolean,
  },
})

export type AdapterDiscoveryStep = typeof AdapterDiscoveryStep.Type

/**
 * Scripted raw generation responses. Tool-call arrays remain unvalidated so a
 * suite can exercise duplicate IDs, undeclared tools, and a forbidden second
 * tool-call response.
 */
export const AdapterGenerationStep = Schema.TaggedUnion({
  Text: {
    result: FinalTextResult,
    blocked: Schema.Boolean,
  },
  ToolCalls: {
    calls: Schema.Array(AdapterConformanceRawToolCall),
    usage: GenerationUsage,
    blocked: Schema.Boolean,
  },
  Failure: {
    failure: AdapterConformanceFailure,
    blocked: Schema.Boolean,
  },
})

export type AdapterGenerationStep = typeof AdapterGenerationStep.Type

/** An immutable script consumed one physical provider request at a time. */
export const AdapterConformanceSetup = Schema.Struct({
  discoverySteps: Schema.Array(AdapterDiscoveryStep),
  generationSteps: Schema.Array(AdapterGenerationStep),
})

export interface AdapterConformanceSetup extends Schema.Schema.Type<
  typeof AdapterConformanceSetup
> {}
