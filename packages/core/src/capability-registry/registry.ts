import {
  AdapterId,
  type AdapterModelSnapshot,
  type AdapterProtocolVersionMismatchError,
  type DiscoveredModel,
  ModelReference,
  type YokaiAdapter,
  negotiateAdapterProtocol,
} from 'yokai-protocol'
import { RoleResponseEnvelope } from '@yokai-internal/mind'
import { Context, Effect, FiberMap, Layer, Option, Schema, Stream, SubscriptionRef } from 'effect'

import {
  type ActionTool,
  type ContextProvider,
  type FeedbackTool,
  type McpServer,
  type PresetSource,
  type ResponseMechanism,
  type Skill,
} from './capability'
import {
  type AdapterDiscoveryStatus,
  CatalogAdapter,
  CatalogModel,
  type ModelCatalogSnapshot,
  ModelCatalogRevision,
  modelCatalogContentEqual,
  ModelCatalogSnapshot as ModelCatalogSnapshotSchema,
} from './model-catalog'

export const CapabilityDomain = Schema.Literals([
  'adapter',
  'context-provider',
  'action-tool',
  'feedback-tool',
  'skill',
  'mcp-server',
  'preset-source',
  'response-mechanism',
])

export type CapabilityDomain = typeof CapabilityDomain.Type

export class CapabilityConflictError extends Schema.TaggedError<CapabilityConflictError>(
  '@yokai/core/CapabilityConflictError',
)('CapabilityConflictError', {
  domain: CapabilityDomain,
  id: Schema.String,
}) {}

export class AdapterNotFoundError extends Schema.TaggedError<AdapterNotFoundError>(
  '@yokai/core/AdapterNotFoundError',
)('AdapterNotFoundError', {
  adapterId: Schema.optionalKey(AdapterId),
}) {}

export class ModelSelectionUnavailableError extends Schema.TaggedError<ModelSelectionUnavailableError>(
  '@yokai/core/ModelSelectionUnavailableError',
)('ModelSelectionUnavailableError', {
  reference: Schema.optionalKey(ModelReference),
}) {}

export const CapabilityRegistryRevision = Schema.Natural.pipe(
  Schema.brand('@yokai/core/CapabilityRegistryRevision'),
)

export type CapabilityRegistryRevision = typeof CapabilityRegistryRevision.Type

export interface CapabilityRegistration {
  readonly unregister: () => Effect.Effect<boolean>
}

export interface AdapterRegistration extends CapabilityRegistration {
  /** Returns false when this registration generation is no longer current. */
  readonly publishModels: (snapshot: AdapterModelSnapshot) => Effect.Effect<boolean>
}

export interface TurnCapabilitySnapshot {
  readonly revision: CapabilityRegistryRevision
  readonly adapters: ReadonlyArray<YokaiAdapter>
  readonly contextProviders: ReadonlyArray<ContextProvider>
  readonly actionTools: ReadonlyArray<ActionTool>
  readonly feedbackTools: ReadonlyArray<FeedbackTool>
  readonly skills: ReadonlyArray<Skill>
  readonly mcpServers: ReadonlyArray<McpServer>
  readonly presetSources: ReadonlyArray<PresetSource>
  readonly responseMechanisms: ReadonlyArray<ResponseMechanism>
  readonly modelCatalog: ModelCatalogSnapshot
}

export interface ResolvedModel {
  readonly adapter: YokaiAdapter
  readonly reference: ModelReference
  readonly model: CatalogModel
}

