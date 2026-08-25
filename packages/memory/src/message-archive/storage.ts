import { Context, Effect, Option, Schema } from 'effect'

import {
  type ArchivedMessage,
  type ChannelScope,
  type InstanceId,
  type MessageId,
  type NormalizedEvent,
  type RecordResult,
  type Timestamp,
} from './event'

export const StorageOperation = Schema.Literals(['store', 'latest', 'versions', 'remove-expired'])

export type StorageOperation = typeof StorageOperation.Type

export class StorageError extends Schema.TaggedError<StorageError>(
  '@yokai/memory/MessageArchiveStorage.StorageError',
)('MessageArchiveStorageError', {
  operation: StorageOperation,
  cause: Schema.Defect(),
}) {}

export class OriginalMessageNotFoundError extends Schema.TaggedError<OriginalMessageNotFoundError>(
  '@yokai/memory/MessageArchiveStorage.OriginalMessageNotFoundError',
)('MessageArchiveOriginalMessageNotFoundError', {
  instanceId: Schema.String,
  messageId: Schema.String,
}) {}

export interface Interface {
  readonly store: (
    event: NormalizedEvent,
    recordedAt: Timestamp,
  ) => Effect.Effect<RecordResult, StorageError | OriginalMessageNotFoundError>
  readonly latest: (
    scope: ChannelScope,
    messageId: MessageId,
  ) => Effect.Effect<Option.Option<ArchivedMessage>, StorageError>
  readonly versions: (
    scope: ChannelScope,
    messageId: MessageId,
  ) => Effect.Effect<ReadonlyArray<ArchivedMessage>, StorageError>
  readonly removeExpired: (
    instanceId: InstanceId,
    cutoff: Timestamp,
  ) => Effect.Effect<number, StorageError>
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/memory/MessageArchiveStorage',
) {}

export * as MessageArchiveStorage from './storage'
