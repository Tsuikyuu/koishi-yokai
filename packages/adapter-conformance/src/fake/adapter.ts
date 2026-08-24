import { Effect, Option, Ref, Schema } from 'effect'

import {
  AdapterDescriptor,
  AdapterModelSnapshot,
  AdapterProtocolDecodeError,
  AdapterProtocolViolationError,
  AdapterUnsupportedError,
  CURRENT_ADAPTER_PROTOCOL_VERSION,
  ContinueRequest,
  FinalTextResult,
  GenerateRequest,
  ToolCallBatch,
  ToolCalls,
  type AdapterId,
  type AdapterInvocationError,
  type AdapterInvocationOperation,
  type AdapterModelId,
  type FinalTextResult as FinalTextResultType,
  type ToolCall,
  type ToolResult,
  type YokaiAdapter,
  makeAdapterContinuationError,
} from 'yokai-protocol'

import type {
  AdapterConformanceControl,
  AdapterConformanceFactory,
  AdapterConformanceRawModel,
  AdapterConformanceSetup,
  AdapterConformanceSubject,
  AdapterDiscoveryStep,
  AdapterGenerationStep,
} from '../index'
import { makeFakeContinuationStore } from './continuation-store'
import { makeFakeInvocationError } from './error'
import { makeFakeProviderHarness } from './provider-harness'

export interface FakeAdapterFactoryOptions {
  readonly adapterId: AdapterId
  readonly feedbackTools: boolean
  readonly tokenNamespace: string
}

export interface FakeAdapterControl extends AdapterConformanceControl {
  readonly pendingContinuations: () => Effect.Effect<number>
}

export interface FakeAdapterSubject extends AdapterConformanceSubject {
  readonly control: FakeAdapterControl
}

const decodeFailure = (
  adapterId: AdapterId,
  operation: AdapterInvocationOperation,
  modelId: Option.Option<AdapterModelId>,
): AdapterProtocolDecodeError => {
  const base = {
    adapterId,
    operation,
    message: 'Fake provider response was invalid',
  }
  return Option.match(modelId, {
    onNone: () => new AdapterProtocolDecodeError(base),
    onSome: (value) => new AdapterProtocolDecodeError({ ...base, modelId: value }),
  })
}

const violation = (
  adapterId: AdapterId,
  operation: 'generate' | 'continue',
  modelId: AdapterModelId,
  reason:
    'undeclared-tool-call' | 'duplicate-call-id' | 'result-set-mismatch' | 'unexpected-tool-call',
): AdapterProtocolViolationError =>
  new AdapterProtocolViolationError({
    adapterId,
    modelId,
    operation,
    message: 'Fake adapter protocol violation',
    reason,
  })

const uniqueSorted = <A>(values: ReadonlyArray<A>, key: (value: A) => string): ReadonlyArray<A> => {
  const unique = values.reduce<ReadonlyArray<A>>(
    (current, value) =>
      current.some((candidate) => key(candidate) === key(value)) ? current : [...current, value],
    [],
  )
  return [...unique].sort((left, right) => {
    const leftKey = key(left)
    const rightKey = key(right)
    if (leftKey < rightKey) return -1
    if (leftKey > rightKey) return 1
    return 0
  })
}

const normalizeRawModel = (model: AdapterConformanceRawModel) => {
  const methods =
    model.supportedGenerationMethods === undefined
      ? {}
      : {
          supportedGenerationMethods: uniqueSorted(
            model.supportedGenerationMethods,
            (method) => method,
          ),
        }
  const inputLimit =
    model.inputTokenLimit === undefined ? {} : { inputTokenLimit: model.inputTokenLimit }
  const outputLimit =
    model.outputTokenLimit === undefined ? {} : { outputTokenLimit: model.outputTokenLimit }
  return {
    id: model.id,
    displayName: model.displayName,
    availability: model.availability,
    discoveryFreshness: model.discoveryFreshness,
    ...inputLimit,
    ...outputLimit,
    ...methods,
  }
}

const decodeSnapshot = Effect.fn('FakeAdapter.decodeSnapshot')(function* (
  adapterId: AdapterId,
  step: Extract<AdapterDiscoveryStep, { readonly _tag: 'Success' }>,
) {
  const models = uniqueSorted(step.models, (model) => model.id).map(normalizeRawModel)
  return yield* Schema.decodeUnknownEffect(AdapterModelSnapshot)({
    discoveredAt: step.discoveredAt,
    models,
  }).pipe(Effect.mapError(() => decodeFailure(adapterId, 'discoverModels', Option.none())))
})

