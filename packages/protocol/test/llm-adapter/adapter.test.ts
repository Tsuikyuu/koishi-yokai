import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'

import {
  AdapterDescriptor,
  ContinueRequest,
  GenerateRequest,
  makeAdapterContinuation,
  negotiateAdapterProtocol,
  type YokaiAdapter,
} from '../../src/index'

it.effect('rejects an incompatible major before discovery or generation is invoked', () =>
  Effect.gen(function* () {
    const calls = { discover: 0, generate: 0, continue: 0 }
    const mustNotRun = (operation: keyof typeof calls) =>
      Effect.sync(() => {
        calls[operation] += 1
        throw new Error(`${operation} must not run before protocol negotiation`)
      })
    const descriptor = yield* Schema.decodeUnknownEffect(AdapterDescriptor)({
      id: 'future-adapter',
      protocolVersion: { major: 1, minor: 0 },
      capabilities: { feedbackTools: false },
    })
    const adapter: YokaiAdapter = {
      descriptor,
      discoverModels: () => mustNotRun('discover'),
      generate: () => mustNotRun('generate'),
      continue: () => mustNotRun('continue'),
    }
    const request = yield* Schema.decodeUnknownEffect(GenerateRequest)({
      modelId: 'models/text',
      messages: [{ role: 'user', content: 'hello' }],
      limits: { maxOutputTokens: 128 },
      feedbackTools: [],
    })
    const continuation = yield* makeAdapterContinuation('version-test-handle')
    const continueRequest = yield* Schema.decodeUnknownEffect(ContinueRequest)({
      continuation,
      results: [{ _tag: 'Success', callId: 'call-1', output: { ok: true } }],
    })

    const discoveryError = yield* negotiateAdapterProtocol(adapter).pipe(
      Effect.flatMap((compatible) => compatible.discoverModels()),
      Effect.flip,
    )
    const generationError = yield* Effect.scoped(
      negotiateAdapterProtocol(adapter).pipe(
        Effect.flatMap((compatible) => compatible.generate(request)),
        Effect.flip,
      ),
    )
    const continuationError = yield* negotiateAdapterProtocol(adapter).pipe(
      Effect.flatMap((compatible) => compatible.continue(continueRequest)),
      Effect.flip,
    )

    expect(discoveryError._tag).toBe('AdapterProtocolVersionMismatchError')
    expect(generationError._tag).toBe('AdapterProtocolVersionMismatchError')
    expect(continuationError._tag).toBe('AdapterProtocolVersionMismatchError')
    expect(calls).toEqual({ discover: 0, generate: 0, continue: 0 })
  }),
)

it.effect('accepts both older and newer minors with the supported major', () =>
  Effect.gen(function* () {
    const makeAdapter = (descriptor: AdapterDescriptor): YokaiAdapter => ({
      descriptor,
      discoverModels: () => Effect.die('not called'),
      generate: () => Effect.die('not called'),
      continue: () => Effect.die('not called'),
    })
    const older = makeAdapter(
      yield* Schema.decodeUnknownEffect(AdapterDescriptor)({
        id: 'older-adapter',
        protocolVersion: { major: 0, minor: 0 },
        capabilities: { feedbackTools: false },
      }),
    )
    const newer = makeAdapter(
      yield* Schema.decodeUnknownEffect(AdapterDescriptor)({
        id: 'newer-adapter',
        protocolVersion: { major: 0, minor: 99 },
        capabilities: { feedbackTools: false },
      }),
    )

    expect(yield* negotiateAdapterProtocol(older)).toBe(older)
    expect(yield* negotiateAdapterProtocol(newer)).toBe(newer)
  }),
)