export interface Interface {
  readonly registerAdapter: (
    adapter: YokaiAdapter,
  ) => Effect.Effect<
    AdapterRegistration,
    CapabilityConflictError | AdapterProtocolVersionMismatchError
  >
  readonly registerContextProvider: (
    capability: ContextProvider,
  ) => Effect.Effect<CapabilityRegistration, CapabilityConflictError>
  readonly registerActionTool: (
    capability: ActionTool,
  ) => Effect.Effect<
    CapabilityRegistration,
    CapabilityConflictError | RoleResponseEnvelope.CompileError
  >
  readonly registerFeedbackTool: (
    capability: FeedbackTool,
  ) => Effect.Effect<CapabilityRegistration, CapabilityConflictError>
  readonly registerSkill: (
    capability: Skill,
  ) => Effect.Effect<CapabilityRegistration, CapabilityConflictError>
  readonly registerMcpServer: (
    capability: McpServer,
  ) => Effect.Effect<CapabilityRegistration, CapabilityConflictError>
  readonly registerPresetSource: (
    capability: PresetSource,
  ) => Effect.Effect<CapabilityRegistration, CapabilityConflictError>
  readonly registerResponseMechanism: (
    capability: ResponseMechanism,
  ) => Effect.Effect<CapabilityRegistration, CapabilityConflictError>
  readonly snapshot: () => Effect.Effect<TurnCapabilitySnapshot>
  readonly changes: Stream.Stream<TurnCapabilitySnapshot>
  readonly modelCatalog: () => Effect.Effect<ModelCatalogSnapshot>
  readonly modelCatalogChanges: Stream.Stream<ModelCatalogSnapshot>
  readonly refreshModels: (
    adapterId: Option.Option<AdapterId>,
  ) => Effect.Effect<number, AdapterNotFoundError>
  readonly resolveModel: (
    reference: ModelReference,
  ) => Effect.Effect<ResolvedModel, ModelSelectionUnavailableError>
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/core/CapabilityRegistry',
) {}

interface Registered<A> {
  readonly key: number
  readonly value: A
}

interface RegisteredAdapterModels {
  readonly key: number
  readonly adapterId: AdapterId
  readonly request: number
  readonly status: AdapterDiscoveryStatus
  readonly snapshot: Option.Option<AdapterModelSnapshot>
}

interface RegistryState {
  readonly revision: CapabilityRegistryRevision
  readonly nextRegistrationKey: number
  readonly adapters: ReadonlyArray<Registered<YokaiAdapter>>
  readonly contextProviders: ReadonlyArray<Registered<ContextProvider>>
  readonly actionTools: ReadonlyArray<Registered<ActionTool>>
  readonly feedbackTools: ReadonlyArray<Registered<FeedbackTool>>
  readonly skills: ReadonlyArray<Registered<Skill>>
  readonly mcpServers: ReadonlyArray<Registered<McpServer>>
  readonly presetSources: ReadonlyArray<Registered<PresetSource>>
  readonly responseMechanisms: ReadonlyArray<Registered<ResponseMechanism>>
  readonly adapterModels: ReadonlyArray<RegisteredAdapterModels>
  readonly modelCatalog: ModelCatalogSnapshot
}

const initialState = (): RegistryState => ({
  revision: CapabilityRegistryRevision.make(0),
  nextRegistrationKey: 1,
  adapters: [],
  contextProviders: [],
  actionTools: [],
  feedbackTools: [],
  skills: [],
  mcpServers: [],
  presetSources: [],
  responseMechanisms: [],
  adapterModels: [],
  modelCatalog: ModelCatalogSnapshotSchema.make({
    revision: ModelCatalogRevision.make(0),
    adapters: [],
    models: [],
  }),
})

const nextRegistryRevision = (revision: CapabilityRegistryRevision): CapabilityRegistryRevision =>
  CapabilityRegistryRevision.make(revision + 1)

const nextCatalogRevision = (revision: ModelCatalogRevision): ModelCatalogRevision =>
  ModelCatalogRevision.make(revision + 1)

const optionalField = <K extends string, A>(
  key: K,
  value: A | undefined,
): {} | { readonly [P in K]: A } => (value === undefined ? {} : { [key]: value })

const toCatalogModel = (adapterId: AdapterId, model: DiscoveredModel): CatalogModel =>
  CatalogModel.make({
    reference: ModelReference.make({ adapterId, modelId: model.id }),
    displayName: model.displayName,
    availability: model.availability,
    discoveryFreshness: model.discoveryFreshness,
    ...optionalField('inputTokenLimit', model.inputTokenLimit),
    ...optionalField('outputTokenLimit', model.outputTokenLimit),
    ...optionalField('supportedGenerationMethods', model.supportedGenerationMethods),
  })

