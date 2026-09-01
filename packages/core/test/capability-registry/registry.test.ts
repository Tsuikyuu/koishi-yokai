import { expect, it } from '@effect/vitest'
import {
  AdapterDescriptor,
  AdapterId,
  AdapterModelSnapshot,
  AdapterTransportError,
  ActionToolDurationMilliseconds,
  ActionToolXmlTemplate,
  CapabilityDurationMilliseconds,
  CURRENT_ADAPTER_PROTOCOL_VERSION,
  FeedbackToolId,
  MAX_FEEDBACK_TOOL_DESCRIPTION_LENGTH,
  McpServerSnapshot,
  ModelReference,
  TokenLimit,
  type ModelCatalogSnapshot,
  type YokaiAdapter,
} from 'yokai-protocol'
import { Deferred, Effect, Fiber, Option, Ref, Result, Schema, Stream } from 'effect'

import {
  ActionTool,
  ActionToolId,
  CapabilityProtocolVersion,
  CapabilityRegistry,
  type CapabilityRegistryInterface,
  ContextProvider,
  ContextProviderId,
  FeedbackTool,
  McpServer,
  McpServerId,
  PresetSource,
  PresetSourceId,
  ResponseMechanism,
  ResponseMechanismId,
  Skill,
  SkillId,
} from '../../src/index'

const VERSION = CapabilityProtocolVersion.make({ major: 0, minor: 1 })

const makeAdapter = (
  id: string,
  protocolVersion = CURRENT_ADAPTER_PROTOCOL_VERSION,
): YokaiAdapter => ({
  descriptor: AdapterDescriptor.make({
    id: AdapterId.make(id),
    protocolVersion,
    capabilities: { feedbackTools: true },
  }),
  discoverModels: () => Effect.never,
  generate: () => Effect.die('not called'),
  continue: () => Effect.die('not called'),
})

const waitForCatalog = (
  registry: CapabilityRegistryInterface,
  predicate: (catalog: ModelCatalogSnapshot) => boolean,
) =>
  registry.modelCatalogChanges.pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die('Expected the live model catalog stream to remain open'),
        onSome: Effect.succeed,
      }),
    ),
  )

const makeContextProvider = (id: string, minor = 1): ContextProvider =>
  ContextProvider.make({
    id: ContextProviderId.make(id),
    protocolVersion: { major: 0, minor },
    description: 'Test context provider',
    maxTokens: TokenLimit.make(128),
    maxDurationMs: CapabilityDurationMilliseconds.make(250),
    isAvailable: () => true,
    provide: () => Effect.succeed(Option.none()),
  })

const makeActionTool = (id: string, minor = 1): ActionTool =>
  ActionTool.make({
    id: ActionToolId.make(id),
    protocolVersion: { major: 0, minor },
    description: 'Test action tool',
    xmlTemplate: ActionToolXmlTemplate.make(
      `<action tool="${id}"><value>XML_ESCAPED_VALUE</value></action>`,
    ),
    inputSchema: {
      _tag: 'Object',
      properties: [
        {
          name: 'value',
          required: true,
          schema: { _tag: 'String' },
        },
      ],
    },
    executionStage: 'after-send',
    completionPolicy: 'none',
    failurePolicy: 'continue',
    maxDurationMs: ActionToolDurationMilliseconds.make(250),
    isAvailable: () => true,
    isInputAllowed: () => true,
    execute: () => Effect.void,
  })

const makeFeedbackTool = (id: string): FeedbackTool =>
  FeedbackTool.make({
    id: FeedbackToolId.make(id),
    protocolVersion: VERSION,
    description: 'Test feedback tool',
    inputSchema: { _tag: 'Object', properties: [] },
    outputSchema: { _tag: 'Object', properties: [] },
    maxResultTokens: TokenLimit.make(128),
    maxDurationMs: CapabilityDurationMilliseconds.make(250),
    isAvailable: () => true,
    prepare: () => Effect.succeed({ execute: () => Effect.succeed(null) }),
  })

