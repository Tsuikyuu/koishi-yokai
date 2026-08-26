import {
  ActivityResponseMechanism,
  CapabilityRegistry,
  ChannelMessageBuffer,
  DirectResponseMechanism,
  type CapabilityRegistration as CoreCapabilityRegistration,
  type AdapterRegistration as CoreAdapterRegistration,
  HostModelSelection,
  HostSession,
  type ResolvedModel,
  WakeArbiter,
  WakeMessage,
  WakeTurn,
} from '@yokai-internal/core'
import { MessageArchive, MessageArchiveEvent } from '@yokai-internal/memory'
import type {
  ActionTool,
  AdapterId,
  AdapterRegistration,
  CapabilityRegistration,
  ContextProvider,
  FeedbackTool,
  McpServer,
  PresetSource,
  ResponseMechanism,
  Skill,
  ModelCatalogSnapshot,
  YokaiAdapter,
  YokaiCapabilityHost,
} from 'yokai-protocol'
import { Effect, Option } from 'effect'
import { Context, Service, type Session } from 'koishi'

import type { Config } from './config'
import { DEFAULT_INSTANCE_ID } from './config'
import { KoishiMessageNormalization, type EventKind } from './message-archive/normalization'
import { KoishiWakeObservation } from './response/observation'
import { YokaiRuntime } from './runtime/runtime'
import { fromSession, makeSendText } from './runtime/session'

interface ArchivedObservation {
  readonly message: MessageArchiveEvent.ArchivedMessage
  readonly isDuplicate: boolean
}

export class Yokai extends Service<Config> implements YokaiCapabilityHost {
  private readonly effectRuntime: YokaiRuntime.Interface

  constructor(ctx: Context, config: Config) {
    super(ctx, 'yokai', true)
    this.config = config
    this.effectRuntime = YokaiRuntime.make(config, ctx)
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
    return this.runEffect(
      Effect.gen(function* () {
        const archived = yield* archivedEffect
        if (Option.isNone(archived)) return false

        const observation = KoishiWakeObservation.fromSession(
          session,
          archived.value.message,
          archived.value.isDuplicate,
        )
        const directMechanism = yield* DirectResponseMechanism.Service
        const activityMechanism = yield* ActivityResponseMechanism.Service
        const direct = yield* directMechanism.observe(observation)
        const activity = yield* activityMechanism.observe(observation)
        const selected = Option.isSome(direct) ? direct : activity
        if (Option.isNone(selected)) return false

        const arbiter = yield* WakeArbiter.Service
        const outcome = yield* arbiter.submit(selected.value, (proposal, markDispatched) =>
          WakeTurn.run({
            scope: proposal.scope,
            focus: proposal.focus,
            markDispatched,
            sendText,
          }).pipe(
            Effect.scoped,
            Effect.catch(() => Effect.void),
          ),
        )
        if (outcome._tag === 'Executed') {
          yield* activityMechanism.consume(outcome.proposal.scopeId)
        }
        return WakeMessage.isHardTrigger(observation)
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

  registerMcpServer(capability: McpServer): Promise<CapabilityRegistration> {
    const owner = this[Context.current]
    return this.registerCapability(
      owner,
      CapabilityRegistry.Service.pipe(
        Effect.flatMap((registry) => registry.registerMcpServer(capability)),
      ),
    )
  }

  registerPresetSource(capability: PresetSource): Promise<CapabilityRegistration> {
    const owner = this[Context.current]
    return this.registerCapability(
      owner,
      CapabilityRegistry.Service.pipe(
        Effect.flatMap((registry) => registry.registerPresetSource(capability)),
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

  refreshModels(adapterId?: AdapterId): Promise<number> {
    const target = adapterId === undefined ? Option.none<AdapterId>() : Option.some(adapterId)
    return this.runEffect(
      CapabilityRegistry.Service.pipe(Effect.flatMap((registry) => registry.refreshModels(target))),
    )
  }
}