const modelReferenceKey = (model: CatalogModel): string =>
  model.reference.adapterId + '/' + model.reference.modelId

const compareCatalogModels = (left: CatalogModel, right: CatalogModel): number => {
  const leftKey = modelReferenceKey(left)
  const rightKey = modelReferenceKey(right)
  if (leftKey < rightKey) return -1
  if (leftKey > rightKey) return 1
  return 0
}

const compareCatalogAdapters = (left: CatalogAdapter, right: CatalogAdapter): number => {
  if (left.id < right.id) return -1
  if (left.id > right.id) return 1
  return 0
}

const mergeAdapterStatuses = (
  contributions: ReadonlyArray<RegisteredAdapterModels>,
): ReadonlyArray<CatalogAdapter> =>
  contributions
    .map((contribution) =>
      CatalogAdapter.make({ id: contribution.adapterId, status: contribution.status }),
    )
    .sort(compareCatalogAdapters)

const mergeAdapterModels = (
  contributions: ReadonlyArray<RegisteredAdapterModels>,
): ReadonlyArray<CatalogModel> =>
  contributions
    .flatMap((contribution): ReadonlyArray<CatalogModel> =>
      Option.match(contribution.snapshot, {
        onNone: () => [],
        onSome: (snapshot) =>
          snapshot.models.map((model) => toCatalogModel(contribution.adapterId, model)),
      }),
    )
    .sort(compareCatalogModels)

const withCatalogContent = (
  current: ModelCatalogSnapshot,
  adapters: ReadonlyArray<CatalogAdapter>,
  models: ReadonlyArray<CatalogModel>,
): ModelCatalogSnapshot =>
  modelCatalogContentEqual(current.adapters, current.models, adapters, models)
    ? current
    : ModelCatalogSnapshotSchema.make({
        revision: nextCatalogRevision(current.revision),
        adapters,
        models,
      })

const withAdapterModels = (
  state: RegistryState,
  adapterModels: ReadonlyArray<RegisteredAdapterModels>,
): RegistryState => ({
  ...state,
  adapterModels,
  modelCatalog: withCatalogContent(
    state.modelCatalog,
    mergeAdapterStatuses(adapterModels),
    mergeAdapterModels(adapterModels),
  ),
})

const statusForSnapshot = (snapshot: AdapterModelSnapshot): AdapterDiscoveryStatus =>
  snapshot.models.some((model) => model.discoveryFreshness === 'stale') ? 'stale' : 'ready'

const registerEntry = <A>(
  stateRef: SubscriptionRef.SubscriptionRef<RegistryState>,
  domain: CapabilityDomain,
  id: string,
  value: A,
  entriesOf: (state: RegistryState) => ReadonlyArray<Registered<A>>,
  entryId: (entry: A) => string,
  replaceEntries: (state: RegistryState, entries: ReadonlyArray<Registered<A>>) => RegistryState,
): Effect.Effect<number, CapabilityConflictError> =>
  SubscriptionRef.modifySome(stateRef, (state) => {
    const entries = entriesOf(state)
    if (entries.some((entry) => entryId(entry.value) === id)) {
      return [Option.none<number>(), Option.none<RegistryState>()] as const
    }

    const key = state.nextRegistrationKey
    const updated = replaceEntries(state, [...entries, { key, value }])
    return [
      Option.some(key),
      Option.some({
        ...updated,
        revision: nextRegistryRevision(state.revision),
        nextRegistrationKey: key + 1,
      }),
    ] as const
  }).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new CapabilityConflictError({ domain, id })),
        onSome: Effect.succeed,
      }),
    ),
  )

