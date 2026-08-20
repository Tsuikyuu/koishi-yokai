import { AdapterConfigurationError, AdapterId, type AdapterInvocationError } from '@yokai/protocol'
import type { ListModelsParameters } from '@google/genai'
import { Context, Effect, HashMap, Layer, Option, Ref, Scope } from 'effect'

import type { ConnectionId } from '../config/configuration.js'
import { GeminiConfiguration } from '../config/configuration.js'
import { GeminiConnection } from './connection.js'

const GEMINI_ADAPTER_ID = AdapterId.make('gemini')
const DISCOVERY_OPERATION = 'discoverModels'

export interface Interface {
  readonly summaries: ReadonlyArray<GeminiConnection.Summary>
  readonly listModels: (
    connectionId: ConnectionId,
    params: ListModelsParameters,
  ) => Effect.Effect<GeminiConnection.ModelPage, AdapterInvocationError>
  readonly close: (connectionId: ConnectionId) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/koishi-plugin-yokai-adapter-gemini/ConnectionPool',
) {}

const unknownConnectionError = () =>
  new AdapterConfigurationError({
    adapterId: GEMINI_ADAPTER_ID,
    operation: DISCOVERY_OPERATION,
    message: 'Unknown Gemini connection',
  })

const makeEntry = (
  connection: GeminiConnection.Interface,
): readonly [ConnectionId, GeminiConnection.Interface] => [
  connection.summary.connectionId,
  connection,
]

const make = Effect.fn('GeminiConnectionPool.make')(function* () {
  const configuration = yield* GeminiConfiguration.Service
  const parentScope = yield* Effect.scope
  const connections = yield* Effect.forEach(configuration.connections, (connection) =>
    Effect.gen(function* () {
      const connectionScope = yield* Scope.fork(parentScope)
      return yield* Scope.provide(
        GeminiConnection.make(connection, connectionScope),
        connectionScope,
      )
    }),
  )
  const connectionsById = yield* Ref.make(HashMap.fromIterable(connections.map(makeEntry)))

  const listModels = Effect.fn('GeminiConnectionPool.listModels')(function* (
    connectionId: ConnectionId,
    params: ListModelsParameters,
  ) {
    const connection = yield* Ref.get(connectionsById).pipe(
      Effect.map((current) => HashMap.get(current, connectionId)),
    )
    if (Option.isNone(connection)) return yield* Effect.fail(unknownConnectionError())
    return yield* connection.value.listModels(params)
  })

  const close = Effect.fn('GeminiConnectionPool.close')(function* (connectionId: ConnectionId) {
    const connection = yield* Ref.modify(connectionsById, (current) => [
      HashMap.get(current, connectionId),
      HashMap.remove(current, connectionId),
    ])
    if (Option.isNone(connection)) return false
    yield* connection.value.close()
    return true
  })

  return Service.of({
    summaries: connections.map((connection) => connection.summary),
    listModels,
    close,
  })
})

export const layer = Layer.effect(Service, make())

export * as GeminiConnectionPool from './pool.js'