const makeConnectedMcpSnapshot = (
  serverId: string,
  revision: number,
  actionToolNames: ReadonlyArray<string>,
  feedbackToolNames: ReadonlyArray<string>,
) =>
  Schema.decodeUnknownEffect(McpServerSnapshot)({
    _tag: 'Connected',
    serverId,
    revision,
    projections: [
      ...actionToolNames.map((name) => ({
        _tag: 'Action',
        name,
        tool: makeActionTool(`${serverId}.${name}`),
      })),
      ...feedbackToolNames.map((name) => ({
        _tag: 'Feedback',
        name,
        tool: makeFeedbackTool(`${serverId}.${name}`),
      })),
    ],
  })

const makeDisconnectedMcpSnapshot = (serverId: string, revision: number) =>
  Schema.decodeUnknownEffect(McpServerSnapshot)({
    _tag: 'Disconnected',
    serverId,
    revision,
  })

it.effect('keeps capability IDs unique within domains and isolated across domains', () =>
  Effect.gen(function* () {
    const registry = yield* CapabilityRegistry.Service

    const adapterRegistration = yield* registry.registerAdapter(makeAdapter('shared'))
    const contextRegistration = yield* registry.registerContextProvider(
      makeContextProvider('shared'),
    )
    const actionRegistration = yield* registry.registerActionTool(makeActionTool('shared'))
    const feedbackRegistration = yield* registry.registerFeedbackTool(makeFeedbackTool('shared'))
    const skillRegistration = yield* registry.registerSkill(
      Skill.make({
        id: SkillId.make('shared'),
        protocolVersion: VERSION,
        description: 'Shared test skill',
        prompt: 'Use the shared test skill.',
        selection: { _tag: 'Always' },
        contextProviders: [],
        actionTools: [],
        feedbackTools: [],
      }),
    )
    const mcpRegistration = yield* registry.registerMcpServer(
      McpServer.make({ id: McpServerId.make('shared'), protocolVersion: VERSION }),
    )
    const presetRegistration = yield* registry.registerPresetSource(
      PresetSource.make({ id: PresetSourceId.make('shared'), protocolVersion: VERSION }),
    )
    const responseRegistration = yield* registry.registerResponseMechanism(
      ResponseMechanism.make({
        id: ResponseMechanismId.make('shared'),
        protocolVersion: VERSION,
      }),
    )

    const adapterConflict = yield* registry.registerAdapter(makeAdapter('shared')).pipe(Effect.flip)
    const contextConflict = yield* registry
      .registerContextProvider(makeContextProvider('shared'))
      .pipe(Effect.flip)
    const actionConflict = yield* registry
      .registerActionTool(makeActionTool('shared'))
      .pipe(Effect.flip)
    const feedbackConflict = yield* registry
      .registerFeedbackTool(makeFeedbackTool('shared'))
      .pipe(Effect.flip)

    expect(adapterConflict).toMatchObject({ domain: 'adapter', id: 'shared' })
    expect(contextConflict).toMatchObject({ domain: 'context-provider', id: 'shared' })
    expect(actionConflict).toMatchObject({ domain: 'action-tool', id: 'shared' })
    expect(feedbackConflict).toMatchObject({ domain: 'feedback-tool', id: 'shared' })

    const snapshot = yield* registry.snapshot()
    expect(snapshot.revision).toBe(8)
    expect(snapshot.adapters).toHaveLength(1)
    expect(snapshot.contextProviders).toHaveLength(1)
    expect(snapshot.actionTools).toHaveLength(1)
    expect(snapshot.feedbackTools).toHaveLength(1)
    expect(snapshot.skills).toHaveLength(1)
    expect(snapshot.mcpServers).toHaveLength(1)
    expect(snapshot.presetSources).toHaveLength(1)
    expect(snapshot.responseMechanisms).toHaveLength(1)

    expect(yield* adapterRegistration.unregister()).toBe(true)
    expect(yield* contextRegistration.unregister()).toBe(true)
    expect(yield* actionRegistration.unregister()).toBe(true)
    expect(yield* feedbackRegistration.unregister()).toBe(true)
    expect(yield* skillRegistration.unregister()).toBe(true)
    expect(yield* mcpRegistration.unregister()).toBe(true)
    expect(yield* presetRegistration.unregister()).toBe(true)
    expect(yield* responseRegistration.unregister()).toBe(true)

    const empty = yield* registry.snapshot()
    expect(empty.revision).toBe(16)
    expect(empty.adapters).toEqual([])
    expect(empty.contextProviders).toEqual([])
    expect(empty.actionTools).toEqual([])
    expect(empty.feedbackTools).toEqual([])
    expect(empty.skills).toEqual([])
    expect(empty.mcpServers).toEqual([])
    expect(empty.presetSources).toEqual([])
    expect(empty.responseMechanisms).toEqual([])
  }).pipe(Effect.provide(CapabilityRegistry.layer)),
)

