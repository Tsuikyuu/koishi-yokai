import { Context, Data, Effect, Option, Schema } from 'effect'

import type { ChannelScope } from '../message-archive/event'
import type { Note, NoteId } from './model'

export const StorageOperation = Schema.Literals(['get', 'query', 'store'])
export type StorageOperation = typeof StorageOperation.Type

export class StorageError extends Schema.TaggedError<StorageError>(
  '@yokai/memory/NotebookStorage.StorageError',
)('NotebookStorageError', {
  operation: StorageOperation,
  cause: Schema.Defect(),
}) {}

export type StoreResult = Data.TaggedEnum<{
  Stored: {}
  Replay: {}
  CorrectionTargetMissing: {}
  CorrectionTargetInactive: {}
}>

export const StoreResult = Data.taggedEnum<StoreResult>()

export interface Interface {
  readonly get: (
    scope: ChannelScope,
    noteId: NoteId,
  ) => Effect.Effect<Option.Option<Note>, StorageError>
  readonly query: (scope: ChannelScope) => Effect.Effect<ReadonlyArray<Note>, StorageError>
  readonly store: (note: Note) => Effect.Effect<StoreResult, StorageError>
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/memory/NotebookStorage',
) {}

export * as NotebookStorage from './storage'
