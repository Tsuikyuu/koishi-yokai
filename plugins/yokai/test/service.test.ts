import { expect, it } from '@effect/vitest'
import { HostConfiguration } from '@yokai/core'
import {
  AdapterDescriptor,
  AdapterId,
  AdapterModelSnapshot,
  CapabilityProtocolVersion,
  type CapabilityRegistration,
  ContextProvider,
  ContextProviderId,
  CURRENT_ADAPTER_PROTOCOL_VERSION,
  type YokaiAdapter,
} from '@yokai/protocol'
import { Deferred, Effect, Option, Schema } from 'effect'
import { Context } from 'koishi'
import { vi } from 'vitest'

vi.mock('koishi', () => import('@koishijs/core'))

import { apply, type Config } from '../src/index'
import { Yokai } from '../src/service'

const DEFAULT_CONFIG: Config = {
  fallback: [],
  feedbackToolsEnabled: false,
}

const VERSION = CapabilityProtocolVersion.make({ major: 0, minor: 1 })

const makeContextProvider = (id: string): ContextProvider =>
  ContextProvider.make({
    id: ContextProviderId.make(id),
    protocolVersion: VERSION,
  })

const makeAdapter = (id: string): YokaiAdapter => ({
  descriptor: AdapterDescriptor.make({
    id: AdapterId.make(id),
    protocolVersion: CURRENT_ADAPTER_PROTOCOL_VERSION,
    capabilities: { feedbackTools: true },
  }),
  discoverModels: () => Effect.die('not called'),
  generate: () => Effect.die('not called'),
  continue: () => Effect.die('not called'),
})

class TestYokai extends Yokai {
  readConfiguration() {
    return this.runEffect(HostConfiguration.Service)
  }

  runOwned(effect: Effect.Effect<void>): Promise<void> {
    return this.runEffect(effect)
  }
}

const stop = (ctx: Context) => Effect.promise(() => ctx.stop())

it.effect('starts without a primary model and preserves ordered fallback configuration', () => {
  const ctx = new Context()
  const service = new TestYokai(ctx, {
    fallback: ['local/qwen', 'gemini/models/gemini-2.5-flash'],
    feedbackToolsEnabled: true,
  })

  return Effect.gen(function* () {
    const configuration = yield* Effect.promise(() => service.readConfiguration())

    expect(Option.isNone(configuration.primary)).toBe(true)
    expect(
      configuration.fallback.map((reference) => reference.adapterId + '/' + reference.modelId),
    ).toEqual(['local/qwen', 'gemini/models/gemini-2.5-flash'])
    expect(configuration.feedbackToolsEnabled).toBe(true)
  }).pipe(Effect.ensuring(stop(ctx)))
})

it.effect('lets a third-party plugin register and auto-unregister its capability', () => {
  const ctx = new Context()
  const provider = makeContextProvider('third-party.context')
  let registrationPromise: Promise<CapabilityRegistration> | undefined
  const extensionScope = ctx.inject(['yokai'], (extensionContext) => {
    registrationPromise = extensionContext.yokai.registerContextProvider(provider)
  })

  apply(ctx, DEFAULT_CONFIG)

  return Effect.gen(function* () {
    yield* Effect.promise(() => ctx.start())
    if (registrationPromise === undefined) {
      return yield* Effect.die('Expected the third-party plugin to register')
    }
    const pendingRegistration = registrationPromise
    const registration = yield* Effect.promise(() => pendingRegistration)

    expect(extensionScope.dispose()).toBe(true)
    expect(yield* Effect.promise(() => registration.unregister())).toBe(false)

    const replacement = yield* Effect.promise(() => ctx.yokai.registerContextProvider(provider))
    expect(yield* Effect.promise(() => replacement.unregister())).toBe(true)
    expect(yield* Effect.promise(() => replacement.unregister())).toBe(false)
  }).pipe(Effect.ensuring(stop(ctx)))
})

it.effect('publishes through an adapter handle until that handle is unregistered', () => {
  const ctx = new Context()
  apply(ctx, DEFAULT_CONFIG)

  return Effect.gen(function* () {
    const registration = yield* Effect.promise(() =>
      ctx.yokai.registerAdapter(makeAdapter('boundary-adapter')),
    )
    const snapshot = yield* Schema.decodeUnknownEffect(AdapterModelSnapshot)({
      discoveredAt: '2026-08-22T00:00:00.000Z',
      models: [],
    })

    expect(yield* Effect.promise(() => registration.publishModels(snapshot))).toBe(true)
    expect(yield* Effect.promise(() => registration.unregister())).toBe(true)
    expect(yield* Effect.promise(() => registration.publishModels(snapshot))).toBe(false)
  }).pipe(Effect.ensuring(stop(ctx)))
})

it.effect('interrupts every owned fiber when the Koishi service is disposed', () => {
  const ctx = new Context()
  const service = new TestYokai(ctx, DEFAULT_CONFIG)

  return Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const interrupted = yield* Deferred.make<void>()
    const pending = service.runOwned(
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      ),
    )

    yield* Deferred.await(started)
    yield* stop(ctx)
    yield* Deferred.await(interrupted)
    const rejected = yield* Effect.promise(() =>
      pending.then(
        () => false,
        () => true,
      ),
    )
    expect(rejected).toBe(true)
  }).pipe(Effect.ensuring(stop(ctx)))
})