it.effect('admits exactly one of two concurrent same-domain registrations', () =>
  Effect.gen(function* () {
    const registry = yield* CapabilityRegistry.Service
    const outcomes = yield* Effect.all(
      [
        registry.registerActionTool(makeActionTool('concurrent', 1)).pipe(Effect.result),
        registry.registerActionTool(makeActionTool('concurrent', 2)).pipe(Effect.result),
      ],
      { concurrency: 'unbounded' },
    )

    expect(outcomes.filter(Result.isSuccess)).toHaveLength(1)
    expect(outcomes.filter(Result.isFailure)).toHaveLength(1)
    expect((yield* registry.snapshot()).actionTools).toHaveLength(1)
  }).pipe(Effect.provide(CapabilityRegistry.layer)),
)

it.effect('rejects an invalid ActionTool template without poisoning other registrations', () =>
  Effect.gen(function* () {
    const registry = yield* CapabilityRegistry.Service
    const invalid = {
      ...makeActionTool('invalid-template'),
      xmlTemplate: ActionToolXmlTemplate.make(
        '<action tool="different-id"><value>XML_ESCAPED_VALUE</value></action>',
      ),
    }

    const failure = yield* registry.registerActionTool(invalid).pipe(Effect.flip)
    expect(failure).toMatchObject({
      _tag: 'RoleResponseEnvelopeCompileError',
      reason: 'template-tool-mismatch',
      toolId: 'invalid-template',
    })
    expect((yield* registry.snapshot()).revision).toBe(0)

    yield* registry.registerActionTool(makeActionTool('valid-template'))
    const snapshot = yield* registry.snapshot()
    expect(snapshot.revision).toBe(1)
    expect(snapshot.actionTools.map((tool) => tool.id)).toEqual(['valid-template'])
  }).pipe(Effect.provide(CapabilityRegistry.layer)),
)

it.effect('validates FeedbackTools at the public registration boundary', () =>
  Effect.gen(function* () {
    const registry = yield* CapabilityRegistry.Service
    const invalid = {
      ...makeFeedbackTool('invalid-feedback'),
      description: 'x'.repeat(MAX_FEEDBACK_TOOL_DESCRIPTION_LENGTH + 1),
    }

    const failure = yield* registry.registerFeedbackTool(invalid).pipe(Effect.flip)

    expect(failure).toMatchObject({
      _tag: 'CapabilityRegistrationValidationError',
      domain: 'feedback-tool',
      id: 'invalid-feedback',
    })
    expect((yield* registry.snapshot()).revision).toBe(0)
  }).pipe(Effect.provide(CapabilityRegistry.layer)),
)

