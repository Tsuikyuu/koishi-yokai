import { expect, it } from '@effect/vitest'
import {
  CapabilityDurationMilliseconds,
  CapabilityProtocolVersion,
  CapabilityScope,
  ContextFragment,
  ContextProvider,
  ContextProviderError,
  ContextProviderId,
  FocusMessage,
  TokenCount,
  TokenLimit,
} from 'yokai-protocol'
import { Deferred, Duration, Effect, Option } from 'effect'
import { TestClock } from 'effect/testing'
import { vi } from 'vitest'

import { ContextAssembly } from '../../src/index'

const VERSION = CapabilityProtocolVersion.make({ major: 0, minor: 1 })
const SCOPE = CapabilityScope.make({
  instanceId: 'context-assembly-test',
  platform: 'test',
  guildId: 'guild',
  channelId: 'channel',
})
const FOCUS = FocusMessage.make({
  messageId: 'focus-message',
  authorId: 'author',
  timestamp: 1,
  content: 'What context is relevant?',
})

interface ProviderOptions {
  readonly id: string
  readonly maxTokens?: number
  readonly maxDurationMs?: number
  readonly isAvailable?: ContextProvider['isAvailable']
  readonly provide: ContextProvider['provide']
}

const makeProvider = (options: ProviderOptions): ContextProvider =>
  ContextProvider.make({
    id: ContextProviderId.make(options.id),
    protocolVersion: VERSION,
    description: `Provide ${options.id} test context.`,
    maxTokens: TokenLimit.make(options.maxTokens === undefined ? 2_048 : options.maxTokens),
    maxDurationMs: CapabilityDurationMilliseconds.make(
      options.maxDurationMs === undefined ? 1_000 : options.maxDurationMs,
    ),
    isAvailable: options.isAvailable === undefined ? () => true : options.isAvailable,
    provide: options.provide,
  })

const makeFragment = (
  providerId: ContextProviderId,
  content: string,
  estimatedTokens: number,
  sourceRefs: ReadonlyArray<string>,
): ContextFragment =>
  ContextFragment.make({
    providerId,
    label: `Context from ${providerId}`,
    content,
    sourceRefs,
    untrusted: true,
    estimatedTokens: TokenCount.make(estimatedTokens),
  })

it.effect(
  'starts providers concurrently, preserves registration order, and interrupts slow work at the shared deadline',
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstId = ContextProviderId.make('first.context')
        const secondId = ContextProviderId.make('second.context')
        const slowId = ContextProviderId.make('slow.context')
        const firstStarted = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const slowStarted = yield* Deferred.make<void>()
        const firstRelease = yield* Deferred.make<void>()
        const secondRelease = yield* Deferred.make<void>()
        const firstReturned = yield* Deferred.make<void>()
        const secondReturned = yield* Deferred.make<void>()
        const slowInterrupted = yield* Deferred.make<void>()
        const completed = yield* Deferred.make<ContextAssembly.Assembly>()

        const first = makeProvider({
          id: firstId,
          provide: () =>
            Deferred.succeed(firstStarted, undefined).pipe(
              Effect.andThen(Deferred.await(firstRelease)),
              Effect.andThen(Deferred.succeed(firstReturned, undefined)),
              Effect.as(Option.some(makeFragment(firstId, 'first fragment', 10, ['first-ref']))),
            ),
        })
        const second = makeProvider({
          id: secondId,
          provide: () =>
            Deferred.succeed(secondStarted, undefined).pipe(
              Effect.andThen(Deferred.await(secondRelease)),
              Effect.andThen(Deferred.succeed(secondReturned, undefined)),
              Effect.as(Option.some(makeFragment(secondId, 'second fragment', 10, ['second-ref']))),
            ),
        })
        const slow = makeProvider({
          id: slowId,
          provide: () =>
            Deferred.succeed(slowStarted, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(slowInterrupted, undefined)),
            ),
        })

        yield* ContextAssembly.collect({
          providers: [first, second, slow],
          scope: SCOPE,
          focus: FOCUS,
        }).pipe(
          Effect.flatMap((assembly) => Deferred.succeed(completed, assembly)),
          Effect.asVoid,
          Effect.forkScoped,
        )

        yield* Effect.all(
          [
            Deferred.await(firstStarted),
            Deferred.await(secondStarted),
            Deferred.await(slowStarted),
          ],
          { concurrency: 'unbounded', discard: true },
        )
        yield* Deferred.succeed(secondRelease, undefined)
        yield* Deferred.await(secondReturned)
        yield* Deferred.succeed(firstRelease, undefined)
        yield* Deferred.await(firstReturned)

        yield* TestClock.adjust(Duration.millis(ContextAssembly.CONTEXT_TOTAL_DEADLINE_MS - 1))
        expect(yield* Deferred.isDone(completed)).toBe(false)
        expect(yield* Deferred.isDone(slowInterrupted)).toBe(false)

        yield* TestClock.adjust(Duration.millis(1))
        const assembly = yield* Deferred.await(completed)

        expect(yield* Deferred.isDone(slowInterrupted)).toBe(true)
        expect(assembly.fragments.map((fragment) => fragment.providerId)).toEqual([
          firstId,
          secondId,
        ])
        expect(assembly.sourceRefs).toEqual(['first-ref', 'second-ref'])
        const rendered = Option.getOrNull(assembly.content)
        expect(rendered).not.toBeNull()
        if (rendered === null) return yield* Effect.die('Expected rendered context')
        expect(rendered.indexOf('first fragment')).toBeLessThan(rendered.indexOf('second fragment'))
        expect(rendered).not.toContain('slow fragment')
      }),
    ),
)

