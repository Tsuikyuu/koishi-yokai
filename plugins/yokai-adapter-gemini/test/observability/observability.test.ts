import { expect, it } from '@effect/vitest'
import { AdapterId, AdapterModelId, TokenCount } from '@yokai/protocol'
import { Effect, Logger, Metric, Option, Ref } from 'effect'

import {
  recordGenerationUsage,
  trackLogicalInvocation,
  trackPhysicalAttempt,
} from '../../src/observability/observability'

const ADAPTER_ID = AdapterId.make('gemini-observability-test')
const MODEL_ID = AdapterModelId.make('gemini-2.5-flash')

const context = {
  adapterId: ADAPTER_ID,
  operation: 'generate',
  modelId: Option.some(MODEL_ID),
} as const

const counter = (name: string, kind: 'logical' | 'physical') =>
  Metric.counter(name, {
    description: `Gemini adapter ${kind === 'logical' ? 'logical-invocation' : 'physical-attempt'} completions`,
    incremental: true,
    attributes: {
      adapter_id: ADAPTER_ID,
      operation: 'generate',
      status: kind === 'logical' ? 'failure' : 'success',
    },
  })

it.effect('records logical invocations and physical attempts as separate metrics', () =>
  Effect.gen(function* () {
    const registry = new Map()
    const program = Effect.gen(function* () {
      yield* trackPhysicalAttempt(context, Effect.succeed('ok'))
      yield* trackLogicalInvocation(context, Effect.fail('expected')).pipe(Effect.ignore)

      const logical = yield* Metric.value(
        counter('yokai_gemini_logical_invocations_total', 'logical'),
      )
      const physical = yield* Metric.value(
        counter('yokai_gemini_physical_attempts_total', 'physical'),
      )
      expect(logical.count).toBe(1)
      expect(physical.count).toBe(1)
    })

    yield* program.pipe(Effect.provideService(Metric.MetricRegistry, registry))
  }),
)

it.effect('records reported usage and logs only whitelisted safe fields', () =>
  Effect.gen(function* () {
    const providerCanary = 'provider-secret-must-not-appear'
    const logged = yield* Ref.make<ReadonlyArray<string>>([])
    const logger = Logger.map(Logger.formatStructured, (output) => {
      Ref.update(logged, (entries) => [...entries, JSON.stringify(output)]).pipe(Effect.runSync)
    })
    const registry = new Map()

    yield* Effect.gen(function* () {
      yield* trackLogicalInvocation(context, Effect.fail(new Error(providerCanary))).pipe(
        Effect.ignore,
      )
      yield* recordGenerationUsage(context, {
        _tag: 'Reported',
        inputTokens: TokenCount.make(12),
        outputTokens: TokenCount.make(7),
        totalTokens: TokenCount.make(19),
      })

      const total = yield* Metric.value(
        Metric.counter('yokai_gemini_generation_tokens_total', {
          description: 'Gemini adapter reported generation tokens',
          incremental: true,
          attributes: {
            adapter_id: ADAPTER_ID,
            operation: 'generate',
            token_kind: 'total',
          },
        }),
      )
      expect(total.count).toBe(19)
    }).pipe(
      Effect.provide(Logger.layer([logger])),
      Effect.provideService(Metric.MetricRegistry, registry),
    )

    const serialized = (yield* Ref.get(logged)).join('\n')
    expect(serialized).toContain(ADAPTER_ID)
    expect(serialized).toContain(MODEL_ID)
    expect(serialized).toContain('durationMs')
    expect(serialized).toContain('totalTokens')
    expect(serialized).not.toContain(providerCanary)
  }),
)