it.effect('validates and detaches Skills at the public registration boundary', () =>
  Effect.gen(function* () {
    const registry = yield* CapabilityRegistry.Service
    const invalid = Skill.make({
      id: SkillId.make('invalid-skill'),
      protocolVersion: VERSION,
      description: 'A Skill mutated by an untyped runtime caller.',
      prompt: 'Initially valid.',
      selection: { _tag: 'Always' },
      contextProviders: [],
      actionTools: [],
      feedbackTools: [],
    })
    Object.defineProperty(invalid, 'prompt', { value: '', enumerable: true })

    const failure = yield* registry.registerSkill(invalid).pipe(Effect.flip)
    expect(failure).toMatchObject({
      _tag: 'CapabilityRegistrationValidationError',
      domain: 'skill',
      id: 'invalid-skill',
    })
    expect((yield* registry.snapshot()).revision).toBe(0)

    const actionTools: ActionToolId[] = []
    const valid = Skill.make({
      id: SkillId.make('detached-skill'),
      protocolVersion: VERSION,
      description: 'A valid detached Skill.',
      prompt: 'Keep the registered snapshot stable.',
      selection: { _tag: 'Always' },
      contextProviders: [],
      actionTools,
      feedbackTools: [],
    })
    yield* registry.registerSkill(valid)
    actionTools.push(ActionToolId.make('late.action'))

    const snapshot = yield* registry.snapshot()
    const registered = snapshot.skills[0]
    if (registered === undefined) return yield* Effect.die('Expected a registered Skill')
    expect(registered.actionTools).toEqual([])
  }).pipe(Effect.provide(CapabilityRegistry.layer)),
)

it.effect('keeps old turn snapshots stable and makes stale unregister handles harmless', () =>
  Effect.gen(function* () {
    const registry = yield* CapabilityRegistry.Service
    const first = yield* registry.registerContextProvider(makeContextProvider('history', 1))
    const oldTurn = yield* registry.snapshot()

    expect(yield* first.unregister()).toBe(true)
    expect((yield* registry.snapshot()).contextProviders).toEqual([])

    const replacement = yield* registry.registerContextProvider(makeContextProvider('history', 2))
    expect(yield* first.unregister()).toBe(false)

    const newTurn = yield* registry.snapshot()
    expect(oldTurn.revision).toBe(1)
    expect(oldTurn.contextProviders[0]).toMatchObject({ protocolVersion: { minor: 1 } })
    expect(newTurn.revision).toBe(3)
    expect(newTurn.contextProviders[0]).toMatchObject({ protocolVersion: { minor: 2 } })
    expect(yield* replacement.unregister()).toBe(true)
    expect(oldTurn.contextProviders).toHaveLength(1)
  }).pipe(Effect.provide(CapabilityRegistry.layer)),
)

it.effect('publishes one validated MCP snapshot into flat Tool domains and source metadata', () =>
  Effect.gen(function* () {
    const registry = yield* CapabilityRegistry.Service
    const registration = yield* registry.registerMcpServer(
      McpServer.make({ id: McpServerId.make('calendar'), protocolVersion: VERSION }),
    )
    const connected = yield* makeConnectedMcpSnapshot('calendar', 0, ['create'], ['lookup'])

    expect(yield* registration.publishSnapshot(connected)).toBe(true)
    const snapshot = yield* registry.snapshot()
    expect(snapshot.revision).toBe(2)
    expect(snapshot.actionTools.map((tool) => tool.id)).toEqual(['calendar.create'])
    expect(snapshot.feedbackTools.map((tool) => tool.id)).toEqual(['calendar.lookup'])
    expect(snapshot.mcpProjectionSources).toEqual([
      {
        serverId: 'calendar',
        actionToolIds: ['calendar.create'],
        feedbackToolIds: ['calendar.lookup'],
      },
    ])

    const replacement = yield* makeConnectedMcpSnapshot('calendar', 1, [], ['replace'])
    expect(yield* registration.publishSnapshot(replacement)).toBe(true)
    const replaced = yield* registry.snapshot()
    expect(replaced.revision).toBe(3)
    expect(replaced.actionTools).toEqual([])
    expect(replaced.feedbackTools.map((tool) => tool.id)).toEqual(['calendar.replace'])
    expect(snapshot.actionTools.map((tool) => tool.id)).toEqual(['calendar.create'])
    expect(snapshot.feedbackTools.map((tool) => tool.id)).toEqual(['calendar.lookup'])

    const stale = yield* makeConnectedMcpSnapshot('calendar', 1, ['stale'], [])
    expect(yield* registration.publishSnapshot(stale)).toBe(false)
    expect((yield* registry.snapshot()).revision).toBe(3)

    const wrongServer = yield* makeConnectedMcpSnapshot('other', 2, ['create'], [])
    const failure = yield* registration.publishSnapshot(wrongServer).pipe(Effect.flip)
    expect(failure).toMatchObject({
      _tag: 'CapabilityRegistrationValidationError',
      domain: 'mcp-server',
      id: 'calendar',
    })
    expect((yield* registry.snapshot()).actionTools).toEqual([])
    expect((yield* registry.snapshot()).feedbackTools.map((tool) => tool.id)).toEqual([
      'calendar.replace',
    ])
  }).pipe(Effect.provide(CapabilityRegistry.layer)),
)

