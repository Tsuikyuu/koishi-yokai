import {
  ActivityResponseMechanism,
  CapabilityRegistry,
  ChannelMessageBuffer,
  DirectResponseMechanism,
  EngagementLease,
  type CapabilityRegistration as CoreCapabilityRegistration,
  type AdapterRegistration as CoreAdapterRegistration,
  type McpServerRegistration as CoreMcpServerRegistration,
  HostConfiguration,
  HostModelSelection,
  HostSession,
  PresetRegistry,
  RoleState,
  RoleStateSignals,
  ThreadTracker,
  type AvailableCapabilities,
  type PresetSourceRegistration as CorePresetSourceRegistration,
  type ResolvedModel,
  WakeArbiter,
  WakeMessage,
  WakeTurn,
} from '@yokai-internal/core'
import { MessageArchive, MessageArchiveEvent } from '@yokai-internal/memory'
import { ThreadScene } from '@yokai-internal/mind'
import type {
  ActionTool,
  AdapterId,
  AdapterRegistration,
  CapabilityRegistration,
  ContextProvider,
  FeedbackTool,
  McpServer,
  McpServerRegistration,
  PresetSource,
  PresetId,
  PresetRegistration,
  PresetSnapshot,
  ResponseMechanism,
  Skill,
  ModelCatalogSnapshot,
  YokaiAdapter,
  YokaiCapabilityHost,
} from 'yokai-protocol'
import { Effect, Option } from 'effect'
import { Context, Service, type Session } from 'koishi'

import type { Config } from './config'
import { DEFAULT_INSTANCE_ID, resolveHardReplyPolicy } from './config'
import { KoishiMessageNormalization, type EventKind } from './message-archive/normalization'
import { KoishiWakeObservation } from './response/observation'
import { YokaiRuntime } from './runtime/runtime'
import { fromSession, makeSendText } from './runtime/session'

interface ArchivedObservation {
  readonly message: MessageArchiveEvent.ArchivedMessage
  readonly isDuplicate: boolean
}

const selectedRoleName = Effect.fn('Yokai.selectedRoleName')(function* () {
  const configuration = yield* HostConfiguration.Service
  if (Option.isNone(configuration.presetId)) return Option.none<string>()
  const presets = yield* PresetRegistry.Service
  return Option.map(
    yield* presets.snapshot(configuration.presetId.value),
    (snapshot) => snapshot.persona.name,
  )
})

export class Yokai extends Service<Config> implements YokaiCapabilityHost {
  private readonly effectRuntime: YokaiRuntime.Interface

  constructor(ctx: Context, config: Config) {
    const effectRuntime = YokaiRuntime.make(config, ctx)
    super(ctx, 'yokai', true)
    this.config = config
    this.effectRuntime = effectRuntime
  }

  protected override start(): Promise<void> {
    return this.effectRuntime.start()
  }

  protected override stop(): Promise<void> {
    return this.effectRuntime.dispose()
  }

  protected runEffect<A, E>(effect: Effect.Effect<A, E, YokaiRuntime.Services>): Promise<A> {
    return this.effectRuntime.runPromise(effect)
  }

  protected runSessionEffect<A, E>(
    session: Session,
    effect: Effect.Effect<A, E, YokaiRuntime.Services | HostSession.Service>,
  ): Promise<A> {
    return this.effectRuntime.runSession(fromSession(session), effect)
  }

  protected resolveConfiguredModel(): Promise<ResolvedModel> {
    return this.runEffect(HostModelSelection.resolve())
  }

  private archiveMessageEvent(
    session: Session,
    eventKind: EventKind,
  ): Effect.Effect<Option.Option<ArchivedObservation>, never, YokaiRuntime.Services> {
    const instanceId =
      this.config.instanceId === undefined ? DEFAULT_INSTANCE_ID : this.config.instanceId
    return KoishiMessageNormalization.normalize(session, instanceId, eventKind).pipe(
      Effect.flatMap((event) =>
        MessageArchive.Service.pipe(Effect.flatMap((archive) => archive.record(event))),
      ),
      Effect.tap((result) =>
        ChannelMessageBuffer.Service.pipe(
          Effect.flatMap((buffer) => buffer.ingest(result.message)),
        ),
      ),
      Effect.map((result) =>
        Option.some({
          message: result.message,
          isDuplicate: result._tag === 'Replay',
        } satisfies ArchivedObservation),
      ),
      Effect.catch((error) =>
        Effect.logWarning('MessageArchive.event_ignored').pipe(
          Effect.annotateLogs({ errorTag: error._tag, eventKind }),
          Effect.as(Option.none<ArchivedObservation>()),
        ),
      ),
    )
  }

