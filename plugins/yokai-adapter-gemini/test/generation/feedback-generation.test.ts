import {
  FinishReason,
  FunctionCallingConfigMode,
  GenerateContentResponse,
  type Content,
  type GenerateContentParameters,
} from '@google/genai'
import { expect, it } from '@effect/vitest'
import {
  AdapterId,
  AdapterModelId,
  AdapterTimeoutError,
  ContinueRequest,
  GenerateRequest,
  type AdapterInvocationError,
  type InitialGenerationResult,
  type ToolCallBatch,
} from '@yokai/protocol'
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Ref,
  Schema,
  Scope,
} from 'effect'

import { GeminiConnection } from '../../src/connection/connection'
import { GeminiContinuationStore } from '../../src/continuation/store'
import { GeminiContinuationTokenGenerator } from '../../src/continuation/token-generator'
import { GeminiTextGeneration } from '../../src/generation/generation'

const ADAPTER_ID = AdapterId.make('gemini-feedback-generation-test')
const MODEL_ID = AdapterModelId.make('gemini-2.5-flash')

interface ObservedRequest {
  readonly operation: GeminiConnection.GenerationOperation
  readonly modelId: AdapterModelId
  readonly params: GenerateContentParameters
}

const request = Schema.decodeUnknownEffect(GenerateRequest)({
  modelId: MODEL_ID,
  systemInstruction: 'Return final XML only.',
  messages: [{ role: 'user', content: 'Use feedback if needed.' }],
  limits: { maxOutputTokens: 256 },
  feedbackTools: [
    {
      id: 'web.search',
      description: 'Search the web',
      inputSchema: {
        _tag: 'Object',
        properties: [
          {
            name: 'query',
            required: true,
            schema: { _tag: 'String' },
          },
        ],
      },
    },
    {
      id: 'history.search',
      description: 'Search history',
      inputSchema: {
        _tag: 'Object',
        properties: [
          {
            name: 'query',
            required: true,
            schema: { _tag: 'String' },
          },
        ],
      },
    },
  ],
})

const modelContent: Content = {
  role: 'model',
  parts: [
    { text: 'temporary text must not escape', thoughtSignature: 'text-signature' },
    {
      functionCall: {
        id: 'provider-call-web',
        name: 'web.search',
        args: { query: 'weather' },
      },
      thoughtSignature: 'web-signature',
    },
    {
      functionCall: {
        name: 'history.search',
        args: { query: 'yesterday' },
      },
      thoughtSignature: 'history-signature',
    },
  ],
}

const toolResponse = Object.assign(new GenerateContentResponse(), {
  candidates: [{ content: modelContent, finishReason: FinishReason.STOP }],
  usageMetadata: {
    promptTokenCount: 12,
    candidatesTokenCount: 5,
    totalTokenCount: 17,
  },
})

const finalResponse = Object.assign(new GenerateContentResponse(), {
  candidates: [
    {
      content: {
        role: 'model',
        parts: [{ text: '<yokai-response attr="&quot;">A &amp; B</yokai-response>' }],
      },
      finishReason: FinishReason.STOP,
    },
  ],
  usageMetadata: {
    promptTokenCount: 20,
    candidatesTokenCount: 7,
    totalTokenCount: 27,
  },
})

const tokenLayer = Layer.succeed(
  GeminiContinuationTokenGenerator.Service,
  GeminiContinuationTokenGenerator.Service.of({
    next: () => Effect.succeed('deterministic-feedback-token'),
  }),
)

const makeGenerationLayer = (connection: GeminiConnection.Interface) => {
  const connectionLayer = Layer.succeed(GeminiConnection.Service, connection)
  const continuationLayer = GeminiContinuationStore.layer.pipe(
    Layer.provide(tokenLayer),
    Layer.provideMerge(connectionLayer),
  )
  return GeminiTextGeneration.layer.pipe(Layer.provide(continuationLayer))
}

