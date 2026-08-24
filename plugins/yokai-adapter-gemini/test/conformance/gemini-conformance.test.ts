import {
  FinishReason,
  FunctionCallingConfigMode,
  GenerateContentResponse,
  PagedItem,
  Pager,
  type GenerateContentParameters,
  type Model,
} from '@google/genai'
import type {
  AdapterConformanceFactory,
  AdapterConformanceFailure,
  AdapterConformanceRawModel,
  AdapterConformanceSetup,
  AdapterDiscoveryStep,
  AdapterGenerationStep,
} from 'yokai-adapter-conformance'
import {
  makeFakeProviderHarness,
  type FakeProviderHarness,
  type FakeProviderRequest,
} from 'yokai-adapter-conformance/fake'
import { defineAdapterConformanceSuite } from 'yokai-adapter-conformance/vitest'
import {
  AdapterAuthenticationError,
  AdapterCancelledError,
  AdapterConfigurationError,
  AdapterId,
  AdapterInternalError,
  AdapterInvocationError,
  AdapterModelId,
  AdapterProtocolDecodeError,
  AdapterProviderResponseError,
  AdapterRateLimitError,
  AdapterTimeoutError,
  AdapterTransportError,
  AdapterUnsupportedError,
  type ToolCallId,
  type GenerationUsage,
} from 'yokai-protocol'
import { Cause, Context, Effect, Exit, Layer, Option, Ref } from 'effect'

import { GeminiAdapter } from '../../src/adapter/adapter'
import { GeminiClientFactory } from '../../src/client/client-factory'
import { GeminiConfiguration } from '../../src/config/configuration'
import { GeminiConnection } from '../../src/connection/connection'
import { GeminiContinuationStore } from '../../src/continuation/store'
import { GeminiContinuationTokenGenerator } from '../../src/continuation/token-generator'
import { GeminiModelDiscovery } from '../../src/discovery/discovery'
import { GeminiTextGeneration } from '../../src/generation/generation'

const ADAPTER_ID = AdapterId.make('gemini-conformance')
const BASE_URL = 'https://conformance.invalid/'

const takeStep = <A>(steps: Ref.Ref<ReadonlyArray<A>>, exhausted: string): A => {
  const step = Ref.modify(steps, (current) => [current[0], current.slice(1)]).pipe(Effect.runSync)
  if (step === undefined) throw new Error(exhausted)
  return step
}

const fields = (
  operation: 'continue' | 'discoverModels' | 'generate',
  modelId: Option.Option<AdapterModelId>,
  message: string,
) =>
  Option.match(modelId, {
    onNone: () => ({ adapterId: ADAPTER_ID, operation, message }),
    onSome: (value) => ({ adapterId: ADAPTER_ID, operation, modelId: value, message }),
  })

const failureError = (
  failure: AdapterConformanceFailure,
  operation: 'continue' | 'discoverModels' | 'generate',
  modelId: Option.Option<AdapterModelId>,
): AdapterInvocationError => {
  const base = fields(operation, modelId, failure.providerMessage)
  switch (failure.category) {
    case 'configuration':
      return new AdapterConfigurationError(base)
    case 'authentication':
      return new AdapterAuthenticationError(base)
    case 'rate-limit':
      return new AdapterRateLimitError({
        ...base,
        ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
      })
    case 'timeout':
      return new AdapterTimeoutError(base)
    case 'provider-cancelled':
      return new AdapterCancelledError(base)
    case 'transport':
      return new AdapterTransportError(base)
    case 'provider-response':
      return new AdapterProviderResponseError({
        ...base,
        ...(failure.statusCode === undefined ? {} : { statusCode: failure.statusCode }),
      })
    case 'protocol-decode':
      return new AdapterProtocolDecodeError(base)
    case 'internal':
      return new AdapterInternalError(base)
    case 'unsupported':
      return new AdapterUnsupportedError({ ...base, feature: 'feedback-tools' })
  }
}