const unregisterEntry = <A>(
  stateRef: SubscriptionRef.SubscriptionRef<RegistryState>,
  key: number,
  entriesOf: (state: RegistryState) => ReadonlyArray<Registered<A>>,
  replaceEntries: (state: RegistryState, entries: ReadonlyArray<Registered<A>>) => RegistryState,
): Effect.Effect<boolean> =>
  SubscriptionRef.modifySome(stateRef, (state) => {
    const entries = entriesOf(state)
    if (!entries.some((entry) => entry.key === key)) {
      return [false, Option.none<RegistryState>()] as const
    }
    const updated = replaceEntries(
      state,
      entries.filter((entry) => entry.key !== key),
    )
    return [
      true,
      Option.some({ ...updated, revision: nextRegistryRevision(state.revision) }),
    ] as const
  })

const unregisterAdapter = Effect.fn('CapabilityRegistry.unregisterAdapter')(function* (
  stateRef: SubscriptionRef.SubscriptionRef<RegistryState>,
  refreshFibers: FiberMap.FiberMap<number>,
  key: number,
) {
  const removed = yield* SubscriptionRef.modifySome(stateRef, (state) => {
    if (!state.adapters.some((entry) => entry.key === key)) {
      return [false, Option.none<RegistryState>()] as const
    }

    const adapterModels = state.adapterModels.filter((entry) => entry.key !== key)
    return [
      true,
      Option.some({
        ...withAdapterModels(state, adapterModels),
        revision: nextRegistryRevision(state.revision),
        adapters: state.adapters.filter((entry) => entry.key !== key),
      }),
    ] as const
  })

  if (removed) yield* FiberMap.remove(refreshFibers, key)
  return removed
})

const publishAdapterModels = Effect.fn('CapabilityRegistry.publishAdapterModels')(function* (
  stateRef: SubscriptionRef.SubscriptionRef<RegistryState>,
  refreshFibers: FiberMap.FiberMap<number>,
  key: number,
  adapterId: AdapterId,
  snapshot: AdapterModelSnapshot,
) {
  yield* FiberMap.remove(refreshFibers, key)
  return yield* SubscriptionRef.modifySome(stateRef, (state) => {
    const contribution = state.adapterModels.find(
      (entry) => entry.key === key && entry.adapterId === adapterId,
    )
    if (contribution === undefined) return [false, Option.none<RegistryState>()] as const

    const adapterModels = state.adapterModels.map((entry) =>
      entry.key === key
        ? {
            ...entry,
            request: entry.request + 1,
            status: statusForSnapshot(snapshot),
            snapshot: Option.some(snapshot),
          }
        : entry,
    )
    return [true, Option.some(withAdapterModels(state, adapterModels))] as const
  })
})

interface RefreshTarget {
  readonly key: number
  readonly request: number
  readonly adapter: YokaiAdapter
}

const completeDiscoverySuccess = Effect.fn('CapabilityRegistry.completeDiscoverySuccess')(
  function* (
    stateRef: SubscriptionRef.SubscriptionRef<RegistryState>,
    target: RefreshTarget,
    snapshot: AdapterModelSnapshot,
  ) {
    return yield* SubscriptionRef.updateSome(stateRef, (state) => {
      const current = state.adapterModels.find((entry) => entry.key === target.key)
      if (current === undefined || current.request !== target.request) {
        return Option.none<RegistryState>()
      }

      const adapterModels = state.adapterModels.map((entry) =>
        entry.key === target.key
          ? { ...entry, status: statusForSnapshot(snapshot), snapshot: Option.some(snapshot) }
          : entry,
      )
      return Option.some(withAdapterModels(state, adapterModels))
    })
  },
)

const completeDiscoveryFailure = Effect.fn('CapabilityRegistry.completeDiscoveryFailure')(
  function* (stateRef: SubscriptionRef.SubscriptionRef<RegistryState>, target: RefreshTarget) {
    return yield* SubscriptionRef.updateSome(stateRef, (state) => {
      const current = state.adapterModels.find((entry) => entry.key === target.key)
      if (current === undefined || current.request !== target.request) {
        return Option.none<RegistryState>()
      }

      const status: AdapterDiscoveryStatus = Option.isSome(current.snapshot) ? 'stale' : 'failed'
      const adapterModels = state.adapterModels.map((entry) =>
        entry.key === target.key ? { ...entry, status } : entry,
      )
      return Option.some(withAdapterModels(state, adapterModels))
    })
  },
)