const scriptedConnection = Effect.fn('GeminiFeedbackGenerationTest.scriptedConnection')(function* (
  responses: ReadonlyArray<GenerateContentResponse>,
  observed: Ref.Ref<ReadonlyArray<ObservedRequest>>,
) {
  const remaining = yield* Ref.make(responses)
  return GeminiConnection.Service.of({
    adapterId: ADAPTER_ID,
    discoveryRetry: {
      maxAttempts: 3,
      initialDelayMs: 1_000,
      maxDelayMs: 10_000,
      backoffMultiplier: 2,
    },
    listModels: () => Effect.die('Unexpected model discovery request'),
    generateContent: Effect.fn('GeminiFeedbackGenerationTest.generateContent')(function* <A, R>(
      operation: GeminiConnection.GenerationOperation,
      modelId: AdapterModelId,
      params: GenerateContentParameters,
      accept: (response: GenerateContentResponse) => Effect.Effect<A, AdapterInvocationError, R>,
    ) {
      yield* Ref.update(observed, (current) => [...current, { operation, modelId, params }])
      const response = yield* Ref.modify(remaining, (current) => {
        const head = current[0]
        return head === undefined
          ? [Option.none<GenerateContentResponse>(), current]
          : [Option.some(head), current.slice(1)]
      })
      if (Option.isNone(response)) {
        return yield* Effect.die('Gemini feedback response script exhausted')
      }
      return yield* accept(response.value)
    }),
    close: () => Effect.succeed(true),
  })
})

const blockingConnection = (
  started: Deferred.Deferred<void>,
  cancelled: Deferred.Deferred<void>,
  blocked: Deferred.Deferred<void>,
  observed: Ref.Ref<ReadonlyArray<ObservedRequest>>,
) =>
  GeminiConnection.Service.of({
    adapterId: ADAPTER_ID,
    discoveryRetry: {
      maxAttempts: 3,
      initialDelayMs: 1_000,
      maxDelayMs: 10_000,
      backoffMultiplier: 2,
    },
    listModels: () => Effect.die('Unexpected model discovery request'),
    generateContent: Effect.fn('GeminiFeedbackGenerationTest.blockingGeneration')(function* <A, R>(
      operation: GeminiConnection.GenerationOperation,
      modelId: AdapterModelId,
      params: GenerateContentParameters,
      accept: (response: GenerateContentResponse) => Effect.Effect<A, AdapterInvocationError, R>,
    ) {
      yield* Ref.update(observed, (current) => [...current, { operation, modelId, params }])
      if (operation === 'generate') return yield* accept(toolResponse)
      return yield* Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(blocked)
        return yield* accept(finalResponse)
      }).pipe(Effect.ensuring(Deferred.succeed(cancelled, undefined).pipe(Effect.asVoid)))
    }),
    close: () => Effect.succeed(true),
  })

const requireToolBatch = (result: InitialGenerationResult): Effect.Effect<ToolCallBatch> =>
  result._tag === 'ToolCallBatch'
    ? Effect.succeed(result)
    : Effect.die('Expected a ToolCallBatch result')

const makeContinueRequest = Effect.fn('GeminiFeedbackGenerationTest.makeContinueRequest')(
  function* (batch: ToolCallBatch) {
    const first = batch.calls[0]
    const second = batch.calls[1]
    if (first === undefined || second === undefined) {
      return yield* Effect.die('Expected two Gemini feedback calls')
    }
    return yield* Schema.decodeUnknownEffect(ContinueRequest)({
      continuation: batch.continuation,
      results: [
        {
          _tag: 'Failure',
          callId: second.callId,
          reason: 'unavailable',
          message: 'history unavailable',
        },
        {
          _tag: 'Success',
          callId: first.callId,
          output: ['sunny', { temperature: 24 }],
        },
      ],
    })
  },
)