it.effect('isolates one provider failure and a throwing availability check', () =>
  Effect.gen(function* () {
    const successId = ContextProviderId.make('success.context')
    const failureId = ContextProviderId.make('failure.context')
    const unavailableProvide = vi.fn(() => Effect.succeed(Option.none<ContextFragment>()))
    const throwingProvide = vi.fn(() => Effect.succeed(Option.none<ContextFragment>()))
    const synchronouslyThrowingProvide = vi.fn(() => {
      throw new Error('third-party provider threw before returning an Effect')
    })
    const throwingAvailability = vi.fn(() => {
      throw new Error('third-party availability check failed')
    })
    const providers = [
      makeProvider({
        id: successId,
        provide: () =>
          Effect.succeed(
            Option.some(makeFragment(successId, 'retained context', 8, ['retained-ref'])),
          ),
      }),
      makeProvider({
        id: failureId,
        provide: () =>
          Effect.fail(
            new ContextProviderError({ providerId: failureId, reason: 'execution-failed' }),
          ),
      }),
      makeProvider({
        id: 'unavailable.context',
        isAvailable: () => false,
        provide: unavailableProvide,
      }),
      makeProvider({
        id: 'throwing.context',
        isAvailable: throwingAvailability,
        provide: throwingProvide,
      }),
      makeProvider({
        id: 'synchronously-throwing.context',
        provide: synchronouslyThrowingProvide,
      }),
    ]

    const assembly = yield* ContextAssembly.collect({ providers, scope: SCOPE, focus: FOCUS })

    expect(assembly.fragments.map((fragment) => fragment.providerId)).toEqual([successId])
    expect(assembly.sourceRefs).toEqual(['retained-ref'])
    expect(Option.getOrNull(assembly.content)).toContain('retained context')
    expect(unavailableProvide).not.toHaveBeenCalled()
    expect(throwingAvailability).toHaveBeenCalledOnce()
    expect(throwingProvide).not.toHaveBeenCalled()
    expect(synchronouslyThrowingProvide).toHaveBeenCalledOnce()
  }),
)