const decodeText = Effect.fn('FakeAdapter.decodeText')(function* (
  adapterId: AdapterId,
  operation: 'generate' | 'continue',
  modelId: AdapterModelId,
  result: FinalTextResultType,
) {
  return yield* Schema.decodeUnknownEffect(FinalTextResult)(result).pipe(
    Effect.mapError(() => decodeFailure(adapterId, operation, Option.some(modelId))),
  )
})

const takeStep = <A>(steps: Ref.Ref<ReadonlyArray<A>>, invariant: string): Effect.Effect<A> =>
  Ref.modify(steps, (current) => {
    const head = current[0]
    return head === undefined ? [Option.none<A>(), current] : [Option.some(head), current.slice(1)]
  }).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die(invariant),
        onSome: Effect.succeed,
      }),
    ),
  )

const providerResponse = <A extends AdapterDiscoveryStep | AdapterGenerationStep>(
  step: A,
  adapterId: AdapterId,
  operation: AdapterInvocationOperation,
  modelId: Option.Option<AdapterModelId>,
): Effect.Effect<A, AdapterInvocationError> =>
  step._tag === 'Failure'
    ? Effect.fail(makeFakeInvocationError(step.failure, adapterId, operation, modelId))
    : Effect.succeed(step)

const validateToolCalls = Effect.fn('FakeAdapter.validateToolCalls')(function* (
  adapterId: AdapterId,
  request: GenerateRequest,
  step: Extract<AdapterGenerationStep, { readonly _tag: 'ToolCalls' }>,
) {
  const callIds = step.calls.map((call) => call.callId)
  if (new Set(callIds).size !== callIds.length) {
    return yield* Effect.fail(
      violation(adapterId, 'generate', request.modelId, 'duplicate-call-id'),
    )
  }

  const declaredToolIds = request.feedbackTools.map((tool) => tool.id)
  if (step.calls.some((call) => !declaredToolIds.includes(call.toolId))) {
    return yield* Effect.fail(
      violation(adapterId, 'generate', request.modelId, 'undeclared-tool-call'),
    )
  }

  return yield* Schema.decodeUnknownEffect(ToolCalls)(step.calls).pipe(
    Effect.mapError(() => decodeFailure(adapterId, 'generate', Option.some(request.modelId))),
  )
})

const orderResults = Effect.fn('FakeAdapter.orderResults')(function* (
  adapterId: AdapterId,
  modelId: AdapterModelId,
  calls: ReadonlyArray<ToolCall>,
  results: ReadonlyArray<ToolResult>,
) {
  if (
    calls.length !== results.length ||
    calls.some((call) => !results.some((result) => result.callId === call.callId))
  ) {
    return yield* Effect.fail(violation(adapterId, 'continue', modelId, 'result-set-mismatch'))
  }

  return yield* Effect.forEach(calls, (call) => {
    const result = results.find((candidate) => candidate.callId === call.callId)
    return result === undefined
      ? Effect.fail(violation(adapterId, 'continue', modelId, 'result-set-mismatch'))
      : Effect.succeed(result)
  })
})