const waitForAbort = (signal: AbortSignal): Effect.Effect<never> =>
  Effect.callback<void>((resume) => {
    let listening = true
    const abort = () => {
      if (!listening) return
      listening = false
      resume(Effect.interrupt)
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    return Effect.sync(() => {
      listening = false
      signal.removeEventListener('abort', abort)
    })
  }).pipe(Effect.andThen(Effect.never))

const abortError = () => {
  const error = new Error('Conformance provider request aborted')
  error.name = 'AbortError'
  return error
}

const unwrapProviderExit = <A>(exit: Exit.Exit<A, AdapterInvocationError>): Promise<A> => {
  if (Exit.isSuccess(exit)) return Promise.resolve(exit.value)
  const error = Cause.findErrorOption(exit.cause)
  return Option.match(error, {
    onNone: () => Promise.reject(abortError()),
    onSome: (value) => Promise.reject(value),
  })
}

const runProvider = <A extends AdapterDiscoveryStep | AdapterGenerationStep>(
  provider: FakeProviderHarness,
  request: FakeProviderRequest,
  step: A,
  signal: AbortSignal,
): Promise<A> => {
  const response =
    step._tag === 'Failure'
      ? Effect.fail(failureError(step.failure, request.operation, request.modelId))
      : Effect.succeed(step)
  return Effect.runPromiseExit(
    Effect.raceFirst(provider.run(request, step.blocked, response), waitForAbort(signal)),
  ).then(unwrapProviderExit)
}

const providerModel = (raw: AdapterConformanceRawModel): Model => {
  const model = {
    name: `models/${raw.id}`,
    displayName: raw.displayName,
    availability: raw.availability,
    discoveryFreshness: raw.discoveryFreshness,
    ...(raw.inputTokenLimit === undefined ? {} : { inputTokenLimit: raw.inputTokenLimit }),
    ...(raw.outputTokenLimit === undefined ? {} : { outputTokenLimit: raw.outputTokenLimit }),
    ...(raw.supportedGenerationMethods === undefined
      ? {}
      : { supportedActions: [...raw.supportedGenerationMethods] }),
  }
  return model
}

const pager = (models: ReadonlyArray<Model>): Pager<Model> =>
  new Pager<Model>(
    PagedItem.PAGED_ITEM_MODELS,
    () => Promise.resolve({ models: [] }),
    { models: [...models] },
    { config: {} },
  )

const usageMetadata = (usage: GenerationUsage) =>
  usage._tag === 'Unavailable'
    ? {}
    : {
        usageMetadata: {
          ...(usage.inputTokens === undefined ? {} : { promptTokenCount: usage.inputTokens }),
          ...(usage.outputTokens === undefined ? {} : { candidatesTokenCount: usage.outputTokens }),
          ...(usage.totalTokens === undefined ? {} : { totalTokenCount: usage.totalTokens }),
          ...(usage.cachedInputTokens === undefined
            ? {}
            : { cachedContentTokenCount: usage.cachedInputTokens }),
          ...(usage.reasoningOutputTokens === undefined
            ? {}
            : { thoughtsTokenCount: usage.reasoningOutputTokens }),
        },
      }

const finishReason = (reason: 'content-filter' | 'length' | 'other' | 'stop' | 'unknown') => {
  switch (reason) {
    case 'stop':
      return FinishReason.STOP
    case 'length':
      return FinishReason.MAX_TOKENS
    case 'content-filter':
      return FinishReason.SAFETY
    case 'other':
      return FinishReason.OTHER
    case 'unknown':
      return FinishReason.FINISH_REASON_UNSPECIFIED
  }
}

const generationResponse = (
  step: Exclude<AdapterGenerationStep, { readonly _tag: 'Failure' }>,
): GenerateContentResponse => {
  if (step._tag === 'Text') {
    return Object.assign(new GenerateContentResponse(), {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: step.result.text }] },
          finishReason: finishReason(step.result.finishReason),
        },
      ],
      ...usageMetadata(step.result.usage),
    })
  }
  return Object.assign(new GenerateContentResponse(), {
    candidates: [
      {
        content: {
          role: 'model',
          parts: step.calls.map((call) => ({
            functionCall: { id: call.callId, name: call.toolId, args: call.input },
          })),
        },
        finishReason: FinishReason.STOP,
      },
    ],
    ...usageMetadata(step.usage),
  })
}

