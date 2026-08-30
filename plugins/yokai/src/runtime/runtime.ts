import {
  ActivityResponseMechanism,
  BackgroundTasks,
  CallBudget,
  CapabilityRegistry,
  ChannelMessageBuffer,
  DirectResponseMechanism,
  HostConfiguration,
  HostSession,
  PresetRegistry,
  WakeArbiter,
} from '@yokai-internal/core'
import { MessageArchive, MessageHistory } from '@yokai-internal/memory'
import { Effect, ManagedRuntime } from 'effect'
import type { Context } from 'koishi'

import type { Config } from '../config'
import { makeLayer } from './layer'
import { makeLayer as makeSessionLayer, type SessionBoundary } from './session'

export type Services =
  | ActivityResponseMechanism.Service
  | BackgroundTasks.Service
  | CallBudget.Service
  | CapabilityRegistry.Service
  | ChannelMessageBuffer.Service
  | DirectResponseMechanism.Service
  | HostConfiguration.Service
  | MessageArchive.Service
  | MessageHistory.Service
  | PresetRegistry.Service
  | WakeArbiter.Service

export interface Interface {
  readonly start: () => Promise<void>
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E, Services>) => Promise<A>
  readonly runCleanup: (effect: Effect.Effect<boolean, never, Services>) => void
  readonly runSession: <A, E>(
    session: SessionBoundary,
    effect: Effect.Effect<A, E, Services | HostSession.Service>,
  ) => Promise<A>
  readonly dispose: () => Promise<void>
}

export const make = (config: Config, ctx: Context): Interface => {
  const runtime = ManagedRuntime.make(makeLayer(config, ctx))

  const service: Interface = {
    start: () => runtime.runPromise(CapabilityRegistry.Service.pipe(Effect.asVoid)),
    runPromise: (effect) => runtime.runPromise(effect),
    runCleanup: (effect) => {
      runtime.runFork(effect)
    },
    runSession: (session, effect) =>
      runtime.runPromise(effect.pipe(Effect.provide(makeSessionLayer(session)))),
    dispose: () => runtime.dispose(),
  }

  return service
}

export * as YokaiRuntime from './runtime'