it.effect('performs one ordered continuation and preserves the complete Gemini history', () =>
  Effect.gen(function* () {
    const observed = yield* Ref.make<ReadonlyArray<ObservedRequest>>([])
    const connection = yield* scriptedConnection([toolResponse, finalResponse], observed)
    const generation = yield* GeminiTextGeneration.Service.pipe(
      Effect.provide(makeGenerationLayer(connection)),
    )
    const decodedRequest = yield* request
    const initial = yield* generation.generate(decodedRequest)
    const batch = yield* requireToolBatch(initial)
    expect(batch.calls).toEqual([
      {
        callId: 'provider-call-web',
        toolId: 'web.search',
        input: { query: 'weather' },
      },
      {
        callId: 'gemini-generated-call-1',
        toolId: 'history.search',
        input: { query: 'yesterday' },
      },
    ])
    expect(batch).not.toHaveProperty('text')
    expect(batch.usage).toEqual({
      _tag: 'Reported',
      inputTokens: 12,
      outputTokens: 5,
      totalTokens: 17,
    })

    const continuation = yield* makeContinueRequest(batch)
    const final = yield* generation.continue(continuation)
    expect(final).toEqual({
      _tag: 'Text',
      text: '<yokai-response attr="&quot;">A &amp; B</yokai-response>',
      finishReason: 'stop',
      usage: {
        _tag: 'Reported',
        inputTokens: 20,
        outputTokens: 7,
        totalTokens: 27,
      },
    })

    const requests = yield* Ref.get(observed)
    expect(requests).toHaveLength(2)
    const initialRequest = requests[0]
    const continuationRequest = requests[1]
    if (initialRequest === undefined || continuationRequest === undefined) {
      return yield* Effect.die('Expected two logical Gemini requests')
    }
    expect(initialRequest.operation).toBe('generate')
    expect(initialRequest.params.config).toMatchObject({
      automaticFunctionCalling: { disable: true },
      toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
    })
    expect(continuationRequest.operation).toBe('continue')
    expect(continuationRequest.modelId).toBe(MODEL_ID)
    expect(continuationRequest.params.config).toMatchObject({
      automaticFunctionCalling: { disable: true },
      toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } },
    })
    const contents = continuationRequest.params.contents
    if (!Array.isArray(contents)) {
      return yield* Effect.die('Expected explicit Gemini continuation contents')
    }
    expect(contents).toHaveLength(3)
    expect(contents[1]).toBe(modelContent)
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'provider-call-web',
            name: 'web.search',
            response: { ok: true, value: ['sunny', { temperature: 24 }] },
          },
        },
        {
          functionResponse: {
            name: 'history.search',
            response: {
              ok: false,
              reason: 'unavailable',
              message: 'history unavailable',
            },
          },
        },
      ],
    })

    const repeated = yield* generation.continue(continuation).pipe(Effect.flip)
    expect(repeated._tag).toBe('AdapterContinuationError')
    expect(yield* Ref.get(observed)).toHaveLength(2)
  }),
)

it.effect('consumes the handle when the result set is incomplete before a provider request', () =>
  Effect.gen(function* () {
    const observed = yield* Ref.make<ReadonlyArray<ObservedRequest>>([])
    const connection = yield* scriptedConnection([toolResponse], observed)
    const generation = yield* GeminiTextGeneration.Service.pipe(
      Effect.provide(makeGenerationLayer(connection)),
    )
    const initial = yield* generation.generate(yield* request)
    const batch = yield* requireToolBatch(initial)
    const first = batch.calls[0]
    if (first === undefined) return yield* Effect.die('Expected one Gemini feedback call')
    const continuation = yield* Schema.decodeUnknownEffect(ContinueRequest)({
      continuation: batch.continuation,
      results: [{ _tag: 'Success', callId: first.callId, output: 'partial' }],
    })

    const mismatch = yield* generation.continue(continuation).pipe(Effect.flip)
    expect(mismatch._tag).toBe('AdapterProtocolViolationError')
    if (mismatch._tag === 'AdapterProtocolViolationError') {
      expect(mismatch.reason).toBe('result-set-mismatch')
    }
    const repeated = yield* generation.continue(continuation).pipe(Effect.flip)
    expect(repeated._tag).toBe('AdapterContinuationError')
    expect(yield* Ref.get(observed)).toHaveLength(1)
  }),
)

it.effect('interrupts an active continuation when its owning turn scope closes', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const cancelled = yield* Deferred.make<void>()
    const blocked = yield* Deferred.make<void>()
    const observed = yield* Ref.make<ReadonlyArray<ObservedRequest>>([])
    const connection = blockingConnection(started, cancelled, blocked, observed)
    const generation = yield* GeminiTextGeneration.Service.pipe(
      Effect.provide(makeGenerationLayer(connection)),
    )
    const turnScope = yield* Scope.make()
    const initial = yield* generation
      .generate(yield* request)
      .pipe(Effect.provideService(Scope.Scope, turnScope))
    const batch = yield* requireToolBatch(initial)
    const continuation = yield* makeContinueRequest(batch)
    const fiber = yield* generation.continue(continuation).pipe(Effect.forkChild)
    yield* Deferred.await(started)

    yield* Scope.close(turnScope, Exit.void)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    yield* Deferred.await(cancelled)
    const repeated = yield* generation.continue(continuation).pipe(Effect.flip)
    expect(repeated._tag).toBe('AdapterContinuationError')
  }),
)

