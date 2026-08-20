import { describe, expect, it } from '@effect/vitest'
import { Cause, Effect, Exit, Fiber, Result, Schema, Scope } from 'effect'

import {
  AdapterDescriptor,
  AdapterModelSnapshot,
  type AdapterInvocationError,
  makeAdapterContinuation,
  negotiateAdapterProtocol,
} from '@yokai/protocol'

import {
  type AdapterConformanceControl,
  type AdapterConformanceErrorCategory,
  type AdapterConformanceFactory,
  adapterModelSnapshotContentEqual,
} from '../conformance/index'
import {
  decodeConformanceSetup,
  makeFeedbackRequest,
  makeForeignContinueRequest,
  makeMismatchedResultContinueRequest,
  makeReversedResultContinueRequest,
  makeSingleResultContinueRequest,
  makeTextRequest,
} from './fixtures'
import {
  makeTurnScope,
  requestStarts,
  requireFailureCause,
  requireToolCallBatch,
  takeStartedRequestId,
} from './helpers'

const ERROR_CATEGORIES = [
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
] as const

const expectedErrorTag = (
  category: AdapterConformanceErrorCategory,
): AdapterInvocationError['_tag'] => {
  switch (category) {
    case 'configuration':
      return 'AdapterConfigurationError'
    case 'authentication':
      return 'AdapterAuthenticationError'
    case 'rate-limit':
      return 'AdapterRateLimitError'
    case 'timeout':
      return 'AdapterTimeoutError'
    case 'provider-cancelled':
      return 'AdapterCancelledError'
    case 'transport':
      return 'AdapterTransportError'
    case 'provider-response':
      return 'AdapterProviderResponseError'
    case 'protocol-decode':
      return 'AdapterProtocolDecodeError'
    case 'internal':
      return 'AdapterInternalError'
    case 'unsupported':
      return 'AdapterUnsupportedError'
  }
}

const assertInvalidContinuation = (error: AdapterInvocationError, adapterId: string) => {
  expect(error._tag).toBe('AdapterContinuationError')
  if (error._tag !== 'AdapterContinuationError') return
  expect(error.adapterId).toBe(adapterId)
  expect(error.operation).toBe('continue')
  expect(error.reason).toBe('invalid')
  expect(error.message).toBe('Invalid adapter continuation')
}

const countProviderRequests = (
  control: AdapterConformanceControl,
  operation: 'discoverModels' | 'generate' | 'continue',
) => control.events().pipe(Effect.map((events) => requestStarts(events, operation).length))

/**
 * Explicitly registers the reusable adapter contract tests. Importing this
 * module alone never registers a Vitest suite.
 */
