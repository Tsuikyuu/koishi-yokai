import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from '@effect/vitest'
import { AdapterConformanceSetup } from 'yokai-adapter-conformance'
import { makeFakeAdapter } from 'yokai-adapter-conformance/fake'
import {
  CapabilityRegistry,
  HostConfiguration,
  ScheduledDelivery,
  ScheduledTaskModel,
} from '@yokai-internal/core'
import { MessageArchiveEvent } from '@yokai-internal/memory'
import {
  ActionTool,
  ActionToolDurationMilliseconds,
  ActionToolId,
  ActionToolXmlTemplate,
  AdapterDescriptor,
  AdapterId,
  AdapterModelId,
  AdapterModelSnapshot,
  CapabilityDurationMilliseconds,
  CapabilityProtocolVersion,
  type CapabilityRegistration,
  ContextProvider,
  ContextProviderId,
  CURRENT_ADAPTER_PROTOCOL_VERSION,
  FeedbackTool,
  FeedbackToolId,
  McpServer,
  McpServerId,
  McpServerSnapshot,
  PresetId,
  PresetSource,
  PresetSourceId,
  type PresetSnapshot,
  TokenLimit,
  type YokaiAdapter,
} from 'yokai-protocol'
import { Deferred, Effect, Option, Queue, Ref, Schema } from 'effect'
import { Bot, Context, type Fragment, type Schema as KoishiSchema, Universal } from 'koishi'
import { vi } from 'vitest'

vi.mock('koishi', () => import('@koishijs/core'))

import { apply, type Config } from '../src/index'
import {
  DEFAULT_VISIBLE_ACTION_TOOLS,
  DEFAULT_VISIBLE_FEEDBACK_TOOLS,
  DEFAULT_VISIBLE_MCP_SERVERS,
  DEFAULT_VISIBLE_SKILLS,
} from '../src/config'
import { Yokai } from '../src/service'

const DEFAULT_CONFIG: Config = {
  feedbackToolsEnabled: false,
}

const VERSION = CapabilityProtocolVersion.make({ major: 0, minor: 1 })