const operationFrom = (params: GenerateContentParameters) => {
  const config = params.config
  const toolConfig = config === undefined ? undefined : config.toolConfig
  const functionCallingConfig =
    toolConfig === undefined ? undefined : toolConfig.functionCallingConfig
  return functionCallingConfig !== undefined &&
    functionCallingConfig.mode === FunctionCallingConfigMode.NONE
    ? ('continue' as const)
    : ('generate' as const)
}

const makeClientFactory = Effect.fn('GeminiConformance.makeClientFactory')(function* (
  setup: AdapterConformanceSetup,
  provider: FakeProviderHarness,
) {
  const discoverySteps = yield* Ref.make(setup.discoverySteps)
  const generationSteps = yield* Ref.make(setup.generationSteps)
  const pendingCallIds = yield* Ref.make<ReadonlyArray<ToolCallId>>([])

  return GeminiClientFactory.Service.of({
    create: () =>
      Effect.succeed({
        listModels: (_params, signal) => {
          const step = takeStep(discoverySteps, 'Gemini conformance discovery script exhausted')
          return runProvider(
            provider,
            {
              kind: 'model-list',
              operation: 'discoverModels',
              modelId: Option.none(),
              resultCallIds: [],
              owningScope: Option.none(),
            },
            step,
            signal,
          ).then((current) => {
            if (current._tag === 'Failure') throw new Error('Impossible discovery failure value')
            return pager(current.models.map(providerModel))
          })
        },
        generateContent: (params, signal) => {
          const operation = operationFrom(params)
          const modelId = AdapterModelId.make(params.model)
          const resultCallIds =
            operation === 'continue' ? Ref.get(pendingCallIds).pipe(Effect.runSync) : []
          const step = takeStep(generationSteps, 'Gemini conformance generation script exhausted')
          return runProvider(
            provider,
            {
              kind: 'generation',
              operation,
              modelId: Option.some(modelId),
              resultCallIds,
              owningScope: Option.none(),
            },
            step,
            signal,
          ).then((current) => {
            if (current._tag === 'Failure') throw new Error('Impossible generation failure value')
            if (current._tag === 'ToolCalls') {
              Ref.set(
                pendingCallIds,
                current.calls.map((call) => call.callId),
              ).pipe(Effect.runSync)
            }
            return generationResponse(current)
          })
        },
      }),
  })
})

const adapterLayer = (clientFactory: GeminiClientFactory.Interface) => {
  const connectionLayer = GeminiConnection.layer.pipe(
    Layer.provide(
      GeminiConfiguration.layer({
        adapterId: ADAPTER_ID,
        endpoints: [{ apiKey: 'conformance-key', baseUrl: BASE_URL }],
        requestTimeoutMs: 60_000,
        maxConcurrency: 64,
        discoveryRetry: {
          maxAttempts: 1,
          initialDelayMs: 1_000,
          maxDelayMs: 1_000,
          backoffMultiplier: 2,
        },
      }),
    ),
    Layer.provide(Layer.succeed(GeminiClientFactory.Service, clientFactory)),
  )
  const continuationLayer = GeminiContinuationStore.layer.pipe(
    Layer.provide(GeminiContinuationTokenGenerator.layer),
    Layer.provideMerge(connectionLayer),
  )
  const capabilityLayer = Layer.merge(
    GeminiModelDiscovery.layerWithoutStartup,
    GeminiTextGeneration.layer,
  ).pipe(Layer.provideMerge(continuationLayer))
  return GeminiAdapter.layer.pipe(Layer.provideMerge(capabilityLayer))
}

const factory: AdapterConformanceFactory = {
  make: (setup) =>
    Effect.gen(function* () {
      const provider = yield* makeFakeProviderHarness()
      const clientFactory = yield* makeClientFactory(setup, provider)
      const services = yield* Layer.build(adapterLayer(clientFactory)).pipe(Effect.orDie)
      const adapter = Context.get(services, GeminiAdapter.Service)
      return { adapter, control: provider.control }
    }),
}

defineAdapterConformanceSuite('Gemini YokaiAdapter conformance', factory)