it.effect('disconnects and reconnects only one MCP source while old turns stay frozen', () =>
  Effect.gen(function* () {
    const registry = yield* CapabilityRegistry.Service
    const calendar = yield* registry.registerMcpServer(
      McpServer.make({ id: McpServerId.make('calendar'), protocolVersion: VERSION }),
    )
    const search = yield* registry.registerMcpServer(
      McpServer.make({ id: McpServerId.make('search'), protocolVersion: VERSION }),
    )
    yield* calendar.publishSnapshot(yield* makeConnectedMcpSnapshot('calendar', 0, ['create'], []))
    yield* search.publishSnapshot(yield* makeConnectedMcpSnapshot('search', 0, [], ['query']))
    const oldTurn = yield* registry.snapshot()

    expect(yield* calendar.publishSnapshot(yield* makeDisconnectedMcpSnapshot('calendar', 1))).toBe(
      true,
    )
    const disconnected = yield* registry.snapshot()
    expect(disconnected.actionTools).toEqual([])
    expect(disconnected.feedbackTools.map((tool) => tool.id)).toEqual(['search.query'])
    expect(disconnected.mcpProjectionSources.map((source) => source.serverId)).toEqual(['search'])
    expect(oldTurn.actionTools.map((tool) => tool.id)).toEqual(['calendar.create'])
    expect(oldTurn.mcpProjectionSources.map((source) => source.serverId)).toEqual([
      'calendar',
      'search',
    ])

    const equalRevision = yield* makeConnectedMcpSnapshot('calendar', 1, ['stale'], [])
    expect(yield* calendar.publishSnapshot(equalRevision)).toBe(false)
    const reconnected = yield* makeConnectedMcpSnapshot('calendar', 2, [], ['lookup'])
    expect(yield* calendar.publishSnapshot(reconnected)).toBe(true)
    const current = yield* registry.snapshot()
    expect(current.feedbackTools.map((tool) => tool.id)).toEqual([
      'calendar.lookup',
      'search.query',
    ])

    expect(yield* calendar.unregister()).toBe(true)
    expect(yield* calendar.publishSnapshot(yield* makeDisconnectedMcpSnapshot('calendar', 3))).toBe(
      false,
    )
    const afterUnregister = yield* registry.snapshot()
    expect(afterUnregister.feedbackTools.map((tool) => tool.id)).toEqual(['search.query'])
    expect(afterUnregister.mcpServers.map((server) => server.id)).toEqual(['search'])
  }).pipe(Effect.provide(CapabilityRegistry.layer)),
)