const makeContextProvider = (id: string): ContextProvider =>
  ContextProvider.make({
    id: ContextProviderId.make(id),
    protocolVersion: VERSION,
    description: 'Test context provider',
    maxTokens: TokenLimit.make(128),
    maxDurationMs: CapabilityDurationMilliseconds.make(250),
    isAvailable: () => true,
    provide: () => Effect.succeed(Option.none()),
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

const makeMcpActionTool = (id: string): ActionTool =>
  ActionTool.make({
    id: ActionToolId.make(id),
    protocolVersion: VERSION,
    description: 'Test MCP action tool',
    xmlTemplate: ActionToolXmlTemplate.make(
      `<action tool="${id}"><value>XML_ESCAPED_VALUE</value></action>`,
    ),
    inputSchema: {
      _tag: 'Object',
      properties: [{ name: 'value', required: true, schema: { _tag: 'String' } }],
    },
    executionStage: 'after-send',
    completionPolicy: 'none',
    failurePolicy: 'continue',
    maxDurationMs: ActionToolDurationMilliseconds.make(250),
    isAvailable: () => true,
    isInputAllowed: () => true,
    execute: () => Effect.void,
  })

const makeMcpFeedbackTool = (id: string): FeedbackTool =>
  FeedbackTool.make({
    id: FeedbackToolId.make(id),
    protocolVersion: VERSION,
    description: 'Test MCP feedback tool',
    inputSchema: { _tag: 'Object', properties: [] },
    outputSchema: { _tag: 'String' },
    maxResultTokens: TokenLimit.make(64),
    maxDurationMs: CapabilityDurationMilliseconds.make(250),
    isAvailable: () => true,
    prepare: () => Effect.succeed({ execute: () => Effect.succeed('result') }),
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

  responseMechanismIds() {
    return this.runEffect(
      CapabilityRegistry.Service.pipe(
        Effect.flatMap((registry) => registry.snapshot()),
        Effect.map((snapshot) => snapshot.responseMechanisms.map((mechanism) => mechanism.id)),
      ),
    )
  }

  capabilityIds() {
    return this.runEffect(
      CapabilityRegistry.Service.pipe(
        Effect.flatMap((registry) => registry.snapshot()),
        Effect.map((snapshot) => ({
          contextProviders: snapshot.contextProviders.map((provider) => provider.id),
          actionTools: snapshot.actionTools.map((tool) => tool.id),
          feedbackTools: snapshot.feedbackTools.map((tool) => tool.id),
          mcpProjectionSources: snapshot.mcpProjectionSources,
          responseMechanisms: snapshot.responseMechanisms.map((mechanism) => mechanism.id),
        })),
      ),
    )
  }

  scheduleDeliveryAvailable(task: ScheduledTaskModel.Task) {
    return this.runEffect(
      ScheduledDelivery.Service.pipe(Effect.flatMap((delivery) => delivery.isAvailable(task))),
    )
  }
}

class ScheduleAvailabilityBot extends Bot<Context, {}> {
  constructor(ctx: Context) {
    super(ctx, {}, 'test')
    this.user = { id: 'bot' }
  }

  override sendMessage(_channelId: string, _content: Fragment): Promise<string[]> {
    return Promise.resolve(['sent'])
  }

  override dispose(): Promise<void> {
    return Promise.resolve()
  }
}

const scheduleTask = (selfId = 'bot'): ScheduledTaskModel.Task =>
  ScheduledTaskModel.Task.make({
    instanceId: MessageArchiveEvent.InstanceId.make('default'),
    platform: MessageArchiveEvent.PlatformId.make('test'),
    guildId: MessageArchiveEvent.GuildId.make('guild'),
    channelId: MessageArchiveEvent.ChannelId.make('channel'),
    scheduleId: ScheduledTaskModel.ScheduleId.make(`schedule_${'a'.repeat(32)}`),
    dedupeKey: ScheduledTaskModel.DedupeKey.make('availability'),
    creationFingerprint: ScheduledTaskModel.CreationFingerprint.make('a'.repeat(64)),
    createdMessageId: MessageArchiveEvent.MessageId.make('source'),
    creatorId: MessageArchiveEvent.ActorId.make('user'),
    selfId: MessageArchiveEvent.ActorId.make(selfId),
    reason: ScheduledTaskModel.Reason.make('Availability check'),
    dueAt: ScheduledTaskModel.EpochMilliseconds.make(1_000),
    repeatEveryMs: Option.none(),
    timeZone: ScheduledTaskModel.TimeZoneId.make('UTC'),
    status: 'pending',
    occurrence: ScheduledTaskModel.Occurrence.make(0),
    revision: ScheduledTaskModel.Revision.make(1),
    createdAt: ScheduledTaskModel.EpochMilliseconds.make(0),
    updatedAt: ScheduledTaskModel.EpochMilliseconds.make(0),
    lastTriggeredAt: Option.none(),
  })

const stop = (ctx: Context) => Effect.promise(() => ctx.stop())

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), 'yokai-presets-'))),
  (directory) => Effect.tryPromise(() => rm(directory, { recursive: true, force: true })),
)

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
    expect(configuration.capabilityVisibility).toEqual({
      skills: DEFAULT_VISIBLE_SKILLS,
      actionTools: DEFAULT_VISIBLE_ACTION_TOOLS,
      feedbackTools: DEFAULT_VISIBLE_FEEDBACK_TOOLS,
      mcpServers: DEFAULT_VISIBLE_MCP_SERVERS,
    })
    expect(Object.isFrozen(configuration.capabilityVisibility)).toBe(true)
    expect(Object.isFrozen(configuration.capabilityVisibility.actionTools)).toBe(true)
  }).pipe(Effect.ensuring(stop(ctx)))
})

it.effect('decodes and freezes custom capability visibility', () => {
  const ctx = new Context()
  const service = new TestYokai(ctx, {
    feedbackToolsEnabled: false,
    capabilities: {
      skills: ['custom.skill'],
      actionTools: ['custom.action'],
      feedbackTools: ['custom.feedback'],
      mcpServers: ['custom.server'],
    },
  })

  return Effect.gen(function* () {
    const configuration = yield* Effect.promise(() => service.readConfiguration())

    expect(configuration.capabilityVisibility).toEqual({
      skills: ['custom.skill'],
      actionTools: ['custom.action'],
      feedbackTools: ['custom.feedback'],
      mcpServers: ['custom.server'],
    })
    expect(Object.isFrozen(configuration.capabilityVisibility)).toBe(true)
    expect(Object.isFrozen(configuration.capabilityVisibility.skills)).toBe(true)
    expect(Object.isFrozen(configuration.capabilityVisibility.actionTools)).toBe(true)
    expect(Object.isFrozen(configuration.capabilityVisibility.feedbackTools)).toBe(true)
    expect(Object.isFrozen(configuration.capabilityVisibility.mcpServers)).toBe(true)
  }).pipe(Effect.ensuring(stop(ctx)))
})

it.effect('rejects an engagement idle TTL longer than its absolute duration', () => {
  const ctx = new Context()
  const service = new TestYokai(ctx, {
    feedbackToolsEnabled: false,
    engagement: {
      idleTtlMs: 5_000,
      maxDurationMs: 4_999,
    },
  })

  return Effect.gen(function* () {
    const outcome = yield* Effect.promise(() => service.readConfiguration()).pipe(Effect.exit)
    expect(outcome._tag).toBe('Failure')
  }).pipe(Effect.ensuring(stop(ctx)))
})