const runDiscovery = Effect.fn('CapabilityRegistry.runDiscovery')(function* (
  stateRef: SubscriptionRef.SubscriptionRef<RegistryState>,
  target: RefreshTarget,
) {
  yield* target.adapter.discoverModels().pipe(
    Effect.matchEffect({
      onFailure: () => completeDiscoveryFailure(stateRef, target),
      onSuccess: (snapshot) => completeDiscoverySuccess(stateRef, target, snapshot),
    }),
  )
})

const beginAdapterRefresh = Effect.fn('CapabilityRegistry.beginAdapterRefresh')(function* (
  stateRef: SubscriptionRef.SubscriptionRef<RegistryState>,
  key: number,
) {
  return yield* SubscriptionRef.modifySome(stateRef, (state) => {
    const registration = state.adapters.find((entry) => entry.key === key)
    const contribution = state.adapterModels.find((entry) => entry.key === key)
    if (registration === undefined || contribution === undefined) {
      return [Option.none<RefreshTarget>(), Option.none<RegistryState>()] as const
    }

    const request = contribution.request + 1
    const adapterModels = state.adapterModels.map((entry) =>
      entry.key === key ? { ...entry, request, status: 'discovering' as const } : entry,
    )
    return [
      Option.some({ key, request, adapter: registration.value }),
      Option.some(withAdapterModels(state, adapterModels)),
    ] as const
  })
})

const startDiscovery = Effect.fn('CapabilityRegistry.startDiscovery')(function* (
  stateRef: SubscriptionRef.SubscriptionRef<RegistryState>,
  refreshFibers: FiberMap.FiberMap<number>,
  target: RefreshTarget,
) {
  yield* FiberMap.run(refreshFibers, target.key, runDiscovery(stateRef, target))
})

const startAdapterRefresh = Effect.fn('CapabilityRegistry.startAdapterRefresh')(function* (
  stateRef: SubscriptionRef.SubscriptionRef<RegistryState>,
  refreshFibers: FiberMap.FiberMap<number>,
  key: number,
) {
  const target = yield* beginAdapterRefresh(stateRef, key)
  return yield* Option.match(target, {
    onNone: () => Effect.succeed(false),
    onSome: (current) => startDiscovery(stateRef, refreshFibers, current).pipe(Effect.as(true)),
  })
})

const modelReferenceEqual = (left: ModelReference, right: ModelReference): boolean =>
  left.adapterId === right.adapterId && left.modelId === right.modelId

const resolveModelFromState = (
  state: RegistryState,
  reference: ModelReference,
): ResolvedModel | undefined => {
  const registration = state.adapters.find(
    (entry) => entry.value.descriptor.id === reference.adapterId,
  )
  const adapterState = state.adapterModels.find((entry) => entry.adapterId === reference.adapterId)
  const model = state.modelCatalog.models.find((candidate) =>
    modelReferenceEqual(candidate.reference, reference),
  )
  const statusAllowsUse =
    adapterState !== undefined &&
    adapterState.status !== 'failed' &&
    adapterState.status !== 'offline'
  return registration !== undefined &&
    model !== undefined &&
    model.availability === 'available' &&
    statusAllowsUse
    ? { adapter: registration.value, reference, model }
    : undefined
}

const turnSnapshot = (state: RegistryState): TurnCapabilitySnapshot => ({
  revision: state.revision,
  adapters: state.adapters.map((entry) => entry.value),
  contextProviders: state.contextProviders.map((entry) => entry.value),
  actionTools: state.actionTools.map((entry) => entry.value),
  feedbackTools: state.feedbackTools.map((entry) => entry.value),
  skills: state.skills.map((entry) => entry.value),
  mcpServers: state.mcpServers.map((entry) => entry.value),
  presetSources: state.presetSources.map((entry) => entry.value),
  responseMechanisms: state.responseMechanisms.map((entry) => entry.value),
  modelCatalog: state.modelCatalog,
})