it.effect(
  'applies the total token cap in registration order and deduplicates source references',
  () =>
    Effect.gen(function* () {
      const firstId = ContextProviderId.make('budget-first.context')
      const secondId = ContextProviderId.make('budget-second.context')
      const excludedId = ContextProviderId.make('budget-excluded.context')
      const providers = [
        makeProvider({
          id: firstId,
          provide: () =>
            Effect.succeed(
              Option.some(
                makeFragment(firstId, 'first budget fragment', 2_048, ['shared-ref', 'first-ref']),
              ),
            ),
        }),
        makeProvider({
          id: secondId,
          provide: () =>
            Effect.succeed(
              Option.some(
                makeFragment(secondId, 'second budget fragment', 2_048, [
                  'shared-ref',
                  'second-ref',
                ]),
              ),
            ),
        }),
        makeProvider({
          id: excludedId,
          provide: () =>
            Effect.succeed(
              Option.some(
                makeFragment(excludedId, 'excluded by total budget', 1, ['excluded-ref']),
              ),
            ),
        }),
      ]

      const assembly = yield* ContextAssembly.collect({ providers, scope: SCOPE, focus: FOCUS })

      expect(assembly.fragments.map((fragment) => fragment.providerId)).toEqual([firstId, secondId])
      expect(
        assembly.fragments.reduce((total, fragment) => total + fragment.estimatedTokens, 0),
      ).toBe(ContextAssembly.MAX_CONTEXT_TOTAL_TOKENS)
      expect(assembly.sourceRefs).toEqual(['shared-ref', 'first-ref', 'second-ref'])
      expect(Option.getOrNull(assembly.content)).not.toContain('excluded by total budget')
    }),
)

it.effect('rejects an understated fragment that exceeds its rendered provider byte budget', () =>
  Effect.gen(function* () {
    const providerId = ContextProviderId.make('oversized.context')
    const provider = makeProvider({
      id: providerId,
      provide: () =>
        Effect.succeed(
          Option.some(
            makeFragment(providerId, '界'.repeat(ContextAssembly.MAX_CONTEXT_PROVIDER_BYTES), 1, [
              'oversized-ref',
            ]),
          ),
        ),
    })

    const assembly = yield* ContextAssembly.collect({
      providers: [provider],
      scope: SCOPE,
      focus: FOCUS,
    })

    expect(assembly.fragments).toEqual([])
    expect(assembly.sourceRefs).toEqual([])
    expect(Option.isNone(assembly.content)).toBe(true)
  }),
)

it.effect('caps understated fragments by final rendered UTF-8 size in registration order', () =>
  Effect.gen(function* () {
    const providers = Array.from({ length: 4 }, (_, index) => {
      const providerId = ContextProviderId.make(`rendered-budget-${String(index)}.context`)
      return makeProvider({
        id: providerId,
        provide: () =>
          Effect.succeed(
            Option.some(
              makeFragment(providerId, 'x'.repeat(5_000), 1, [`rendered-ref-${String(index)}`]),
            ),
          ),
      })
    })

    const assembly = yield* ContextAssembly.collect({ providers, scope: SCOPE, focus: FOCUS })
    const rendered = Option.getOrNull(assembly.content)

    expect(assembly.fragments.map((fragment) => fragment.providerId)).toEqual(
      providers.slice(0, 3).map((provider) => provider.id),
    )
    expect(assembly.sourceRefs).toEqual(['rendered-ref-0', 'rendered-ref-1', 'rendered-ref-2'])
    expect(rendered).not.toBeNull()
    if (rendered === null) return yield* Effect.die('Expected rendered context')
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(
      ContextAssembly.MAX_CONTEXT_TOTAL_BYTES,
    )
    expect(rendered).not.toContain('rendered-ref-3')
  }),
)

it.effect('selects available providers before applying the per-turn provider cap', () =>
  Effect.gen(function* () {
    const unavailable = Array.from({ length: ContextAssembly.MAX_CONTEXT_PROVIDERS }, (_, index) =>
      makeProvider({
        id: `hidden-${String(index)}.context`,
        isAvailable: () => false,
        provide: () => Effect.die('Unavailable provider must not run'),
      }),
    )
    const visibleId = ContextProviderId.make('late-visible.context')
    const visible = makeProvider({
      id: visibleId,
      provide: () =>
        Effect.succeed(Option.some(makeFragment(visibleId, 'late visible context', 8, []))),
    })

    const assembly = yield* ContextAssembly.collect({
      providers: [...unavailable, visible],
      scope: SCOPE,
      focus: FOCUS,
    })

    expect(assembly.fragments.map((fragment) => fragment.providerId)).toEqual([visibleId])
    expect(Option.getOrNull(assembly.content)).toContain('late visible context')
  }),
)