it.effect('rejects an invalid schedule IANA time zone', () => {
  const ctx = new Context()
  const service = new TestYokai(ctx, {
    feedbackToolsEnabled: false,
    schedule: { timeZone: 'Not/A-Time-Zone' },
  })

  return Effect.gen(function* () {
    const outcome = yield* Effect.promise(() => service.readConfiguration()).pipe(Effect.exit)
    expect(outcome._tag).toBe('Failure')
  }).pipe(Effect.ensuring(stop(ctx)))
})

it.effect('starts and stops when the preset directory requires asynchronous acquisition', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory
      const ctx = new Context()
      apply(ctx, {
        feedbackToolsEnabled: false,
        presetDirectory: directory,
      })

      yield* Effect.promise(() => ctx.start()).pipe(Effect.ensuring(stop(ctx)))
    }),
  ),
)

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

it.effect(
  'registers direct, activity, engagement, initiative, and schedule as built-in response mechanisms',
  () => {
    const ctx = new Context()
    const service = new TestYokai(ctx, DEFAULT_CONFIG)

    return Effect.gen(function* () {
      expect((yield* Effect.promise(() => service.responseMechanismIds())).sort()).toEqual([
        'action-completion',
        'activity',
        'direct',
        'engagement',
        'initiative',
        'schedule',
      ])
    }).pipe(Effect.ensuring(stop(ctx)))
  },
)

it.effect('hides the initiative response mechanism when proactive speech is disabled', () => {
  const ctx = new Context()
  const service = new TestYokai(ctx, {
    ...DEFAULT_CONFIG,
    initiative: { enabled: false },
  })

  return Effect.gen(function* () {
    expect(yield* Effect.promise(() => service.responseMechanismIds())).not.toContain('initiative')
  }).pipe(Effect.ensuring(stop(ctx)))
})

it.effect('hides the schedule response mechanism when persistent scheduling is disabled', () => {
  const ctx = new Context()
  const service = new TestYokai(ctx, {
    ...DEFAULT_CONFIG,
    schedule: { enabled: false },
  })

  return Effect.gen(function* () {
    const capabilities = yield* Effect.promise(() => service.capabilityIds())
    expect(capabilities.contextProviders).not.toContain('schedule.context')
    expect(capabilities.actionTools).not.toContain('schedule.create')
    expect(capabilities.actionTools).not.toContain('schedule.update')
    expect(capabilities.actionTools).not.toContain('schedule.cancel')
    expect(capabilities.feedbackTools).not.toContain('schedule.query')
    expect(capabilities.responseMechanisms).not.toContain('schedule')
  }).pipe(Effect.ensuring(stop(ctx)))
})