it.effect('rejects MCP projection conflicts and invalid XML without partial replacement', () =>
  Effect.gen(function* () {
    const registry = yield* CapabilityRegistry.Service
    const native = yield* registry.registerActionTool(makeActionTool('calendar.create'))
    const calendar = yield* registry.registerMcpServer(
      McpServer.make({ id: McpServerId.make('calendar'), protocolVersion: VERSION }),
    )
    const conflicting = yield* makeConnectedMcpSnapshot('calendar', 0, ['create'], ['lookup'])

    const conflict = yield* calendar.publishSnapshot(conflicting).pipe(Effect.flip)
    expect(conflict).toMatchObject({
      _tag: 'CapabilityConflictError',
      domain: 'action-tool',
      id: 'calendar.create',
    })
    expect((yield* registry.snapshot()).feedbackTools).toEqual([])

    expect(yield* native.unregister()).toBe(true)
    expect(yield* calendar.publishSnapshot(conflicting)).toBe(true)
    const directConflict = yield* registry
      .registerFeedbackTool(makeFeedbackTool('calendar.lookup'))
      .pipe(Effect.flip)
    expect(directConflict).toMatchObject({
      _tag: 'CapabilityConflictError',
      domain: 'feedback-tool',
      id: 'calendar.lookup',
    })

    const calendarSub = yield* registry.registerMcpServer(
      McpServer.make({ id: McpServerId.make('calendar.sub'), protocolVersion: VERSION }),
    )
    yield* calendarSub.publishSnapshot(
      yield* makeConnectedMcpSnapshot('calendar.sub', 0, ['create'], []),
    )
    const crossServerCandidate = yield* makeConnectedMcpSnapshot(
      'calendar',
      1,
      ['sub.create'],
      ['other'],
    )
    const crossServerConflict = yield* calendar
      .publishSnapshot(crossServerCandidate)
      .pipe(Effect.flip)
    expect(crossServerConflict).toMatchObject({
      _tag: 'CapabilityConflictError',
      domain: 'action-tool',
      id: 'calendar.sub.create',
    })
    expect((yield* registry.snapshot()).feedbackTools.map((tool) => tool.id)).toEqual([
      'calendar.lookup',
    ])

    const invalidXml = yield* Schema.decodeUnknownEffect(McpServerSnapshot)({
      _tag: 'Connected',
      serverId: 'calendar',
      revision: 1,
      projections: [
        {
          _tag: 'Action',
          name: 'replace',
          tool: {
            ...makeActionTool('calendar.replace'),
            xmlTemplate: '<action tool="different"><value>XML_ESCAPED_VALUE</value></action>',
          },
        },
        {
          _tag: 'Feedback',
          name: 'other',
          tool: makeFeedbackTool('calendar.other'),
        },
      ],
    })
    const compileFailure = yield* calendar.publishSnapshot(invalidXml).pipe(Effect.flip)
    expect(compileFailure).toMatchObject({
      _tag: 'RoleResponseEnvelopeCompileError',
      reason: 'template-tool-mismatch',
      toolId: 'calendar.replace',
    })
    const unchanged = yield* registry.snapshot()
    expect(unchanged.actionTools.map((tool) => tool.id)).toEqual([
      'calendar.create',
      'calendar.sub.create',
    ])
    expect(unchanged.feedbackTools.map((tool) => tool.id)).toEqual(['calendar.lookup'])
  }).pipe(Effect.provide(CapabilityRegistry.layer)),
)

it.effect('rejects incompatible adapters without changing registry state', () =>
  Effect.gen(function* () {
    const registry = yield* CapabilityRegistry.Service
    const incompatible = makeAdapter('future', { major: 1, minor: 0 })

    const failure = yield* registry.registerAdapter(incompatible).pipe(Effect.flip)

    expect(failure._tag).toBe('AdapterProtocolVersionMismatchError')
    const snapshot = yield* registry.snapshot()
    expect(snapshot.revision).toBe(0)
    expect(snapshot.adapters).toEqual([])
  }).pipe(Effect.provide(CapabilityRegistry.layer)),
)

