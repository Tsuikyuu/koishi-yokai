import { Context, Data, Effect, Option, Schema } from 'effect'

import type { MessageArchiveEvent } from '@yokai-internal/memory'
import type { QueryRequest, ScheduleId, Task } from './model'

export const StorageOperation = Schema.Literals([
  'create',
  'get',
  'query',
  'next',
  'compare-and-set',
])

export type StorageOperation = typeof StorageOperation.Type

export class StorageError extends Schema.TaggedError<StorageError>(
  '@yokai/core/ScheduledTaskStorage.StorageError',
)('ScheduledTaskStorageError', {
  operation: StorageOperation,
  cause: Schema.Defect(),
}) {}

export type CreateResult = Data.TaggedEnum<{
  Stored: { readonly task: Task }
  Replay: { readonly task: Task }
  Conflict: { readonly task: Task }
}>

export const CreateResult = Data.taggedEnum<CreateResult>()

export interface Interface {
  readonly create: (task: Task) => Effect.Effect<CreateResult, StorageError>
  readonly get: (
    scope: MessageArchiveEvent.ChannelScope,
    scheduleId: ScheduleId,
  ) => Effect.Effect<Option.Option<Task>, StorageError>
  readonly query: (request: QueryRequest) => Effect.Effect<ReadonlyArray<Task>, StorageError>
  readonly next: (
    instanceId: MessageArchiveEvent.InstanceId,
    excludedScheduleIds?: ReadonlyArray<ScheduleId>,
  ) => Effect.Effect<Option.Option<Task>, StorageError>
  readonly compareAndSet: (
    expected: Task,
    replacement: Task,
  ) => Effect.Effect<boolean, StorageError>
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/core/ScheduledTaskStorage',
) {}

export * as ScheduledTaskStorage from './storage'
