import { expect, it } from '@effect/vitest'
import { Effect, Option, Result, Schema } from 'effect'

import {
  CapabilityDurationMilliseconds,
  CapabilityScope,
  ContextFragment,
  ContextProvider,
  ContextProviderId,
  ContextProviderRequest,
  MAX_CONTEXT_FRAGMENT_CONTENT_LENGTH,
  MAX_CONTEXT_FRAGMENT_LABEL_LENGTH,
  MAX_CONTEXT_FRAGMENT_SOURCE_REFS,
  MAX_CONTEXT_FRAGMENT_SOURCE_REF_LENGTH,
  TokenCount,
  TokenLimit,
} from '../../src/index'

const PROVIDER_ID = ContextProviderId.make('test.context')
const SCOPE = CapabilityScope.make({
  instanceId: 'instance',
  platform: 'test',
  guildId: 'guild',
  channelId: 'channel',
})

const definition = {
  id: PROVIDER_ID,
  protocolVersion: { major: 0, minor: 1 },
  description: 'Provide bounded test context.',
  maxTokens: 128,
  maxDurationMs: 50,
  isAvailable: (scope: CapabilityScope) => scope.channelId === SCOPE.channelId,
  provide: (request: ContextProviderRequest) =>
    Effect.succeed(
      Option.some(
        ContextFragment.make({
          providerId: PROVIDER_ID,
          label: 'Test context',
          content: request.focus.content,
          sourceRefs: [request.focus.messageId],
          untrusted: true,
          estimatedTokens: TokenCount.make(1),
        }),
      ),
    ),
}

it.effect('decodes ContextProvider duration, availability, and provide contracts', () =>
  Effect.gen(function* () {
    const provider = yield* Schema.decodeUnknownEffect(ContextProvider)(definition)
    expect(provider.maxDurationMs).toBe(50)
    expect(provider.isAvailable(SCOPE)).toBe(true)

    const fragment = yield* provider.provide(
      ContextProviderRequest.make({
        scope: SCOPE,
        focus: {
          messageId: 'message',
          authorId: 'author',
          timestamp: 1,
          content: 'bounded context',
        },
        tokenBudget: TokenLimit.make(128),
      }),
    )
    if (Option.isNone(fragment)) return yield* Effect.die('Expected a context fragment')
    expect(fragment.value.content).toBe('bounded context')
  }),
)

it.effect('rejects invalid ContextProvider duration and function contracts', () =>
  Effect.gen(function* () {
    const candidates = [
      { ...definition, maxDurationMs: 0 },
      { ...definition, maxDurationMs: 1.5 },
      { ...definition, isAvailable: true },
      { ...definition, provide: true },
    ]
    const results = yield* Effect.forEach(candidates, (candidate) =>
      Schema.decodeUnknownEffect(ContextProvider)(candidate).pipe(Effect.result),
    )

    expect(results.every(Result.isFailure)).toBe(true)
  }),
)

it.effect('uses one shared positive duration value object across capability kinds', () =>
  Effect.gen(function* () {
    expect(CapabilityDurationMilliseconds.make(1)).toBe(1)
    const invalid = yield* Schema.decodeUnknownEffect(CapabilityDurationMilliseconds)(0).pipe(
      Effect.flip,
    )
    expect(Schema.isSchemaError(invalid)).toBe(true)
  }),
)

it.effect('rejects oversized ContextFragment content and metadata', () =>
  Effect.gen(function* () {
    const fragment = {
      providerId: PROVIDER_ID,
      label: 'Test context',
      content: 'bounded context',
      sourceRefs: ['message'],
      untrusted: true,
      estimatedTokens: 1,
    }
    const candidates = [
      { ...fragment, label: 'x'.repeat(MAX_CONTEXT_FRAGMENT_LABEL_LENGTH + 1) },
      { ...fragment, content: 'x'.repeat(MAX_CONTEXT_FRAGMENT_CONTENT_LENGTH + 1) },
      {
        ...fragment,
        sourceRefs: ['x'.repeat(MAX_CONTEXT_FRAGMENT_SOURCE_REF_LENGTH + 1)],
      },
      {
        ...fragment,
        sourceRefs: Array.from({ length: MAX_CONTEXT_FRAGMENT_SOURCE_REFS + 1 }, (_, index) =>
          String(index),
        ),
      },
    ]
    const results = yield* Effect.forEach(candidates, (candidate) =>
      Schema.decodeUnknownEffect(ContextFragment)(candidate).pipe(Effect.result),
    )

    expect(results.every(Result.isFailure)).toBe(true)
  }),
)
