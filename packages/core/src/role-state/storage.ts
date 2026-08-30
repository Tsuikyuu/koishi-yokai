import { RoleStateModel } from '@yokai-internal/mind'
import type { CapabilityScope } from 'yokai-protocol'
import { Context, Effect, Option, Schema } from 'effect'

export const StorageOperation = Schema.Literals(['load', 'save'])

export type StorageOperation = typeof StorageOperation.Type

export class StorageError extends Schema.TaggedError<StorageError>(
  '@yokai/core/RoleStateStorage.StorageError',
)('RoleStateStorageError', {
  operation: StorageOperation,
  cause: Schema.Defect(),
}) {}

export interface Interface {
  readonly load: (
    scope: CapabilityScope,
    memberIds: ReadonlyArray<string>,
  ) => Effect.Effect<Option.Option<RoleStateModel.Snapshot>, StorageError>
  /**
   * Atomically persist the channel state and upsert only the relationships present in the
   * snapshot. Relationships omitted from this bounded bundle must remain untouched.
   */
  readonly save: (
    scope: CapabilityScope,
    snapshot: RoleStateModel.Snapshot,
  ) => Effect.Effect<void, StorageError>
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/core/RoleStateStorage',
) {}

export * as RoleStateStorage from './storage'