it.effect('propagates caller cancellation and consumes the claimed handle', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const cancelled = yield* Deferred.make<void>()
    const blocked = yield* Deferred.make<void>()
    const observed = yield* Ref.make<ReadonlyArray<ObservedRequest>>([])
    const connection = blockingConnection(started, cancelled, blocked, observed)
    const generation = yield* GeminiTextGeneration.Service.pipe(
      Effect.provide(makeGenerationLayer(connection)),
    )
    const initial = yield* generation.generate(yield* request)
    const batch = yield* requireToolBatch(initial)
    const continuation = yield* makeContinueRequest(batch)
    const fiber = yield* generation.continue(continuation).pipe(Effect.forkChild)
    yield* Deferred.await(started)

    yield* Fiber.interrupt(fiber)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    yield* Deferred.await(cancelled)
    const repeated = yield* generation.continue(continuation).pipe(Effect.flip)
    expect(repeated._tag).toBe('AdapterContinuationError')
    expect(yield* Ref.get(observed)).toHaveLength(2)
  }),
)

it.effect('consumes the handle after a typed continuation timeout', () =>
  Effect.gen(function* () {
    const observed = yield* Ref.make<ReadonlyArray<ObservedRequest>>([])
    const connection = GeminiConnection.Service.of({
      adapterId: ADAPTER_ID,
      discoveryRetry: {
        maxAttempts: 3,
        initialDelayMs: 1_000,
        maxDelayMs: 10_000,
        backoffMultiplier: 2,
      },
      listModels: () => Effect.die('Unexpected model discovery request'),
      generateContent: Effect.fn('GeminiFeedbackGenerationTest.timedOutGeneration')(function* <
        A,
        R,
      >(
        operation: GeminiConnection.GenerationOperation,
        modelId: AdapterModelId,
        params: GenerateContentParameters,
        accept: (response: GenerateContentResponse) => Effect.Effect<A, AdapterInvocationError, R>,
      ) {
        yield* Ref.update(observed, (current) => [...current, { operation, modelId, params }])
        if (operation === 'generate') return yield* accept(toolResponse)
        return yield* Effect.fail(
          new AdapterTimeoutError({
            adapterId: ADAPTER_ID,
            modelId,
            operation: 'continue',
            message: 'Gemini feedback continuation timed out',
          }),
        )
      }),
      close: () => Effect.succeed(true),
    })
    const generation = yield* GeminiTextGeneration.Service.pipe(
      Effect.provide(makeGenerationLayer(connection)),
    )
    const initial = yield* generation.generate(yield* request)
    const batch = yield* requireToolBatch(initial)
    const continuation = yield* makeContinueRequest(batch)

    const timeout = yield* generation.continue(continuation).pipe(Effect.flip)
    expect(timeout._tag).toBe('AdapterTimeoutError')
    const repeated = yield* generation.continue(continuation).pipe(Effect.flip)
    expect(repeated._tag).toBe('AdapterContinuationError')
    expect(yield* Ref.get(observed)).toHaveLength(2)
  }),
)

it.effect('invalidates pending handles when the adapter Layer closes', () =>
  Effect.gen(function* () {
    const observed = yield* Ref.make<ReadonlyArray<ObservedRequest>>([])
    const connection = yield* scriptedConnection([toolResponse], observed)
    const runtime = ManagedRuntime.make(makeGenerationLayer(connection))
    const generation = runtime.runSync(GeminiTextGeneration.Service)
    const turnScope = yield* Scope.make()
    const initial = yield* generation
      .generate(yield* request)
      .pipe(Effect.provideService(Scope.Scope, turnScope))
    const batch = yield* requireToolBatch(initial)
    const continuation = yield* makeContinueRequest(batch)

    yield* runtime.disposeEffect
    const failure = yield* generation.continue(continuation).pipe(Effect.flip)
    expect(failure._tag).toBe('AdapterContinuationError')
    expect(yield* Ref.get(observed)).toHaveLength(1)
    yield* Scope.close(turnScope, Exit.void)
  }),
)