const make = Effect.fn('CapabilityRegistry.make')(function* () {
  const stateRef = yield* SubscriptionRef.make(initialState())
  const refreshFibers = yield* FiberMap.make<number>()

  const registerAdapter = Effect.fn('CapabilityRegistry.registerAdapter')(function* (
    candidate: YokaiAdapter,
  ) {
    const adapter = yield* negotiateAdapterProtocol(candidate)
    const adapterId = adapter.descriptor.id
    const key = yield* registerEntry(
      stateRef,
      'adapter',
      adapterId,
      adapter,
      (state) => state.adapters,
      (entry) => entry.descriptor.id,
      (state, adapters) => {
        const adapterModels = [
          ...state.adapterModels,
          {
            key: state.nextRegistrationKey,
            adapterId,
            request: 1,
            status: 'discovering' as const,
            snapshot: Option.none<AdapterModelSnapshot>(),
          },
        ]
        return { ...withAdapterModels(state, adapterModels), adapters }
      },
    )
    yield* startDiscovery(stateRef, refreshFibers, { key, request: 1, adapter })

    return {
      unregister: () => unregisterAdapter(stateRef, refreshFibers, key),
      publishModels: (snapshot) =>
        publishAdapterModels(stateRef, refreshFibers, key, adapterId, snapshot),
    } satisfies AdapterRegistration
  })

  const registerContextProvider = Effect.fn('CapabilityRegistry.registerContextProvider')(
    function* (capability: ContextProvider) {
      const key = yield* registerEntry(
        stateRef,
        'context-provider',
        capability.id,
        capability,
        (state) => state.contextProviders,
        (entry) => entry.id,
        (state, contextProviders) => ({ ...state, contextProviders }),
      )
      return {
        unregister: () =>
          unregisterEntry(
            stateRef,
            key,
            (state) => state.contextProviders,
            (state, contextProviders) => ({ ...state, contextProviders }),
          ),
      } satisfies CapabilityRegistration
    },
  )

  const registerActionTool = Effect.fn('CapabilityRegistry.registerActionTool')(function* (
    capability: ActionTool,
  ) {
    const validatedCapability =
      yield* RoleResponseEnvelope.validateActionToolRegistration(capability)
    const key = yield* registerEntry(
      stateRef,
      'action-tool',
      validatedCapability.id,
      validatedCapability,
      (state) => state.actionTools,
      (entry) => entry.id,
      (state, actionTools) => ({ ...state, actionTools }),
    )
    return {
      unregister: () =>
        unregisterEntry(
          stateRef,
          key,
          (state) => state.actionTools,
          (state, actionTools) => ({ ...state, actionTools }),
        ),
    } satisfies CapabilityRegistration
  })

  const registerFeedbackTool = Effect.fn('CapabilityRegistry.registerFeedbackTool')(function* (
    capability: FeedbackTool,
  ) {
    const key = yield* registerEntry(
      stateRef,
      'feedback-tool',
      capability.id,
      capability,
      (state) => state.feedbackTools,
      (entry) => entry.id,
      (state, feedbackTools) => ({ ...state, feedbackTools }),
    )
    return {
      unregister: () =>
        unregisterEntry(
          stateRef,
          key,
          (state) => state.feedbackTools,
          (state, feedbackTools) => ({ ...state, feedbackTools }),
        ),
    } satisfies CapabilityRegistration
  })

  const registerSkill = Effect.fn('CapabilityRegistry.registerSkill')(function* (
    capability: Skill,
  ) {
    const key = yield* registerEntry(
      stateRef,
      'skill',
      capability.id,
      capability,
      (state) => state.skills,
      (entry) => entry.id,
      (state, skills) => ({ ...state, skills }),
    )
    return {
      unregister: () =>
        unregisterEntry(
          stateRef,
          key,
          (state) => state.skills,
          (state, skills) => ({ ...state, skills }),
        ),
    } satisfies CapabilityRegistration
  })

  const registerMcpServer = Effect.fn('CapabilityRegistry.registerMcpServer')(function* (
    capability: McpServer,
  ) {
    const key = yield* registerEntry(
      stateRef,
      'mcp-server',
      capability.id,
      capability,
      (state) => state.mcpServers,
      (entry) => entry.id,
      (state, mcpServers) => ({ ...state, mcpServers }),
    )
    return {
      unregister: () =>
        unregisterEntry(
          stateRef,
          key,
          (state) => state.mcpServers,
          (state, mcpServers) => ({ ...state, mcpServers }),
        ),
    } satisfies CapabilityRegistration
  })

  const registerPresetSource = Effect.fn('CapabilityRegistry.registerPresetSource')(function* (
    capability: PresetSource,
  ) {
    const key = yield* registerEntry(
      stateRef,
      'preset-source',
      capability.id,
      capability,
      (state) => state.presetSources,
      (entry) => entry.id,
      (state, presetSources) => ({ ...state, presetSources }),
    )
    return {
      unregister: () =>
        unregisterEntry(
          stateRef,
          key,
          (state) => state.presetSources,
          (state, presetSources) => ({ ...state, presetSources }),
        ),
    } satisfies CapabilityRegistration
  })

  const registerResponseMechanism = Effect.fn('CapabilityRegistry.registerResponseMechanism')(
    function* (capability: ResponseMechanism) {
      const key = yield* registerEntry(
        stateRef,
        'response-mechanism',
        capability.id,
        capability,
        (state) => state.responseMechanisms,
        (entry) => entry.id,
        (state, responseMechanisms) => ({ ...state, responseMechanisms }),
      )
      return {
        unregister: () =>
          unregisterEntry(
            stateRef,
            key,
            (state) => state.responseMechanisms,
            (state, responseMechanisms) => ({ ...state, responseMechanisms }),
          ),
      } satisfies CapabilityRegistration
    },
  )

  const refreshModels = Effect.fn('CapabilityRegistry.refreshModels')(function* (
    adapterId: Option.Option<AdapterId>,
  ) {
    const state = yield* SubscriptionRef.get(stateRef)
    const targets = Option.match(adapterId, {
      onNone: () => state.adapters,
      onSome: (id) => state.adapters.filter((entry) => entry.value.descriptor.id === id),
    })
    if (Option.isSome(adapterId) && targets.length === 0) {
      return yield* Effect.fail(new AdapterNotFoundError({ adapterId: adapterId.value }))
    }

    const started = yield* Effect.forEach(
      targets,
      (entry) => startAdapterRefresh(stateRef, refreshFibers, entry.key),
      { concurrency: 'unbounded' },
    )
    return started.filter(Boolean).length
  })

  const resolveModel = Effect.fn('CapabilityRegistry.resolveModel')(function* (
    reference: ModelReference,
  ) {
    const resolved = resolveModelFromState(yield* SubscriptionRef.get(stateRef), reference)
    return resolved === undefined
      ? yield* Effect.fail(new ModelSelectionUnavailableError({ reference }))
      : resolved
  })

  return Service.of({
    registerAdapter,
    registerContextProvider,
    registerActionTool,
    registerFeedbackTool,
    registerSkill,
    registerMcpServer,
    registerPresetSource,
    registerResponseMechanism,
    snapshot: Effect.fn('CapabilityRegistry.snapshot')(function* () {
      return turnSnapshot(yield* SubscriptionRef.get(stateRef))
    }),
    changes: SubscriptionRef.changes(stateRef).pipe(
      Stream.changesWith((left, right) => left.revision === right.revision),
      Stream.map(turnSnapshot),
    ),
    modelCatalog: Effect.fn('CapabilityRegistry.modelCatalog')(function* () {
      return (yield* SubscriptionRef.get(stateRef)).modelCatalog
    }),
    modelCatalogChanges: SubscriptionRef.changes(stateRef).pipe(
      Stream.map((state) => state.modelCatalog),
      Stream.changesWith((left, right) => left.revision === right.revision),
    ),
    refreshModels,
    resolveModel,
  })
})

export const layer = Layer.effect(Service, make())

export * as CapabilityRegistry from './registry'
