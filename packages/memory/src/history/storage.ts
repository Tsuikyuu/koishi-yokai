import { Context, Effect, Schema } from 'effect'

import type { ArchivedMessage } from '../message-archive/event'
import type { StorageSearchRequest } from './query'

export class StorageError extends Schema.TaggedError<StorageError>(
  '@yokai/memory/MessageHistoryStorage.StorageError',
)('MessageHistoryStorageError', {
  cause: Schema.Defect(),
}) {}

export interface Interface {
  readonly search: (
    request: StorageSearchRequest,
  ) => Effect.Effect<ReadonlyArray<ArchivedMessage>, StorageError>
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/memory/MessageHistoryStorage',
) {}

export * as MessageHistoryStorage from './storage'
