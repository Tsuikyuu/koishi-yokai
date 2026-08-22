import { CapabilityRegistry, HostConfiguration, HostSession } from '@yokai/core'
import { Effect, ManagedRuntime } from 'effect'

import type { Config } from '../config'
import { makeLayer } from './layer'
import { makeLayer as makeSessionLayer, type SessionBoundary } from './session'

export type Services = CapabilityRegistry.Service | HostConfiguration.Service

export interface Interface {
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E, Services>) => Promise<A>
  readonly runSync: <A, E>(effect: Effect.Effect<A, E, Services>) => A
  readonly runCleanup: (effect: Effect.Effect<boolean, never, Services>) => void
  readonly runSession: <A, E>(
    session: SessionBoundary,
    effect: Effect.Effect<A, E, Services | HostSession.Service>,
  ) => Promise<A>
  readonly dispose: () => Promise<void>
}

export const make = (config: Config): Interface => {
  const runtime = ManagedRuntime.make(makeLayer(config))

  const service: Interface = {
    runPromise: (effect) => runtime.runPromise(effect),
    runSync: (effect) => runtime.runSync(effect),
    runCleanup: (effect) => {
      runtime.runSyncExit(effect)
    },
    runSession: (session, effect) =>
      runtime.runPromise(effect.pipe(Effect.provide(makeSessionLayer(session)))),
    dispose: () => runtime.dispose(),
  }

  service.runSync(CapabilityRegistry.Service.pipe(Effect.asVoid))
  return service
}

export * as YokaiRuntime from './runtime'