export const makeFakeAdapter = Effect.fn('FakeAdapter.make')(function* (
  options: FakeAdapterFactoryOptions,
  setup: AdapterConformanceSetup,
) {
  const descriptor = AdapterDescriptor.make({
    id: options.adapterId,
    protocolVersion: CURRENT_ADAPTER_PROTOCOL_VERSION,
    capabilities: { feedbackTools: options.feedbackTools },
  })
  const discoverySteps = yield* Ref.make(setup.discoverySteps)
  const generationSteps = yield* Ref.make(setup.generationSteps)
  const continuations = yield* makeFakeContinuationStore(options.adapterId, options.tokenNamespace)
  const provider = yield* makeFakeProviderHarness()

  yield* Effect.addFinalizer(() => continuations.clear())

  const discoverModels = Effect.fn('FakeAdapter.discoverModels')(function* () {
    const step = yield* takeStep(discoverySteps, 'Fake adapter discovery script exhausted')
    const response = yield* provider.run(
      {
        kind: 'model-list',
        operation: 'discoverModels',
        modelId: Option.none(),
        resultCallIds: [],
        owningScope: Option.none(),
      },
      step.blocked,
      providerResponse(step, options.adapterId, 'discoverModels', Option.none()),
    )
    if (response._tag === 'Failure') {
      return yield* Effect.die('Fake provider returned an impossible failure value')
    }
    return yield* decodeSnapshot(options.adapterId, response)
  })

  const generate = Effect.fn('FakeAdapter.generate')(function* (input: GenerateRequest) {
    const request = yield* Schema.decodeUnknownEffect(GenerateRequest)(input).pipe(
      Effect.mapError(() => decodeFailure(options.adapterId, 'generate', Option.none())),
    )
    if (!options.feedbackTools && request.feedbackTools.length > 0) {
      return yield* Effect.fail(
        new AdapterUnsupportedError({
          adapterId: options.adapterId,
          modelId: request.modelId,
          operation: 'generate',
          message: 'Fake adapter does not support feedback tools',
          feature: 'feedback-tools',
        }),
      )
    }

    const owningScope = yield* Effect.scope
    const step = yield* takeStep(generationSteps, 'Fake adapter generation script exhausted')
    const response = yield* provider.run(
      {
        kind: 'generation',
        operation: 'generate',
        modelId: Option.some(request.modelId),
        resultCallIds: [],
        owningScope: Option.some(owningScope),
      },
      step.blocked,
      providerResponse(step, options.adapterId, 'generate', Option.some(request.modelId)),
    )
    if (response._tag === 'Failure') {
      return yield* Effect.die('Fake provider returned an impossible failure value')
    }
    if (response._tag === 'Text') {
      return yield* decodeText(options.adapterId, 'generate', request.modelId, response.result)
    }

    const calls = yield* validateToolCalls(options.adapterId, request, response)
    const continuation = yield* continuations.create(request.modelId, calls)
    return yield* Schema.decodeUnknownEffect(ToolCallBatch)({
      _tag: 'ToolCallBatch',
      calls,
      continuation,
      usage: response.usage,
    }).pipe(
      Effect.mapError(() =>
        decodeFailure(options.adapterId, 'generate', Option.some(request.modelId)),
      ),
    )
  })

  const continueGeneration = Effect.fn('FakeAdapter.continue')(function* (input: ContinueRequest) {
    const request = yield* Schema.decodeUnknownEffect(ContinueRequest)(input).pipe(
      Effect.mapError(() => makeAdapterContinuationError(options.adapterId)),
    )

    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const claimed = yield* continuations.claim(request.continuation)
        const work = Effect.gen(function* () {
          const orderedResults = yield* orderResults(
            options.adapterId,
            claimed.modelId,
            claimed.calls,
            request.results,
          )
          const step = yield* takeStep(
            generationSteps,
            'Fake adapter continuation script exhausted',
          )
          const response = yield* provider.run(
            {
              kind: 'generation',
              operation: 'continue',
              modelId: Option.some(claimed.modelId),
              resultCallIds: orderedResults.map((result) => result.callId),
              owningScope: Option.some(claimed.owningScope),
            },
            step.blocked,
            providerResponse(step, options.adapterId, 'continue', Option.some(claimed.modelId)),
          )
          if (response._tag === 'Failure') {
            return yield* Effect.die('Fake provider returned an impossible failure value')
          }
          if (response._tag === 'ToolCalls') {
            return yield* Effect.fail(
              violation(options.adapterId, 'continue', claimed.modelId, 'unexpected-tool-call'),
            )
          }
          return yield* decodeText(options.adapterId, 'continue', claimed.modelId, response.result)
        })

        return yield* restore(work).pipe(Effect.ensuring(continuations.remove(claimed.key)))
      }),
    )
  })

  const adapter: YokaiAdapter = {
    descriptor,
    discoverModels,
    generate,
    continue: continueGeneration,
  }

  return {
    adapter,
    control: {
      ...provider.control,
      pendingContinuations: continuations.size,
    },
  } satisfies FakeAdapterSubject
})

export const makeFakeAdapterConformanceFactory = (
  options: FakeAdapterFactoryOptions,
): AdapterConformanceFactory => ({
  make: (setup) => makeFakeAdapter(options, setup),
})