  handleMessageCreated(session: Session): Promise<boolean> {
    const boundary = fromSession(session)
    const sendText = makeSendText(boundary)
    const archivedEffect = this.archiveMessageEvent(session, 'created')
    const hardReplyPolicy = resolveHardReplyPolicy(this.config)
    return this.runEffect(
      Effect.gen(function* () {
        const archived = yield* archivedEffect
        if (Option.isNone(archived)) return false

        const roleName = yield* selectedRoleName()
        const observation = KoishiWakeObservation.fromSession(
          session,
          archived.value.message,
          archived.value.isDuplicate,
          roleName,
          hardReplyPolicy,
        )
        const threadTracker = yield* ThreadTracker.Service
        const scene = yield* threadTracker.observe(
          archived.value.message,
          WakeMessage.isDirectedToSelf(observation),
        )
        const roleState = yield* RoleState.Service
        const localState = yield* Effect.gen(function* () {
          const priorState = yield* roleState.snapshot(observation.scope, [
            observation.focus.authorId,
          ])
          const signals = RoleStateSignals.localSignals(priorState, scene)
          if (observation.isEffective && !observation.isOtherBot && !observation.isSelf) {
            yield* roleState.observe({
              scope: observation.scope,
              messageId: observation.focus.messageId,
              memberId: ThreadScene.ParticipantId.make(observation.focus.authorId),
              scene,
            })
          }
          return signals
        }).pipe(Effect.option)
        if (Option.isNone(localState)) return false
        const observedMessage = WakeMessage.withLocalState(observation, localState.value)
        const directMechanism = yield* DirectResponseMechanism.Service
        const engagementLease = yield* EngagementLease.Service
        const activityMechanism = yield* ActivityResponseMechanism.Service
        const direct = yield* directMechanism.observe(observedMessage)
        const engagement = yield* engagementLease.observe(observedMessage, scene)
        const activity = yield* activityMechanism.observe(observedMessage)
        const selected = Option.isSome(direct)
          ? direct
          : Option.isSome(engagement)
            ? Option.some(engagement.value.proposal)
            : activity
        if (Option.isNone(selected)) return false

        const arbiter = yield* WakeArbiter.Service
        const executeTurn = yield* WakeTurn.makeExecutor(sendText)
        const outcome = Option.isSome(direct)
          ? yield* arbiter.submit(direct.value, executeTurn)
          : Option.isSome(engagement)
            ? yield* arbiter.submitWithAdmission(
                engagement.value.proposal,
                engagement.value.admission,
                executeTurn,
              )
            : yield* arbiter.submit(selected.value, executeTurn)
        if (outcome._tag === 'Executed') {
          yield* activityMechanism.consume(outcome.proposal.scopeId)
        }
        return WakeMessage.isHardTrigger(observedMessage)
      }),
    )
  }

  handleMessageUpdated(session: Session): Promise<void> {
    return this.runEffect(this.archiveMessageEvent(session, 'updated').pipe(Effect.asVoid))
  }

  private bindUnregister(
    owner: Context,
    registration: CoreCapabilityRegistration,
  ): () => Promise<boolean> {
    const removeLifecycleHook = owner.on('dispose', () => {
      this.effectRuntime.runCleanup(registration.unregister())
    })

    return () => {
      removeLifecycleHook()
      return this.effectRuntime.runPromise(registration.unregister())
    }
  }

  private bindCapabilityRegistration(
    owner: Context,
    registration: CoreCapabilityRegistration,
  ): CapabilityRegistration {
    return { unregister: this.bindUnregister(owner, registration) }
  }

  private bindAdapterRegistration(
    owner: Context,
    registration: CoreAdapterRegistration,
  ): AdapterRegistration {
    return {
      unregister: this.bindUnregister(owner, registration),
      publishModels: (snapshot) =>
        this.effectRuntime.runPromise(registration.publishModels(snapshot)),
    }
  }

  private bindMcpServerRegistration(
    owner: Context,
    registration: CoreMcpServerRegistration,
  ): McpServerRegistration {
    return {
      unregister: this.bindUnregister(owner, registration),
      publishSnapshot: (snapshot) =>
        this.effectRuntime.runPromise(registration.publishSnapshot(snapshot)),
    }
  }

  private bindPresetRegistration(
    owner: Context,
    capabilityRegistration: CoreCapabilityRegistration,
    sourceRegistration: CorePresetSourceRegistration,
  ): PresetRegistration {
    const combinedRegistration: CoreCapabilityRegistration = {
      unregister: () =>
        Effect.all([sourceRegistration.unregister(), capabilityRegistration.unregister()], {
          concurrency: 'unbounded',
        }).pipe(Effect.map((results) => results.some(Boolean))),
    }
    return {
      unregister: this.bindUnregister(owner, combinedRegistration),
      publish: (candidate) =>
        this.effectRuntime.runPromise(
          Effect.gen(function* () {
            const registry = yield* CapabilityRegistry.Service
            const snapshot = yield* registry.snapshot()
            const available: AvailableCapabilities = {
              skills: snapshot.skills.map((entry) => entry.id),
              actionTools: snapshot.actionTools.map((entry) => entry.id),
              feedbackTools: snapshot.feedbackTools.map((entry) => entry.id),
            }
            return yield* sourceRegistration.publish(candidate, available)
          }),
        ),
    }
  }