it.effect('publishes atomic monotonic model catalogs and ignores stale adapter generations', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* CapabilityRegistry.Service
      const zeta = yield* registry.registerAdapter(makeAdapter('zeta'))
      const alpha = yield* registry.registerAdapter(makeAdapter('alpha'))
      const ready = yield* Deferred.make<void>()
      const catalogsFiber = yield* registry.modelCatalogChanges.pipe(
        Stream.tap(() => Deferred.succeed(ready, undefined)),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkScoped,
      )
      yield* Deferred.await(ready)

      const zetaSnapshot = yield* Schema.decodeUnknownEffect(AdapterModelSnapshot)({
        discoveredAt: '2026-08-22T00:00:00.000Z',
        models: [
          {
            id: 'z-model',
            displayName: 'Zeta',
            availability: 'available',
            discoveryFreshness: 'fresh',
          },
        ],
      })
      const alphaSnapshot = yield* Schema.decodeUnknownEffect(AdapterModelSnapshot)({
        discoveredAt: '2026-08-22T00:00:01.000Z',
        models: [
          {
            id: 'a-model',
            displayName: 'Alpha',
            availability: 'available',
            discoveryFreshness: 'fresh',
          },
        ],
      })
      const unchangedAlphaSnapshot = yield* Schema.decodeUnknownEffect(AdapterModelSnapshot)({
        discoveredAt: '2026-08-22T00:00:02.000Z',
        models: alphaSnapshot.models,
      })
      const replacementAlphaSnapshot = yield* Schema.decodeUnknownEffect(AdapterModelSnapshot)({
        discoveredAt: '2026-08-22T00:00:03.000Z',
        models: [
          {
            id: 'b-model',
            displayName: 'Alpha replacement',
            availability: 'available',
            discoveryFreshness: 'fresh',
          },
        ],
      })

      expect(yield* zeta.publishModels(zetaSnapshot)).toBe(true)
      expect(yield* alpha.publishModels(alphaSnapshot)).toBe(true)
      expect(yield* alpha.publishModels(unchangedAlphaSnapshot)).toBe(true)
      expect(yield* alpha.publishModels(replacementAlphaSnapshot)).toBe(true)

      const catalogs = Array.from(yield* Fiber.join(catalogsFiber))
      expect(catalogs.map((catalog) => catalog.revision)).toEqual([2, 3, 4, 5])
      const mergedCatalog = catalogs[2]
      if (mergedCatalog === undefined) return yield* Effect.die('Expected merged model catalog')
      expect(
        mergedCatalog.models.map(
          (model) => model.reference.adapterId + '/' + model.reference.modelId,
        ),
      ).toEqual(['alpha/a-model', 'zeta/z-model'])
      expect(mergedCatalog.models.map((model) => model.displayName)).toEqual(['Alpha', 'Zeta'])

      const oldTurn = yield* registry.snapshot()
      expect(yield* zeta.unregister()).toBe(true)
      const current = yield* registry.modelCatalog()
      expect(current.revision).toBe(6)
      expect(
        current.models.map((model) => model.reference.adapterId + '/' + model.reference.modelId),
      ).toEqual(['alpha/b-model'])
      expect(yield* zeta.publishModels(zetaSnapshot)).toBe(false)
      expect((yield* registry.modelCatalog()).revision).toBe(6)
      expect(oldTurn.adapters.map((adapter) => adapter.descriptor.id)).toEqual(['zeta', 'alpha'])
      expect(oldTurn.modelCatalog.revision).toBe(5)
    }).pipe(Effect.provide(CapabilityRegistry.layer)),
  ),
)

it.effect('discovers on registration and retains the last successful snapshot as stale', () =>
  Effect.gen(function* () {
    const registry = yield* CapabilityRegistry.Service
    const adapterId = AdapterId.make('live-discovery')
    const snapshot = yield* Schema.decodeUnknownEffect(AdapterModelSnapshot)({
      discoveredAt: '2026-08-24T00:00:00.000Z',
      models: [
        {
          id: 'model-a',
          displayName: 'Model A',
          availability: 'available',
          discoveryFreshness: 'fresh',
        },
      ],
    })
    const calls = yield* Ref.make(0)
    const adapter: YokaiAdapter = {
      ...makeAdapter(adapterId),
      discoverModels: () =>
        Ref.getAndUpdate(calls, (count) => count + 1).pipe(
          Effect.flatMap((count) =>
            count === 0
              ? Effect.succeed(snapshot)
              : Effect.fail(
                  new AdapterTransportError({
                    adapterId,
                    operation: 'discoverModels',
                    message: 'Discovery transport unavailable',
                  }),
                ),
          ),
        ),
    }

    yield* registry.registerAdapter(adapter)
    const ready = yield* waitForCatalog(registry, (catalog) =>
      catalog.adapters.some((entry) => entry.id === adapterId && entry.status === 'ready'),
    )
    expect(ready.models.map((model) => model.displayName)).toEqual(['Model A'])

    expect(yield* registry.refreshModels(Option.some(adapterId))).toBe(1)
    const stale = yield* waitForCatalog(registry, (catalog) =>
      catalog.adapters.some((entry) => entry.id === adapterId && entry.status === 'stale'),
    )
    expect(stale.models.map((model) => model.displayName)).toEqual(['Model A'])
    expect(yield* Ref.get(calls)).toBe(2)

    const failedId = AdapterId.make('never-discovered')
    yield* registry.registerAdapter({
      ...makeAdapter(failedId),
      discoverModels: () =>
        Effect.fail(
          new AdapterTransportError({
            adapterId: failedId,
            operation: 'discoverModels',
            message: 'Initial discovery unavailable',
          }),
        ),
    })
    const failed = yield* waitForCatalog(registry, (catalog) =>
      catalog.adapters.some((entry) => entry.id === failedId && entry.status === 'failed'),
    )
    expect(failed.models.some((model) => model.reference.adapterId === failedId)).toBe(false)
  }).pipe(Effect.provide(CapabilityRegistry.layer)),
)