export const defineAdapterConformanceSuite = (
  name: string,
  factory: AdapterConformanceFactory,
): void => {
  describe(name, () => {
    it.effect('exposes a valid descriptor and negotiates the current protocol', () =>
      Effect.gen(function* () {
        const setup = yield* decodeConformanceSetup({
          discoverySteps: [],
          generationSteps: [],
        })
        const subject = yield* factory.make(setup)

        yield* Schema.encodeEffect(AdapterDescriptor)(subject.adapter.descriptor)
        expect(yield* negotiateAdapterProtocol(subject.adapter)).toBe(subject.adapter)
      }),
    )

    it.effect(
      'discovers unique, stably sorted models with per-model freshness and exact metadata',
      () =>
        Effect.gen(function* () {
          const setup = yield* decodeConformanceSetup({
            discoverySteps: [
              {
                _tag: 'Success',
                discoveredAt: '2026-08-20T04:00:00.000Z',
                blocked: false,
                models: [
                  {
                    id: 'z-model',
                    displayName: 'Zeta',
                    availability: 'available',
                    discoveryFreshness: 'fresh',
                    inputTokenLimit: 1_000_000,
                    outputTokenLimit: 8_192,
                    supportedGenerationMethods: [
                      'streamGenerateContent',
                      'generateContent',
                      'generateContent',
                    ],
                  },
                  {
                    id: 'a-model',
                    displayName: 'Alpha',
                    availability: 'available',
                    discoveryFreshness: 'stale',
                  },
                  {
                    id: 'a-model',
                    displayName: 'Alpha',
                    availability: 'available',
                    discoveryFreshness: 'stale',
                  },
                  {
                    id: 'B-model',
                    displayName: 'Uppercase B',
                    availability: 'unavailable',
                    discoveryFreshness: 'fresh',
                  },
                ],
              },
            ],
            generationSteps: [],
          })
          const subject = yield* factory.make(setup)
          const snapshot = yield* subject.adapter.discoverModels()

          yield* Schema.encodeEffect(AdapterModelSnapshot)(snapshot)
          expect(snapshot.models.map((model) => model.id)).toEqual([
            'B-model',
            'a-model',
            'z-model',
          ])

          const stale = snapshot.models.find((model) => model.id === 'a-model')
          if (stale === undefined) {
            return yield* Effect.die('Expected the stale discovery model')
          }
          expect(stale.discoveryFreshness).toBe('stale')
          expect(stale.inputTokenLimit).toBeUndefined()
          expect(stale.outputTokenLimit).toBeUndefined()
          expect(stale.supportedGenerationMethods).toBeUndefined()
          expect(Object.hasOwn(stale, 'capabilities')).toBe(false)
          expect(Object.hasOwn(stale, 'feedbackTools')).toBe(false)
          expect(Object.hasOwn(stale, 'supportsFunctionCalls')).toBe(false)

          const fresh = snapshot.models.find((model) => model.id === 'z-model')
          if (fresh === undefined) {
            return yield* Effect.die('Expected the fresh discovery model')
          }
          expect(fresh.discoveryFreshness).toBe('fresh')
          expect(fresh.inputTokenLimit).toBe(1_000_000)
          expect(fresh.outputTokenLimit).toBe(8_192)
          expect(fresh.supportedGenerationMethods).toEqual([
            'generateContent',
            'streamGenerateContent',
          ])

          const events = yield* subject.control.events()
          const starts = requestStarts(events)
          expect(starts).toHaveLength(1)
          expect(starts[0]).toMatchObject({
            kind: 'model-list',
            operation: 'discoverModels',
          })
          expect(starts.filter((event) => event.kind === 'capability-probe')).toHaveLength(0)
          expect(yield* subject.control.activeRequests()).toBe(0)
        }),
    )

    it.effect(
      'compares snapshot content without discoveredAt and never mutates an earlier snapshot',
      () =>
        Effect.gen(function* () {
          const originalModel = {
            id: 'models/text',
            displayName: 'Text',
            availability: 'available',
            discoveryFreshness: 'fresh',
          } as const
          const setup = yield* decodeConformanceSetup({
            discoverySteps: [
              {
                _tag: 'Success',
                discoveredAt: '2026-08-20T04:00:00.000Z',
                blocked: false,
                models: [originalModel],
              },
              {
                _tag: 'Success',
                discoveredAt: '2026-08-20T05:00:00.000Z',
                blocked: false,
                models: [originalModel],
              },
              {
                _tag: 'Success',
                discoveredAt: '2026-08-20T06:00:00.000Z',
                blocked: false,
                models: [
                  {
                    ...originalModel,
                    displayName: 'Changed Text',
                    discoveryFreshness: 'stale',
                  },
                ],
              },
            ],
            generationSteps: [],
          })
          const subject = yield* factory.make(setup)

          const first = yield* subject.adapter.discoverModels()
          const encodedBefore = yield* Schema.encodeEffect(AdapterModelSnapshot)(first)
          const sameContent = yield* subject.adapter.discoverModels()
          expect(adapterModelSnapshotContentEqual(first, sameContent)).toBe(true)

          const changed = yield* subject.adapter.discoverModels()
          expect(adapterModelSnapshotContentEqual(first, changed)).toBe(false)
          expect(yield* Schema.encodeEffect(AdapterModelSnapshot)(first)).toEqual(encodedBefore)
          expect(yield* countProviderRequests(subject.control, 'discoverModels')).toBe(3)
        }),
    )

    it.effect('returns a single-pass text result from exactly one provider request', () =>
      Effect.gen(function* () {
        const setup = yield* decodeConformanceSetup({
          discoverySteps: [],
          generationSteps: [
            {
              _tag: 'Text',
              blocked: false,
              result: {
                _tag: 'Text',
                text: '<yokai-response>single pass</yokai-response>',
                finishReason: 'stop',
                usage: {
                  _tag: 'Reported',
                  inputTokens: 12,
                  outputTokens: 7,
                  totalTokens: 19,
                },
              },
            },
          ],
        })
        const subject = yield* factory.make(setup)
        const request = yield* makeTextRequest()
        const turnScope = yield* makeTurnScope
        const result = yield* subject.adapter
          .generate(request)
          .pipe(Effect.provideService(Scope.Scope, turnScope))

        expect(result).toEqual({
          _tag: 'Text',
          text: '<yokai-response>single pass</yokai-response>',
          finishReason: 'stop',
          usage: {
            _tag: 'Reported',
            inputTokens: 12,
            outputTokens: 7,
            totalTokens: 19,
          },
        })
        expect(yield* countProviderRequests(subject.control, 'generate')).toBe(1)
        const events = yield* subject.control.events()
        expect(
          requestStarts(events).filter((event) => event.kind === 'capability-probe'),
        ).toHaveLength(0)
        expect(yield* subject.control.activeRequests()).toBe(0)
      }),
    )

    it.effect(
      'rejects feedback tools before the provider when the transport contract is disabled',
      () =>
        Effect.gen(function* () {
          const setup = yield* decodeConformanceSetup({
            discoverySteps: [],
            generationSteps: [],
          })
          const subject = yield* factory.make(setup)
          if (subject.adapter.descriptor.capabilities.feedbackTools) return

          const request = yield* makeFeedbackRequest()
          const turnScope = yield* makeTurnScope
          const result = yield* Effect.result(
            subject.adapter.generate(request).pipe(Effect.provideService(Scope.Scope, turnScope)),
          )
          if (Result.isSuccess(result)) {
            return yield* Effect.die('Expected feedback tools to be unsupported')
          }
          expect(result.failure._tag).toBe('AdapterUnsupportedError')
          if (result.failure._tag === 'AdapterUnsupportedError') {
            expect(result.failure.feature).toBe('feedback-tools')
          }
          expect(yield* countProviderRequests(subject.control, 'generate')).toBe(0)
        }),
    )

    it.effect(
      'performs one bounded continuation, restores result order, and keeps incremental usage',
      () =>
        Effect.gen(function* () {
          const setup = yield* decodeConformanceSetup({
            discoverySteps: [],
            generationSteps: [
              {
                _tag: 'ToolCalls',
                blocked: false,
                calls: [
                  {
                    callId: 'call-a',
                    toolId: 'history.search',
                    input: { query: 'first' },
                  },
                  {
                    callId: 'call-b',
                    toolId: 'web.search',
                    input: { query: 'second' },
                  },
                ],
                usage: { _tag: 'Reported', totalTokens: 20 },
              },
              {
                _tag: 'Text',
                blocked: false,
                result: {
                  _tag: 'Text',
                  text: '<yokai-response>bounded result</yokai-response>',
                  finishReason: 'stop',
                  usage: { _tag: 'Reported', totalTokens: 9 },
                },
              },
            ],
          })
          const subject = yield* factory.make(setup)
          if (!subject.adapter.descriptor.capabilities.feedbackTools) return

          const request = yield* makeFeedbackRequest()
          const turnScope = yield* makeTurnScope
          const initial = yield* subject.adapter
            .generate(request)
            .pipe(Effect.provideService(Scope.Scope, turnScope))
          const toolBatch = yield* requireToolCallBatch(initial)
          expect(toolBatch.calls.map((call) => call.callId)).toEqual(['call-a', 'call-b'])
          expect(toolBatch.usage).toEqual({
            _tag: 'Reported',
            totalTokens: 20,
          })

          const continueRequest = yield* makeReversedResultContinueRequest(toolBatch.continuation)
          const final = yield* subject.adapter.continue(continueRequest)
          expect(final.text).toBe('<yokai-response>bounded result</yokai-response>')
          expect(final.usage).toEqual({ _tag: 'Reported', totalTokens: 9 })

          const events = yield* subject.control.events()
          expect(requestStarts(events, 'generate')).toHaveLength(1)
          const continuationStarts = requestStarts(events, 'continue')
          expect(continuationStarts).toHaveLength(1)
          expect(continuationStarts[0]).toMatchObject({
            kind: 'generation',
            modelId: 'models/text',
            resultCallIds: ['call-a', 'call-b'],
          })
          expect(yield* subject.control.activeRequests()).toBe(0)
        }),
    )

    it.effect('rejects an unowned continuation before a provider request', () =>
      Effect.gen(function* () {
        const setup = yield* decodeConformanceSetup({
          discoverySteps: [],
          generationSteps: [],
        })
        const subject = yield* factory.make(setup)
        const continuation = yield* makeAdapterContinuation('adapter-conformance-foreign-handle')
        const request = yield* makeForeignContinueRequest(continuation)
        const result = yield* Effect.result(subject.adapter.continue(request))

        if (Result.isSuccess(result)) {
          return yield* Effect.die('Expected an invalid continuation failure')
        }
        assertInvalidContinuation(result.failure, subject.adapter.descriptor.id)
        expect(yield* countProviderRequests(subject.control, 'continue')).toBe(0)
      }),
    )

    it.effect('binds a continuation to its creating adapter instance', () =>
      Effect.gen(function* () {
        const sourceSetup = yield* decodeConformanceSetup({
          discoverySteps: [],
          generationSteps: [
            {
              _tag: 'ToolCalls',
              blocked: false,
              calls: [
                {
                  callId: 'call-a',
                  toolId: 'history.search',
                  input: { query: 'adapter ownership' },
                },
              ],
              usage: { _tag: 'Unavailable' },
            },
            {
              _tag: 'Text',
              blocked: false,
              result: {
                _tag: 'Text',
                text: 'owned continuation',
                finishReason: 'stop',
                usage: { _tag: 'Unavailable' },
              },
            },
          ],
        })
        const foreignSetup = yield* decodeConformanceSetup({
          discoverySteps: [],
          generationSteps: [],
        })
        const source = yield* factory.make(sourceSetup)
        const foreign = yield* factory.make(foreignSetup)
        if (!source.adapter.descriptor.capabilities.feedbackTools) return

        const generateRequest = yield* makeFeedbackRequest()
        const turnScope = yield* makeTurnScope
        const initial = yield* source.adapter
          .generate(generateRequest)
          .pipe(Effect.provideService(Scope.Scope, turnScope))
        const toolBatch = yield* requireToolCallBatch(initial)
        const continueRequest = yield* makeSingleResultContinueRequest(toolBatch.continuation)

        const foreignResult = yield* Effect.result(foreign.adapter.continue(continueRequest))
        if (Result.isSuccess(foreignResult)) {
          return yield* Effect.die('Expected cross-adapter consumption to fail')
        }
        assertInvalidContinuation(foreignResult.failure, foreign.adapter.descriptor.id)
        expect(yield* countProviderRequests(foreign.control, 'continue')).toBe(0)

        const ownedResult = yield* source.adapter.continue(continueRequest)
        expect(ownedResult.text).toBe('owned continuation')
        expect(yield* countProviderRequests(source.control, 'continue')).toBe(1)
      }),
    )

    it.effect('invalidates a continuation when its owning turn scope closes', () =>
      Effect.gen(function* () {
        const setup = yield* decodeConformanceSetup({
          discoverySteps: [],
          generationSteps: [
            {
              _tag: 'ToolCalls',
              blocked: false,
              calls: [
                {
                  callId: 'call-a',
                  toolId: 'history.search',
                  input: { query: 'scope' },
                },
              ],
              usage: { _tag: 'Unavailable' },
            },
          ],
        })
        const subject = yield* factory.make(setup)
        if (!subject.adapter.descriptor.capabilities.feedbackTools) return

        const generateRequest = yield* makeFeedbackRequest()
        const turnScope = yield* makeTurnScope
        const initial = yield* subject.adapter
          .generate(generateRequest)
          .pipe(Effect.provideService(Scope.Scope, turnScope))
        const toolBatch = yield* requireToolCallBatch(initial)
        const continueRequest = yield* makeSingleResultContinueRequest(toolBatch.continuation)

        yield* Scope.close(turnScope, Exit.void)
        const result = yield* Effect.result(subject.adapter.continue(continueRequest))
        if (Result.isSuccess(result)) {
          return yield* Effect.die('Expected the closed turn continuation to fail')
        }
        assertInvalidContinuation(result.failure, subject.adapter.descriptor.id)
        expect(yield* countProviderRequests(subject.control, 'continue')).toBe(0)
      }),
    )

    it.effect('cancels an active continuation when its owning turn scope closes', () =>
      Effect.gen(function* () {
        const setup = yield* decodeConformanceSetup({
          discoverySteps: [],
          generationSteps: [
            {
              _tag: 'ToolCalls',
              blocked: false,
              calls: [
                {
                  callId: 'call-a',
                  toolId: 'history.search',
                  input: { query: 'active scope close' },
                },
              ],
              usage: { _tag: 'Unavailable' },
            },
            {
              _tag: 'Text',
              blocked: true,
              result: {
                _tag: 'Text',
                text: 'must not complete',
                finishReason: 'stop',
                usage: { _tag: 'Unavailable' },
              },
            },
          ],
        })
        const subject = yield* factory.make(setup)
        if (!subject.adapter.descriptor.capabilities.feedbackTools) return

        const generateRequest = yield* makeFeedbackRequest()
        const turnScope = yield* makeTurnScope
        const initial = yield* subject.adapter
          .generate(generateRequest)
          .pipe(Effect.provideService(Scope.Scope, turnScope))
        const toolBatch = yield* requireToolCallBatch(initial)
        const continueRequest = yield* makeSingleResultContinueRequest(toolBatch.continuation)
        const fiber = yield* subject.adapter.continue(continueRequest).pipe(Effect.forkChild)
        const requestId = yield* takeStartedRequestId(subject.control, 'continue')

        yield* Scope.close(turnScope, Exit.void)
        const exit = yield* Fiber.await(fiber)
        const cause = yield* requireFailureCause(exit)
        expect(Cause.hasInterruptsOnly(cause)).toBe(true)
        const events = yield* subject.control.events()
        expect(
          events.some(
            (event) => event._tag === 'RequestCancelled' && event.requestId === requestId,
          ),
        ).toBe(true)
        expect(yield* countProviderRequests(subject.control, 'continue')).toBe(1)
        expect(yield* subject.control.activeRequests()).toBe(0)

        const repeated = yield* Effect.result(subject.adapter.continue(continueRequest))
        if (Result.isSuccess(repeated)) {
          return yield* Effect.die('Expected the closed-scope continuation to be consumed')
        }
        assertInvalidContinuation(repeated.failure, subject.adapter.descriptor.id)
      }),
    )

    it.effect('consumes a continuation exactly once', () =>
      Effect.gen(function* () {
        const setup = yield* decodeConformanceSetup({
          discoverySteps: [],
          generationSteps: [
            {
              _tag: 'ToolCalls',
              blocked: false,
              calls: [
                {
                  callId: 'call-a',
                  toolId: 'history.search',
                  input: { query: 'single consume' },
                },
              ],
              usage: { _tag: 'Unavailable' },
            },
            {
              _tag: 'Text',
              blocked: false,
              result: {
                _tag: 'Text',
                text: 'consumed once',
                finishReason: 'stop',
                usage: { _tag: 'Unavailable' },
              },
            },
          ],
        })
        const subject = yield* factory.make(setup)
        if (!subject.adapter.descriptor.capabilities.feedbackTools) return

        const generateRequest = yield* makeFeedbackRequest()
        const turnScope = yield* makeTurnScope
        const initial = yield* subject.adapter
          .generate(generateRequest)
          .pipe(Effect.provideService(Scope.Scope, turnScope))
        const toolBatch = yield* requireToolCallBatch(initial)
        const continueRequest = yield* makeSingleResultContinueRequest(toolBatch.continuation)

        expect((yield* subject.adapter.continue(continueRequest)).text).toBe('consumed once')
        const repeated = yield* Effect.result(subject.adapter.continue(continueRequest))
        if (Result.isSuccess(repeated)) {
          return yield* Effect.die('Expected repeated consumption to fail')
        }
        assertInvalidContinuation(repeated.failure, subject.adapter.descriptor.id)
        expect(yield* countProviderRequests(subject.control, 'continue')).toBe(1)
      }),
    )

    it.effect('claims a continuation atomically under concurrent consumption', () =>
      Effect.gen(function* () {
        const setup = yield* decodeConformanceSetup({
          discoverySteps: [],
          generationSteps: [
            {
              _tag: 'ToolCalls',
              blocked: false,
              calls: [
                {
                  callId: 'call-a',
                  toolId: 'history.search',
                  input: { query: 'concurrent' },
                },
              ],
              usage: { _tag: 'Unavailable' },
            },
            {
              _tag: 'Text',
              blocked: true,
              result: {
                _tag: 'Text',
                text: 'one winner',
                finishReason: 'stop',
                usage: { _tag: 'Unavailable' },
              },
            },
          ],
        })
        const subject = yield* factory.make(setup)
        if (!subject.adapter.descriptor.capabilities.feedbackTools) return

        const generateRequest = yield* makeFeedbackRequest()
        const turnScope = yield* makeTurnScope
        const initial = yield* subject.adapter
          .generate(generateRequest)
          .pipe(Effect.provideService(Scope.Scope, turnScope))
        const toolBatch = yield* requireToolCallBatch(initial)
        const continueRequest = yield* makeSingleResultContinueRequest(toolBatch.continuation)

        const firstFiber = yield* Effect.result(subject.adapter.continue(continueRequest)).pipe(
          Effect.forkChild,
        )
        const secondFiber = yield* Effect.result(subject.adapter.continue(continueRequest)).pipe(
          Effect.forkChild,
        )

        const requestId = yield* takeStartedRequestId(subject.control, 'continue')
        expect(yield* subject.control.release(requestId)).toBe(true)
        const first = yield* Fiber.join(firstFiber)
        const second = yield* Fiber.join(secondFiber)
        const results = [first, second]

        expect(results.filter(Result.isSuccess)).toHaveLength(1)
        const failure = results.find(Result.isFailure)
        if (failure === undefined) {
          return yield* Effect.die('Expected one concurrent continuation failure')
        }
        assertInvalidContinuation(failure.failure, subject.adapter.descriptor.id)
        expect(yield* countProviderRequests(subject.control, 'continue')).toBe(1)
        expect(yield* subject.control.activeRequests()).toBe(0)
      }),
    )

    it.effect('rejects a mismatched result set before the provider boundary', () =>
      Effect.gen(function* () {
        const setup = yield* decodeConformanceSetup({
          discoverySteps: [],
          generationSteps: [
            {
              _tag: 'ToolCalls',
              blocked: false,
              calls: [
                {
                  callId: 'call-a',
                  toolId: 'history.search',
                  input: { query: 'one' },
                },
                {
                  callId: 'call-b',
                  toolId: 'web.search',
                  input: { query: 'two' },
                },
              ],
              usage: { _tag: 'Unavailable' },
            },
          ],
        })
        const subject = yield* factory.make(setup)
        if (!subject.adapter.descriptor.capabilities.feedbackTools) return

        const generateRequest = yield* makeFeedbackRequest()
        const turnScope = yield* makeTurnScope
        const initial = yield* subject.adapter
          .generate(generateRequest)
          .pipe(Effect.provideService(Scope.Scope, turnScope))
        const toolBatch = yield* requireToolCallBatch(initial)
        const continueRequest = yield* makeMismatchedResultContinueRequest(toolBatch.continuation)
        const result = yield* Effect.result(subject.adapter.continue(continueRequest))

        if (Result.isSuccess(result)) {
          return yield* Effect.die('Expected a result-set mismatch')
        }
        expect(result.failure._tag).toBe('AdapterProtocolViolationError')
        if (result.failure._tag === 'AdapterProtocolViolationError') {
          expect(result.failure.reason).toBe('result-set-mismatch')
        }
        expect(yield* countProviderRequests(subject.control, 'continue')).toBe(0)

        const repeated = yield* Effect.result(subject.adapter.continue(continueRequest))
        if (Result.isSuccess(repeated)) {
          return yield* Effect.die('Expected the mismatched continuation to be consumed')
        }
        assertInvalidContinuation(repeated.failure, subject.adapter.descriptor.id)
      }),
    )

    it.effect('propagates caller interruption to an active generation request', () =>
      Effect.gen(function* () {
        const setup = yield* decodeConformanceSetup({
          discoverySteps: [],
          generationSteps: [
            {
              _tag: 'Text',
              blocked: true,
              result: {
                _tag: 'Text',
                text: 'must not complete',
                finishReason: 'stop',
                usage: { _tag: 'Unavailable' },
              },
            },
          ],
        })
        const subject = yield* factory.make(setup)
        const request = yield* makeTextRequest()
        const turnScope = yield* makeTurnScope
        const fiber = yield* subject.adapter
          .generate(request)
          .pipe(Effect.provideService(Scope.Scope, turnScope), Effect.forkChild)

        const requestId = yield* takeStartedRequestId(subject.control, 'generate')
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        const cause = yield* requireFailureCause(exit)
        expect(Cause.hasInterruptsOnly(cause)).toBe(true)

        const events = yield* subject.control.events()
        expect(
          events.some(
            (event) => event._tag === 'RequestCancelled' && event.requestId === requestId,
          ),
        ).toBe(true)
        expect(yield* countProviderRequests(subject.control, 'generate')).toBe(1)
        expect(yield* subject.control.activeRequests()).toBe(0)
      }),
    )

    it.effect('propagates caller interruption to active model discovery', () =>
      Effect.gen(function* () {
        const setup = yield* decodeConformanceSetup({
          discoverySteps: [
            {
              _tag: 'Success',
              discoveredAt: '2026-08-20T04:00:00.000Z',
              blocked: true,
              models: [],
            },
          ],
          generationSteps: [],
        })
        const subject = yield* factory.make(setup)
        const fiber = yield* subject.adapter.discoverModels().pipe(Effect.forkChild)

        const requestId = yield* takeStartedRequestId(subject.control, 'discoverModels')
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        const cause = yield* requireFailureCause(exit)
        expect(Cause.hasInterruptsOnly(cause)).toBe(true)

        const events = yield* subject.control.events()
        expect(
          events.some(
            (event) => event._tag === 'RequestCancelled' && event.requestId === requestId,
          ),
        ).toBe(true)
        expect(yield* countProviderRequests(subject.control, 'discoverModels')).toBe(1)
        expect(yield* subject.control.activeRequests()).toBe(0)
      }),
    )

    it.effect('propagates continuation interruption and consumes the claimed handle', () =>
      Effect.gen(function* () {
        const setup = yield* decodeConformanceSetup({
          discoverySteps: [],
          generationSteps: [
            {
              _tag: 'ToolCalls',
              blocked: false,
              calls: [
                {
                  callId: 'call-a',
                  toolId: 'history.search',
                  input: { query: 'cancel' },
                },
              ],
              usage: { _tag: 'Unavailable' },
            },
            {
              _tag: 'Text',
              blocked: true,
              result: {
                _tag: 'Text',
                text: 'must not complete',
                finishReason: 'stop',
                usage: { _tag: 'Unavailable' },
              },
            },
          ],
        })
        const subject = yield* factory.make(setup)
        if (!subject.adapter.descriptor.capabilities.feedbackTools) return

        const generateRequest = yield* makeFeedbackRequest()
        const turnScope = yield* makeTurnScope
        const initial = yield* subject.adapter
          .generate(generateRequest)
          .pipe(Effect.provideService(Scope.Scope, turnScope))
        const toolBatch = yield* requireToolCallBatch(initial)
        const continueRequest = yield* makeSingleResultContinueRequest(toolBatch.continuation)
        const fiber = yield* subject.adapter.continue(continueRequest).pipe(Effect.forkChild)

        const requestId = yield* takeStartedRequestId(subject.control, 'continue')
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        const cause = yield* requireFailureCause(exit)
        expect(Cause.hasInterruptsOnly(cause)).toBe(true)

        const repeated = yield* Effect.result(subject.adapter.continue(continueRequest))
        if (Result.isSuccess(repeated)) {
          return yield* Effect.die('Expected the interrupted continuation to remain consumed')
        }
        assertInvalidContinuation(repeated.failure, subject.adapter.descriptor.id)

        const events = yield* subject.control.events()
        expect(
          events.some(
            (event) => event._tag === 'RequestCancelled' && event.requestId === requestId,
          ),
        ).toBe(true)
        expect(yield* countProviderRequests(subject.control, 'continue')).toBe(1)
        expect(yield* subject.control.activeRequests()).toBe(0)
      }),
    )

    it.effect('rejects a second provider tool call without a third request', () =>
      Effect.gen(function* () {
        const setup = yield* decodeConformanceSetup({
          discoverySteps: [],
          generationSteps: [
            {
              _tag: 'ToolCalls',
              blocked: false,
              calls: [
                {
                  callId: 'call-a',
                  toolId: 'history.search',
                  input: { query: 'first tool round' },
                },
              ],
              usage: { _tag: 'Unavailable' },
            },
            {
              _tag: 'ToolCalls',
              blocked: false,
              calls: [
                {
                  callId: 'call-b',
                  toolId: 'history.search',
                  input: { query: 'forbidden second round' },
                },
              ],
              usage: { _tag: 'Unavailable' },
            },
          ],
        })
        const subject = yield* factory.make(setup)
        if (!subject.adapter.descriptor.capabilities.feedbackTools) return

        const generateRequest = yield* makeFeedbackRequest()
        const turnScope = yield* makeTurnScope
        const initial = yield* subject.adapter
          .generate(generateRequest)
          .pipe(Effect.provideService(Scope.Scope, turnScope))
        const toolBatch = yield* requireToolCallBatch(initial)
        const continueRequest = yield* makeSingleResultContinueRequest(toolBatch.continuation)
        const result = yield* Effect.result(subject.adapter.continue(continueRequest))

        if (Result.isSuccess(result)) {
          return yield* Effect.die('Expected a forbidden second tool call error')
        }
        expect(result.failure._tag).toBe('AdapterProtocolViolationError')
        if (result.failure._tag === 'AdapterProtocolViolationError') {
          expect(result.failure.reason).toBe('unexpected-tool-call')
        }
        expect(yield* countProviderRequests(subject.control, 'generate')).toBe(1)
        expect(yield* countProviderRequests(subject.control, 'continue')).toBe(1)

        const repeated = yield* Effect.result(subject.adapter.continue(continueRequest))
        if (Result.isSuccess(repeated)) {
          return yield* Effect.die('Expected the failed continuation to be consumed')
        }
        assertInvalidContinuation(repeated.failure, subject.adapter.descriptor.id)
      }),
    )

    it.effect('rejects undeclared provider tool calls after one request', () =>
      Effect.gen(function* () {
        const setup = yield* decodeConformanceSetup({
          discoverySteps: [],
          generationSteps: [
            {
              _tag: 'ToolCalls',
              blocked: false,
              calls: [
                {
                  callId: 'call-a',
                  toolId: 'unlisted.tool',
                  input: { query: 'not visible' },
                },
              ],
              usage: { _tag: 'Unavailable' },
            },
          ],
        })
        const subject = yield* factory.make(setup)
        if (!subject.adapter.descriptor.capabilities.feedbackTools) return

        const request = yield* makeFeedbackRequest()
        const turnScope = yield* makeTurnScope
        const result = yield* Effect.result(
          subject.adapter.generate(request).pipe(Effect.provideService(Scope.Scope, turnScope)),
        )
        if (Result.isSuccess(result)) {
          return yield* Effect.die('Expected an undeclared tool call error')
        }
        expect(result.failure._tag).toBe('AdapterProtocolViolationError')
        if (result.failure._tag === 'AdapterProtocolViolationError') {
          expect(result.failure.reason).toBe('undeclared-tool-call')
        }
        expect(yield* countProviderRequests(subject.control, 'generate')).toBe(1)
      }),
    )

    it.effect('rejects duplicate provider call IDs after one request', () =>
      Effect.gen(function* () {
        const duplicate = {
          callId: 'call-a',
          toolId: 'history.search',
          input: { query: 'duplicate' },
        } as const
        const setup = yield* decodeConformanceSetup({
          discoverySteps: [],
          generationSteps: [
            {
              _tag: 'ToolCalls',
              blocked: false,
              calls: [duplicate, duplicate],
              usage: { _tag: 'Unavailable' },
            },
          ],
        })
        const subject = yield* factory.make(setup)
        if (!subject.adapter.descriptor.capabilities.feedbackTools) return

        const request = yield* makeFeedbackRequest()
        const turnScope = yield* makeTurnScope
        const result = yield* Effect.result(
          subject.adapter.generate(request).pipe(Effect.provideService(Scope.Scope, turnScope)),
        )
        if (Result.isSuccess(result)) {
          return yield* Effect.die('Expected a duplicate call ID error')
        }
        expect(result.failure._tag).toBe('AdapterProtocolViolationError')
        if (result.failure._tag === 'AdapterProtocolViolationError') {
          expect(result.failure.reason).toBe('duplicate-call-id')
        }
        expect(yield* countProviderRequests(subject.control, 'generate')).toBe(1)
      }),
    )

    it.effect('removes a continuation after a typed provider failure', () =>
      Effect.gen(function* () {
        const setup = yield* decodeConformanceSetup({
          discoverySteps: [],
          generationSteps: [
            {
              _tag: 'ToolCalls',
              blocked: false,
              calls: [
                {
                  callId: 'call-a',
                  toolId: 'history.search',
                  input: { query: 'failure cleanup' },
                },
              ],
              usage: { _tag: 'Unavailable' },
            },
            {
              _tag: 'Failure',
              blocked: false,
              failure: {
                category: 'transport',
                providerMessage: 'private transport failure',
              },
            },
          ],
        })
        const subject = yield* factory.make(setup)
        if (!subject.adapter.descriptor.capabilities.feedbackTools) return

        const generateRequest = yield* makeFeedbackRequest()
        const turnScope = yield* makeTurnScope
        const initial = yield* subject.adapter
          .generate(generateRequest)
          .pipe(Effect.provideService(Scope.Scope, turnScope))
        const toolBatch = yield* requireToolCallBatch(initial)
        const continueRequest = yield* makeSingleResultContinueRequest(toolBatch.continuation)
        const failed = yield* Effect.result(subject.adapter.continue(continueRequest))
        if (Result.isSuccess(failed)) {
          return yield* Effect.die('Expected the provider continuation to fail')
        }
        expect(failed.failure._tag).toBe('AdapterTransportError')

        const repeated = yield* Effect.result(subject.adapter.continue(continueRequest))
        if (Result.isSuccess(repeated)) {
          return yield* Effect.die('Expected failed continuation cleanup')
        }
        assertInvalidContinuation(repeated.failure, subject.adapter.descriptor.id)
        expect(yield* countProviderRequests(subject.control, 'continue')).toBe(1)
      }),
    )

    for (const category of ERROR_CATEGORIES) {
      it.effect(`classifies and sanitizes ${category} failures without retry`, () =>
        Effect.gen(function* () {
          const providerCanary = `provider-secret-${category}`
          const setup = yield* decodeConformanceSetup({
            discoverySteps: [],
            generationSteps: [
              {
                _tag: 'Failure',
                blocked: false,
                failure: {
                  category,
                  providerMessage: providerCanary,
                  retryAfterMs: 1_500,
                  statusCode: 503,
                },
              },
            ],
          })
          const subject = yield* factory.make(setup)
          const request = yield* makeTextRequest()
          const turnScope = yield* makeTurnScope
          const result = yield* Effect.result(
            subject.adapter.generate(request).pipe(Effect.provideService(Scope.Scope, turnScope)),
          )

          if (Result.isSuccess(result)) {
            return yield* Effect.die(`Expected ${category} to fail`)
          }
          expect(result.failure._tag).toBe(expectedErrorTag(category))
          expect(result.failure.operation).toBe('generate')
          expect(result.failure.adapterId).toBe(subject.adapter.descriptor.id)
          expect(JSON.stringify(result.failure)).not.toContain(providerCanary)

          if (result.failure._tag === 'AdapterRateLimitError') {
            expect(result.failure.retryAfterMs).toBe(1_500)
          }
          if (result.failure._tag === 'AdapterProviderResponseError') {
            expect(result.failure.statusCode).toBe(503)
          }
          if (result.failure._tag === 'AdapterUnsupportedError') {
            expect(result.failure.feature).toBe('feedback-tools')
          }

          expect(yield* countProviderRequests(subject.control, 'generate')).toBe(1)
          expect(yield* subject.control.activeRequests()).toBe(0)
        }),
      )
    }
  })
}
