import { expect, it } from '@effect/vitest'
import { AdapterConformanceSetup } from 'yokai-adapter-conformance'
import { makeFakeAdapter } from 'yokai-adapter-conformance/fake'
import { HostConfiguration } from '@yokai-internal/core'
import {
  AdapterDescriptor,
  AdapterId,
  AdapterModelId,
  AdapterModelSnapshot,
  CapabilityProtocolVersion,
  type CapabilityRegistration,
  ContextProvider,
  ContextProviderId,
  CURRENT_ADAPTER_PROTOCOL_VERSION,
  type YokaiAdapter,
} from 'yokai-protocol'
import { Deferred, Effect, Option, Queue, Ref, Schema } from 'effect'
import { Context, type Schema as KoishiSchema } from 'koishi'
import { vi } from 'vitest'

vi.mock('koishi', () => import('@koishijs/core'))

import { apply, type Config } from '../src/index'
import { Yokai } from '../src/service'

const DEFAULT_CONFIG: Config = {
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
  discoverModels: () => Effect.never,
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

  selectModel() {
    return this.resolveConfiguredModel()
  }
}

const stop = (ctx: Context) => Effect.promise(() => ctx.stop())

const schemaOption = (schema: KoishiSchema, value: string): KoishiSchema | undefined => {
  const list = schema.list
  return list === undefined ? undefined : list.find((option) => option.value === value)
}

const takeSchemaMatching = (
  events: Queue.Queue<KoishiSchema>,
  predicate: (schema: KoishiSchema) => boolean,
): Effect.Effect<KoishiSchema> =>
  Queue.take(events).pipe(
    Effect.flatMap((schema) =>
      predicate(schema) ? Effect.succeed(schema) : takeSchemaMatching(events, predicate),
    ),
  )

const fakeSetup = (...displayNames: ReadonlyArray<string>) =>
  AdapterConformanceSetup.make({
    discoverySteps: displayNames.map((displayName, index) => ({
      _tag: 'Success',
      discoveredAt: `2026-08-24T00:00:0${index}.000Z`,
      models: [
        {
          id: AdapterModelId.make('model-a'),
          displayName,
          availability: 'available',
          discoveryFreshness: 'fresh',
        },
      ],
      blocked: false,
    })),
    generationSteps: [],
  })

it.effect('starts without a selected model', () => {
  const ctx = new Context()
  const service = new TestYokai(ctx, {
    feedbackToolsEnabled: true,
  })

  return Effect.gen(function* () {
    const configuration = yield* Effect.promise(() => service.readConfiguration())

    expect(Option.isNone(configuration.model)).toBe(true)
    expect(configuration.feedbackToolsEnabled).toBe(true)
  }).pipe(Effect.ensuring(stop(ctx)))
})