  private registerCapability<E>(
    owner: Context,
    registration: Effect.Effect<CoreCapabilityRegistration, E, CapabilityRegistry.Service>,
  ): Promise<CapabilityRegistration> {
    return this.effectRuntime.runPromise(
      registration.pipe(Effect.map((handle) => this.bindCapabilityRegistration(owner, handle))),
    )
  }

  registerAdapter(adapter: YokaiAdapter): Promise<AdapterRegistration> {
    const owner = this[Context.current]
    return this.effectRuntime.runPromise(
      CapabilityRegistry.Service.pipe(
        Effect.flatMap((registry) => registry.registerAdapter(adapter)),
        Effect.map((registration) => this.bindAdapterRegistration(owner, registration)),
      ),
    )
  }

  registerContextProvider(capability: ContextProvider): Promise<CapabilityRegistration> {
    const owner = this[Context.current]
    return this.registerCapability(
      owner,
      CapabilityRegistry.Service.pipe(
        Effect.flatMap((registry) => registry.registerContextProvider(capability)),
      ),
    )
  }

  registerActionTool(capability: ActionTool): Promise<CapabilityRegistration> {
    const owner = this[Context.current]
    return this.registerCapability(
      owner,
      CapabilityRegistry.Service.pipe(
        Effect.flatMap((registry) => registry.registerActionTool(capability)),
      ),
    )
  }

  registerFeedbackTool(capability: FeedbackTool): Promise<CapabilityRegistration> {
    const owner = this[Context.current]
    return this.registerCapability(
      owner,
      CapabilityRegistry.Service.pipe(
        Effect.flatMap((registry) => registry.registerFeedbackTool(capability)),
      ),
    )
  }

  registerSkill(capability: Skill): Promise<CapabilityRegistration> {
    const owner = this[Context.current]
    return this.registerCapability(
      owner,
      CapabilityRegistry.Service.pipe(
        Effect.flatMap((registry) => registry.registerSkill(capability)),
      ),
    )
  }

  registerMcpServer(capability: McpServer): Promise<McpServerRegistration> {
    const owner = this[Context.current]
    return this.effectRuntime.runPromise(
      CapabilityRegistry.Service.pipe(
        Effect.flatMap((registry) => registry.registerMcpServer(capability)),
        Effect.map((registration) => this.bindMcpServerRegistration(owner, registration)),
      ),
    )
  }

  registerPresetSource(capability: PresetSource): Promise<PresetRegistration> {
    const owner = this[Context.current]
    return this.effectRuntime.runPromise(
      Effect.gen(function* () {
        const capabilityRegistry = yield* CapabilityRegistry.Service
        const capabilityRegistration = yield* capabilityRegistry.registerPresetSource(capability)
        const presetRegistry = yield* PresetRegistry.Service
        const sourceRegistration = yield* presetRegistry
          .registerSource(capability.id)
          .pipe(Effect.tapError(() => capabilityRegistration.unregister()))
        return { capabilityRegistration, sourceRegistration }
      }).pipe(
        Effect.map(({ capabilityRegistration, sourceRegistration }) =>
          this.bindPresetRegistration(owner, capabilityRegistration, sourceRegistration),
        ),
      ),
    )
  }

  registerResponseMechanism(capability: ResponseMechanism): Promise<CapabilityRegistration> {
    const owner = this[Context.current]
    return this.registerCapability(
      owner,
      CapabilityRegistry.Service.pipe(
        Effect.flatMap((registry) => registry.registerResponseMechanism(capability)),
      ),
    )
  }

  getModelCatalog(): Promise<ModelCatalogSnapshot> {
    return this.runEffect(
      CapabilityRegistry.Service.pipe(Effect.flatMap((registry) => registry.modelCatalog())),
    )
  }

  getPresetSnapshot(presetId: PresetId): Promise<PresetSnapshot | undefined> {
    return this.runEffect(
      PresetRegistry.Service.pipe(
        Effect.flatMap((registry) => registry.snapshot(presetId)),
        Effect.map(Option.getOrUndefined),
      ),
    )
  }

  refreshModels(adapterId?: AdapterId): Promise<number> {
    const target = adapterId === undefined ? Option.none<AdapterId>() : Option.some(adapterId)
    return this.runEffect(
      CapabilityRegistry.Service.pipe(Effect.flatMap((registry) => registry.refreshModels(target))),
    )
  }
}
