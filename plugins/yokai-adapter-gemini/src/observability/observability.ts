import type { AdapterId, AdapterModelId, GenerationUsage } from '@yokai/protocol'
import { Clock, Duration, Effect, Exit, Metric, Option } from 'effect'

export type InvocationOperation = 'continue' | 'discoverModels' | 'generate'

interface InvocationContext {
  readonly adapterId: AdapterId
  readonly operation: InvocationOperation
  readonly modelId: Option.Option<AdapterModelId>
}

type InvocationStatus = 'cancelled' | 'failure' | 'success'

const DURATION_BOUNDARIES_MS = [
  10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000,
]

const metricAttributes = (
  context: InvocationContext,
  status: InvocationStatus,
): Readonly<Record<string, string>> => ({
  adapter_id: context.adapterId,
  operation: context.operation,
  status,
})

const logAnnotations = (
  context: InvocationContext,
  status: InvocationStatus,
  durationMs: number,
) => {
  const base = {
    adapterId: context.adapterId,
    operation: context.operation,
    status,
    durationMs,
  }
  return Option.match(context.modelId, {
    onNone: () => base,
    onSome: (modelId) => ({ ...base, modelId }),
  })
}

const invocationStatus = <A, E>(exit: Exit.Exit<A, E>): InvocationStatus => {
  if (Exit.isSuccess(exit)) return 'success'
  return Exit.hasInterrupts(exit) ? 'cancelled' : 'failure'
}

const recordCompletion = <A, E>(
  kind: 'logical-invocation' | 'physical-attempt',
  context: InvocationContext,
  startedAtNanos: bigint,
  exit: Exit.Exit<A, E>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const finishedAtNanos = yield* Clock.currentTimeNanos
    const durationMs = Math.max(
      0,
      Duration.toMillis(Duration.nanos(finishedAtNanos - startedAtNanos)),
    )
    const status = invocationStatus(exit)
    const name =
      kind === 'logical-invocation'
        ? 'yokai_gemini_logical_invocations_total'
        : 'yokai_gemini_physical_attempts_total'
    const durationName =
      kind === 'logical-invocation'
        ? 'yokai_gemini_logical_invocation_duration_ms'
        : 'yokai_gemini_physical_attempt_duration_ms'
    const attributes = metricAttributes(context, status)

    yield* Metric.update(
      Metric.counter(name, {
        description: `Gemini adapter ${kind} completions`,
        incremental: true,
        attributes,
      }),
      1,
    )
    yield* Metric.update(
      Metric.histogram(durationName, {
        description: `Gemini adapter ${kind} duration in milliseconds`,
        boundaries: DURATION_BOUNDARIES_MS,
        attributes,
      }),
      durationMs,
    )
    yield* Effect.logInfo(`Gemini adapter ${kind}`).pipe(
      Effect.annotateLogs(logAnnotations(context, status, durationMs)),
    )
  })

const track = <A, E, R>(
  kind: 'logical-invocation' | 'physical-attempt',
  context: InvocationContext,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const startedAtNanos = yield* Clock.currentTimeNanos
    return yield* effect.pipe(
      Effect.onExit((exit) => recordCompletion(kind, context, startedAtNanos, exit)),
    )
  })

export const trackLogicalInvocation = <A, E, R>(
  context: InvocationContext,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => track('logical-invocation', context, effect)

export const trackPhysicalAttempt = <A, E, R>(
  context: InvocationContext,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => track('physical-attempt', context, effect)

const updateUsageMetric = (
  context: InvocationContext,
  tokenKind: string,
  value: number | undefined,
): Effect.Effect<void> =>
  value === undefined
    ? Effect.void
    : Metric.update(
        Metric.counter('yokai_gemini_generation_tokens_total', {
          description: 'Gemini adapter reported generation tokens',
          incremental: true,
          attributes: {
            adapter_id: context.adapterId,
            operation: context.operation,
            token_kind: tokenKind,
          },
        }),
        value,
      )

export const recordGenerationUsage = Effect.fn('GeminiObservability.recordGenerationUsage')(
  function* (context: InvocationContext, usage: GenerationUsage) {
    if (usage._tag === 'Unavailable') {
      yield* Effect.logInfo('Gemini adapter generation usage').pipe(
        Effect.annotateLogs({
          adapterId: context.adapterId,
          operation: context.operation,
          usage: 'unavailable',
          ...Option.match(context.modelId, {
            onNone: () => ({}),
            onSome: (modelId) => ({ modelId }),
          }),
        }),
      )
      return
    }

    yield* Effect.all(
      [
        updateUsageMetric(context, 'input', usage.inputTokens),
        updateUsageMetric(context, 'output', usage.outputTokens),
        updateUsageMetric(context, 'total', usage.totalTokens),
        updateUsageMetric(context, 'cached_input', usage.cachedInputTokens),
        updateUsageMetric(context, 'reasoning_output', usage.reasoningOutputTokens),
      ],
      { discard: true },
    )
    yield* Effect.logInfo('Gemini adapter generation usage').pipe(
      Effect.annotateLogs({
        adapterId: context.adapterId,
        operation: context.operation,
        usage: 'reported',
        ...Option.match(context.modelId, {
          onNone: () => ({}),
          onSome: (modelId) => ({ modelId }),
        }),
        ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
        ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
        ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
        ...(usage.cachedInputTokens === undefined
          ? {}
          : { cachedInputTokens: usage.cachedInputTokens }),
        ...(usage.reasoningOutputTokens === undefined
          ? {}
          : { reasoningOutputTokens: usage.reasoningOutputTokens }),
      }),
    )
  },
)

export * as GeminiObservability from './observability'