it.effect('replaces older discovery fibers before a newer refresh can publish', () =>
  Effect.gen(function* () {
    const registry = yield* CapabilityRegistry.Service
    const adapterId = AdapterId.make('refresh-race')
    const firstStarted = yield* Deferred.make<void>()
    const firstInterrupted = yield* Deferred.make<void>()
    const secondStarted = yield* Deferred.make<void>()
    const secondInterrupted = yield* Deferred.make<void>()
    const calls = yield* Ref.make(0)
    const newest = yield* Schema.decodeUnknownEffect(AdapterModelSnapshot)({
      discoveredAt: '2026-08-24T00:00:02.000Z',
      models: [
        {
          id: 'newest',
          displayName: 'Newest',
          availability: 'available',
          discoveryFreshness: 'fresh',
        },
      ],
    })
    const blockedDiscovery = (
      started: Deferred.Deferred<void>,
      interrupted: Deferred.Deferred<void>,
    ) =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      )
    const adapter: YokaiAdapter = {
      ...makeAdapter(adapterId),
      discoverModels: () =>
        Ref.getAndUpdate(calls, (count) => count + 1).pipe(
          Effect.flatMap((count) => {
            if (count === 0) return blockedDiscovery(firstStarted, firstInterrupted)
            if (count === 1) return blockedDiscovery(secondStarted, secondInterrupted)
            return Effect.succeed(newest)
          }),
        ),
    }

    yield* registry.registerAdapter(adapter)
    yield* Deferred.await(firstStarted)
    expect(yield* registry.refreshModels(Option.some(adapterId))).toBe(1)
    yield* Deferred.await(firstInterrupted)
    yield* Deferred.await(secondStarted)
    expect(yield* registry.refreshModels(Option.some(adapterId))).toBe(1)
    yield* Deferred.await(secondInterrupted)

    const ready = yield* waitForCatalog(registry, (catalog) =>
      catalog.models.some((model) => model.displayName === 'Newest'),
    )
    expect(ready.models.map((model) => model.displayName)).toEqual(['Newest'])
    expect(yield* Ref.get(calls)).toBe(3)
  }).pipe(Effect.provide(CapabilityRegistry.layer)),
)

it.effect('resolves only the selected model and recovers when it becomes available', () =>
  Effect.gen(function* () {
    const registry = yield* CapabilityRegistry.Service
    const registration = yield* registry.registerAdapter(makeAdapter('model-selection'))
    const unavailableSnapshot = yield* Schema.decodeUnknownEffect(AdapterModelSnapshot)({
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
    yield* registration.publishModels(unavailableSnapshot)

    const selectedReference = yield* Schema.decodeUnknownEffect(ModelReference)(
      'model-selection/selected',
    )
    const unavailable = yield* registry.resolveModel(selectedReference).pipe(Effect.flip)
    expect(unavailable).toMatchObject({
      _tag: 'ModelSelectionUnavailableError',
      reference: selectedReference,
    })

    const recoveredSnapshot = yield* Schema.decodeUnknownEffect(AdapterModelSnapshot)({
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
          displayName: 'Selected renamed',
          availability: 'available',
          discoveryFreshness: 'fresh',
        },
      ],
    })
    yield* registration.publishModels(recoveredSnapshot)
    expect((yield* registry.resolveModel(selectedReference)).reference).toEqual(selectedReference)
  }).pipe(Effect.provide(CapabilityRegistry.layer)),
)
