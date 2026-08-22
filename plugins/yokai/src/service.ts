import {
  CapabilityRegistry,
  type CapabilityRegistration as CoreCapabilityRegistration,
  type AdapterRegistration as CoreAdapterRegistration,
  HostSession,
} from '@yokai/core'
import type {
  ActionTool,
  AdapterRegistration,
  CapabilityRegistration,
  ContextProvider,
  FeedbackTool,
  McpServer,
  PresetSource,
  ResponseMechanism,
  Skill,
  YokaiAdapter,
  YokaiCapabilityHost,
} from '@yokai/protocol'
import { Effect } from 'effect'
import { Context, Service, type Session } from 'koishi'

import type { Config } from './config'
import { YokaiRuntime } from './runtime/runtime'
import { fromSession } from './runtime/session'

declare module 'koishi' {
  interface Context {
    yokai: YokaiCapabilityHost
  }
}

export class Yokai extends Service<Config> implements YokaiCapabilityHost {
  private readonly effectRuntime: YokaiRuntime.Interface

  constructor(ctx: Context, config: Config) {
    super(ctx, 'yokai', true)
    this.config = config
    this.effectRuntime = YokaiRuntime.make(config)
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
}
