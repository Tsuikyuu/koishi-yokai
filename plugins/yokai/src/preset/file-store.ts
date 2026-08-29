import { watch } from 'node:fs'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

import { Cause, Context, Effect, Layer, Queue, Schema, Stream } from 'effect'

export const FileOperation = Schema.Literals([
  'ensure-directory',
  'list-files',
  'read-file',
  'watch-directory',
])

export type FileOperation = typeof FileOperation.Type

export class FileSystemError extends Schema.TaggedError<FileSystemError>(
  '@yokai/koishi-plugin-yokai/FilePresetStore.FileSystemError',
)('FilePresetStoreError', {
  operation: FileOperation,
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface Interface {
  readonly ensureDirectory: (directory: string) => Effect.Effect<void, FileSystemError>
  readonly files: (directory: string) => Effect.Effect<ReadonlyArray<string>, FileSystemError>
  readonly read: (path: string) => Effect.Effect<string, FileSystemError>
  readonly changes: (directory: string) => Stream.Stream<void, FileSystemError>
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/koishi-plugin-yokai/FilePresetStore',
) {}

const supportedFile = (name: string): boolean => {
  const extension = extname(name).toLowerCase()
  return extension === '.json' || extension === '.yaml' || extension === '.yml'
}

const make = Effect.sync(() => {
  const ensureDirectory = Effect.fn('FilePresetStore.ensureDirectory')((directory: string) =>
    Effect.tryPromise({
      try: () => mkdir(directory, { recursive: true }),
      catch: (cause) =>
        new FileSystemError({ operation: 'ensure-directory', path: directory, cause }),
    }).pipe(Effect.asVoid),
  )

  const files = Effect.fn('FilePresetStore.files')((directory: string) =>
    Effect.tryPromise({
      try: () => readdir(directory, { withFileTypes: true }),
      catch: (cause) => new FileSystemError({ operation: 'list-files', path: directory, cause }),
    }).pipe(
      Effect.map((entries) =>
        entries
          .filter((entry) => entry.isFile() && supportedFile(entry.name))
          .map((entry) => join(directory, entry.name))
          .sort(),
      ),
    ),
  )

  const read = Effect.fn('FilePresetStore.read')((path: string) =>
    Effect.tryPromise({
      try: () => readFile(path, 'utf8'),
      catch: (cause) => new FileSystemError({ operation: 'read-file', path, cause }),
    }),
  )

  const changes = (directory: string): Stream.Stream<void, FileSystemError> =>
    Stream.callback<void, FileSystemError>((queue) =>
      Effect.acquireRelease(
        Effect.try({
          try: () => {
            const watcher = watch(directory, { persistent: false }, () => {
              Queue.offerUnsafe(queue, undefined)
            })
            watcher.on('error', (cause) => {
              Queue.failCauseUnsafe(
                queue,
                Cause.fail(
                  new FileSystemError({
                    operation: 'watch-directory',
                    path: directory,
                    cause,
                  }),
                ),
              )
            })
            return watcher
          },
          catch: (cause) =>
            new FileSystemError({ operation: 'watch-directory', path: directory, cause }),
        }),
        (watcher) => Effect.sync(() => watcher.close()),
      ),
    )

  return Service.of({ ensureDirectory, files, read, changes })
})

export const layer = Layer.effect(Service, make)

export * as FilePresetStore from './file-store'