it.effect('registers the complete persistent schedule capability set when enabled', () => {
  const ctx = new Context()
  const service = new TestYokai(ctx, DEFAULT_CONFIG)

  return Effect.gen(function* () {
    const capabilities = yield* Effect.promise(() => service.capabilityIds())
    expect(capabilities.contextProviders).toContain('schedule.context')
    expect(capabilities.actionTools).toEqual(
      expect.arrayContaining(['schedule.create', 'schedule.update', 'schedule.cancel']),
    )
    expect(capabilities.feedbackTools).toContain('schedule.query')
    expect(capabilities.responseMechanisms).toContain('schedule')
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

it.effect('publishes MCP projections and disconnects through the public server handle', () => {
  const ctx = new Context()
  const service = new TestYokai(ctx, DEFAULT_CONFIG)

  return Effect.gen(function* () {
    const registration = yield* Effect.promise(() =>
      service.registerMcpServer(
        McpServer.make({ id: McpServerId.make('calendar'), protocolVersion: VERSION }),
      ),
    )
    const connected = yield* Schema.decodeUnknownEffect(McpServerSnapshot)({
      _tag: 'Connected',
      serverId: 'calendar',
      revision: 1,
      projections: [
        {
          _tag: 'Action',
          name: 'create',
          tool: makeMcpActionTool('calendar.create'),
        },
        {
          _tag: 'Feedback',
          name: 'lookup',
          tool: makeMcpFeedbackTool('calendar.lookup'),
        },
      ],
    })
    const disconnected = yield* Schema.decodeUnknownEffect(McpServerSnapshot)({
      _tag: 'Disconnected',
      serverId: 'calendar',
      revision: 2,
    })

    expect(yield* Effect.promise(() => registration.publishSnapshot(connected))).toBe(true)
    const projected = yield* Effect.promise(() => service.capabilityIds())
    expect(projected.actionTools).toContain('calendar.create')
    expect(projected.feedbackTools).toContain('calendar.lookup')
    expect(projected.mcpProjectionSources).toEqual([
      {
        serverId: 'calendar',
        actionToolIds: ['calendar.create'],
        feedbackToolIds: ['calendar.lookup'],
      },
    ])
    expect(yield* Effect.promise(() => registration.publishSnapshot(connected))).toBe(false)

    expect(yield* Effect.promise(() => registration.publishSnapshot(disconnected))).toBe(true)
    const offline = yield* Effect.promise(() => service.capabilityIds())
    expect(offline.actionTools).not.toContain('calendar.create')
    expect(offline.feedbackTools).not.toContain('calendar.lookup')
    expect(offline.mcpProjectionSources).toEqual([])
    expect(yield* Effect.promise(() => registration.publishSnapshot(connected))).toBe(false)

    expect(yield* Effect.promise(() => registration.unregister())).toBe(true)
    expect(yield* Effect.promise(() => registration.publishSnapshot(disconnected))).toBe(false)
  }).pipe(Effect.ensuring(stop(ctx)))
})

it.effect('publishes versioned presets through the public source handle', () => {
  const ctx = new Context()
  apply(ctx, DEFAULT_CONFIG)

  return Effect.scoped(
    Effect.gen(function* () {
      const updates = yield* Queue.unbounded<PresetSnapshot>()
      ctx.on('yokai/preset-updated', (snapshot) => {
        Effect.runSync(Queue.offer(updates, snapshot))
      })
      yield* Effect.promise(() => ctx.start())
      const registration = yield* Effect.promise(() =>
        ctx.yokai.registerPresetSource(
          PresetSource.make({
            id: PresetSourceId.make('third-party.preset'),
            protocolVersion: VERSION,
          }),
        ),
      )
      const candidate = {
        id: 'koharu',
        persona: {
          name: 'Koharu',
          selfConcept: 'A curious long-time member of the group.',
          background: 'Grew up around a small neighborhood library.',
          values: ['honesty'],
          interests: ['folklore'],
          opinions: ['Small practical help is better than grand promises.'],
          speakingStyle: 'Warm and concise.',
          socialBoundaries: ['Respect private matters.'],
          knowledgeBoundaries: ['Admit when a fact is not known.'],
        },
      }

      expect(yield* Effect.promise(() => registration.publish(candidate))).toBe(true)
      const update = yield* Queue.take(updates)
      expect(update).toMatchObject({ id: 'koharu', version: 1, sourceAvailable: true })
      expect(yield* Effect.promise(() => registration.publish(candidate))).toBe(false)
      expect(
        yield* Effect.promise(() => ctx.yokai.getPresetSnapshot(PresetId.make('koharu'))),
      ).toBe(update)

      expect(yield* Effect.promise(() => registration.unregister())).toBe(true)
      expect(
        yield* Effect.promise(() => ctx.yokai.getPresetSnapshot(PresetId.make('koharu'))),
      ).toMatchObject({ version: 1, sourceAvailable: false })
      expect(yield* Effect.promise(() => registration.publish(candidate))).toBe(false)
    }).pipe(Effect.ensuring(stop(ctx))),
  )
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
      yield* Effect.promise(() => ctx.start())

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

it.effect(
  'requires an exact online bot and an available selected model before schedule claim',
  () => {
    const ctx = new Context()
    const service = new TestYokai(ctx, {
      model: 'schedule-ready/model-a',
      feedbackToolsEnabled: false,
    })
    const bot = new ScheduleAvailabilityBot(ctx)

    return Effect.gen(function* () {
      expect(yield* Effect.promise(() => service.scheduleDeliveryAvailable(scheduleTask()))).toBe(
        false,
      )

      bot.status = Universal.Status.ONLINE
      expect(yield* Effect.promise(() => service.scheduleDeliveryAvailable(scheduleTask()))).toBe(
        false,
      )

      const registration = yield* Effect.promise(() =>
        service.registerAdapter(makeAdapter('schedule-ready')),
      )
      const available = yield* Schema.decodeUnknownEffect(AdapterModelSnapshot)({
        discoveredAt: '2026-08-31T00:00:00.000Z',
        models: [
          {
            id: 'model-a',
            displayName: 'Model A',
            availability: 'available',
            discoveryFreshness: 'fresh',
          },
        ],
      })
      yield* Effect.promise(() => registration.publishModels(available))

      expect(yield* Effect.promise(() => service.scheduleDeliveryAvailable(scheduleTask()))).toBe(
        true,
      )
      expect(
        yield* Effect.promise(() => service.scheduleDeliveryAvailable(scheduleTask('other-bot'))),
      ).toBe(false)
      bot.status = Universal.Status.OFFLINE
      expect(yield* Effect.promise(() => service.scheduleDeliveryAvailable(scheduleTask()))).toBe(
        false,
      )
    }).pipe(Effect.ensuring(stop(ctx)))
  },
)

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