it.effect('decodes exactly one selected model reference', () => {
  const ctx = new Context()
  const service = new TestYokai(ctx, {
    model: 'remote/selected',
    feedbackToolsEnabled: false,
  })

  return Effect.gen(function* () {
    const configuration = yield* Effect.promise(() => service.readConfiguration())
    if (Option.isNone(configuration.model)) {
      return yield* Effect.die('Expected a selected model')
    }
    expect(configuration.model.value.adapterId).toBe('remote')
    expect(configuration.model.value.modelId).toBe('selected')
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

it.effect('projects fake adapter lifecycle into the live Koishi model schema', () => {
  const ctx = new Context()
  const config: Config = {
    model: 'fake-live/model-a',
    feedbackToolsEnabled: false,
  }

  return Effect.scoped(
    Effect.gen(function* () {
      const schemaEvents = yield* Queue.unbounded<KoishiSchema>()
      const schemaEventCount = yield* Ref.make(0)
      ctx.on('internal/schema', (name) => {
        if (name === 'yokai-model') {
          Effect.runSync(
            Ref.update(schemaEventCount, (count) => count + 1).pipe(
              Effect.andThen(Queue.offer(schemaEvents, ctx.schema.get(name))),
            ),
          )
        }
      })
      apply(ctx, config)

      const initialSchema = yield* takeSchemaMatching(schemaEvents, (schema) => {
        const option = schemaOption(schema, 'fake-live/model-a')
        return option !== undefined && option.meta.disabled === true
      })
      const initialOption = schemaOption(initialSchema, 'fake-live/model-a')
      if (initialOption === undefined)
        return yield* Effect.die('Expected an initial disabled option')
      expect(initialOption.meta.disabled).toBe(true)

      const first = yield* makeFakeAdapter(
        {
          adapterId: AdapterId.make('fake-live'),
          feedbackTools: true,
          tokenNamespace: 'yk011-first',
        },
        fakeSetup('First label', 'Refreshed label'),
      )
      const firstRegistration = yield* Effect.promise(() =>
        ctx.yokai.registerAdapter(first.adapter),
      )
      expect(yield* first.control.takeEvent()).toMatchObject({
        _tag: 'RequestStarted',
        kind: 'model-list',
        operation: 'discoverModels',
      })
      expect((yield* first.control.takeEvent())._tag).toBe('RequestSucceeded')

      const availableSchema = yield* takeSchemaMatching(schemaEvents, (schema) => {
        const option = schemaOption(schema, 'fake-live/model-a')
        return option !== undefined && option.meta.disabled !== true
      })
      const availableOption = schemaOption(availableSchema, 'fake-live/model-a')
      if (availableOption === undefined) return yield* Effect.die('Expected an available option')
      expect(availableOption.meta.description).toBe('fake-live/model-a')
      expect((yield* Effect.promise(() => ctx.yokai.getModelCatalog())).models).toHaveLength(1)

      expect(
        yield* Effect.promise(() => ctx.yokai.refreshModels(AdapterId.make('fake-live'))),
      ).toBe(1)
      expect((yield* first.control.takeEvent())._tag).toBe('RequestStarted')
      expect((yield* first.control.takeEvent())._tag).toBe('RequestSucceeded')
      yield* Queue.take(schemaEvents)
      const refreshedSchema = yield* Queue.take(schemaEvents)
      const refreshedOption = schemaOption(refreshedSchema, 'fake-live/model-a')
      if (refreshedOption === undefined) return yield* Effect.die('Expected a refreshed option')
      expect(refreshedOption.meta.description).toBe('fake-live/model-a')
      const refreshedCatalog = yield* Effect.promise(() => ctx.yokai.getModelCatalog())
      const refreshedCatalogModel = refreshedCatalog.models[0]
      if (refreshedCatalogModel === undefined) {
        return yield* Effect.die('Expected a refreshed catalog model')
      }
      expect(refreshedCatalogModel.displayName).toBe('Refreshed label')

      const eventsBeforeUnchangedPublish = yield* Ref.get(schemaEventCount)
      const unchangedSnapshot = yield* Schema.decodeUnknownEffect(AdapterModelSnapshot)({
        discoveredAt: '2026-08-24T00:00:10.000Z',
        models: [
          {
            id: 'model-a',
            displayName: 'Refreshed label',
            availability: 'available',
            discoveryFreshness: 'fresh',
          },
        ],
      })
      expect(yield* Effect.promise(() => firstRegistration.publishModels(unchangedSnapshot))).toBe(
        true,
      )
      expect(yield* Effect.promise(() => firstRegistration.unregister())).toBe(true)
      const unavailableSchema = yield* takeSchemaMatching(schemaEvents, (schema) => {
        const option = schemaOption(schema, 'fake-live/model-a')
        return option !== undefined && option.meta.disabled === true
      })
      const unavailableOption = schemaOption(unavailableSchema, 'fake-live/model-a')
      if (unavailableOption === undefined) return yield* Effect.die('Expected a disabled option')
      expect(unavailableOption.meta.disabled).toBe(true)
      expect(yield* Ref.get(schemaEventCount)).toBe(eventsBeforeUnchangedPublish + 1)

      const replacement = yield* makeFakeAdapter(
        {
          adapterId: AdapterId.make('fake-live'),
          feedbackTools: true,
          tokenNamespace: 'yk011-replacement',
        },
        fakeSetup('Replacement label'),
      )
      yield* Effect.promise(() => ctx.yokai.registerAdapter(replacement.adapter))
      expect((yield* replacement.control.takeEvent())._tag).toBe('RequestStarted')
      expect((yield* replacement.control.takeEvent())._tag).toBe('RequestSucceeded')

      const restoredSchema = yield* takeSchemaMatching(schemaEvents, (schema) => {
        const option = schemaOption(schema, 'fake-live/model-a')
        return option !== undefined && option.meta.disabled !== true
      })
      const restoredOption = schemaOption(restoredSchema, 'fake-live/model-a')
      if (restoredOption === undefined) return yield* Effect.die('Expected a restored option')
      expect(restoredOption.meta.description).toBe('fake-live/model-a')
      expect(config.model).toBe('fake-live/model-a')
    }).pipe(Effect.ensuring(stop(ctx))),
  )
})

it.effect('uses only the selected model and recovers when it becomes available', () => {
  const ctx = new Context()
  const service = new TestYokai(ctx, {
    model: 'selection/selected',
    feedbackToolsEnabled: false,
  })

  return Effect.gen(function* () {
    const registration = yield* Effect.promise(() =>
      service.registerAdapter(makeAdapter('selection')),
    )
    const unavailable = yield* Schema.decodeUnknownEffect(AdapterModelSnapshot)({
      discoveredAt: '2026-08-24T00:00:00.000Z',
      models: [
        {
          id: 'other',
          displayName: 'Other',
          availability: 'available',
          discoveryFreshness: 'fresh',
        },
        {
          id: 'selected',
          displayName: 'Selected',
          availability: 'unavailable',
          discoveryFreshness: 'fresh',
        },
      ],
    })
    yield* Effect.promise(() => registration.publishModels(unavailable))
    yield* Effect.promise(() =>
      expect(service.selectModel()).rejects.toMatchObject({
        _tag: 'ModelSelectionUnavailableError',
        reference: { adapterId: 'selection', modelId: 'selected' },
      }),
    )

    const available = yield* Schema.decodeUnknownEffect(AdapterModelSnapshot)({
      discoveredAt: '2026-08-24T00:00:01.000Z',
      models: [
        {
          id: 'other',
          displayName: 'Other',
          availability: 'available',
          discoveryFreshness: 'fresh',
        },
        {
          id: 'selected',
          displayName: 'Selected',
          availability: 'available',
          discoveryFreshness: 'fresh',
        },
      ],
    })
    yield* Effect.promise(() => registration.publishModels(available))
    expect((yield* Effect.promise(() => service.selectModel())).reference.modelId).toBe('selected')
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
