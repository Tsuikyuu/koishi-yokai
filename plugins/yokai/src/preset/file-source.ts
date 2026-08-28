import { extname } from 'node:path'

import {
  CapabilityRegistry,
  PresetRegistry,
  type AvailableCapabilities,
  type PublishError,
} from '@yokai-internal/core'
import {
  CapabilityProtocolVersion,
  PresetSource,
  PresetSourceId,
  type PresetCandidate,
} from 'yokai-protocol'
import { Context, Duration, Effect, Layer, Option, Schema, Stream } from 'effect'
import { parse } from 'yaml'

import { FilePresetStore, type FileSystemError } from './file-store'

export const FILE_PRESET_SOURCE_ID = PresetSourceId.make('builtin.file')

const FILE_PRESET_SOURCE = PresetSource.make({
  id: FILE_PRESET_SOURCE_ID,
  protocolVersion: CapabilityProtocolVersion.make({ major: 0, minor: 1 }),
})

export class DecodeError extends Schema.TaggedError<DecodeError>(
  '@yokai/koishi-plugin-yokai/FilePresetSource.DecodeError',
)('FilePresetDecodeError', {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface Options {
  readonly directory: Option.Option<string>
  readonly debounceMs: number
}

export interface Interface {
  readonly reload: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/koishi-plugin-yokai/FilePresetSource',
) {}

const parseCandidate = Effect.fn('FilePresetSource.parseCandidate')(function* (
  path: string,
  content: string,
) {
  const parsed = yield* Effect.try({
    try: () => (extname(path).toLowerCase() === '.json' ? JSON.parse(content) : parse(content)),
    catch: (cause) => new DecodeError({ path, cause }),
  })
  return yield* Schema.decodeUnknownEffect(Schema.Json)(parsed).pipe(
    Effect.mapError((cause) => new DecodeError({ path, cause })),
  )
})

const availableCapabilities = (
  snapshot: CapabilityRegistry.TurnCapabilitySnapshot,
): AvailableCapabilities => ({
  skills: snapshot.skills.map((capability) => capability.id),
  actionTools: snapshot.actionTools.map((capability) => capability.id),
  feedbackTools: snapshot.feedbackTools.map((capability) => capability.id),
})

const logFileFailure = (path: string, error: FileSystemError | DecodeError | PublishError) =>
  Effect.logWarning('FilePresetSource.file_ignored').pipe(
    Effect.annotateLogs({ path, errorTag: error._tag }),
  )

const make = Effect.fn('FilePresetSource.make')(function* (options: Options) {
  if (Option.isNone(options.directory)) {
    return Service.of({ reload: () => Effect.void })
  }

  const directory = options.directory.value
  const store = yield* FilePresetStore.Service
  const capabilities = yield* CapabilityRegistry.Service
  const presets = yield* PresetRegistry.Service
  yield* store.ensureDirectory(directory)

  const capabilityRegistration = yield* capabilities.registerPresetSource(FILE_PRESET_SOURCE)
  const sourceRegistration = yield* presets
    .registerSource(FILE_PRESET_SOURCE_ID)
    .pipe(Effect.tapError(() => capabilityRegistration.unregister()))
  yield* Effect.addFinalizer(() =>
    sourceRegistration
      .unregister()
      .pipe(Effect.andThen(capabilityRegistration.unregister()), Effect.asVoid),
  )

  const reload = Effect.fn('FilePresetSource.reload')(function* () {
    const files = yield* store
      .files(directory)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning('FilePresetSource.scan_failed').pipe(
            Effect.annotateLogs({ path: directory, errorTag: error._tag }),
            Effect.as<ReadonlyArray<string>>([]),
          ),
        ),
      )
    const capabilitySnapshot = yield* capabilities.snapshot()
    const available = availableCapabilities(capabilitySnapshot)
    yield* Effect.forEach(
      files,
      (path) =>
        store.read(path).pipe(
          Effect.flatMap((content) => parseCandidate(path, content)),
          Effect.flatMap((candidate: PresetCandidate) =>
            sourceRegistration.publish(candidate, available),
          ),
          Effect.catch((error) => logFileFailure(path, error)),
        ),
      { discard: true },
    )
  })

  const capabilityChanges = capabilities.changes.pipe(Stream.map(() => undefined))
  yield* store.changes(directory).pipe(
    Stream.merge(capabilityChanges),
    Stream.debounce(Duration.millis(options.debounceMs)),
    Stream.runForEach(() => reload()),
    Effect.catch((error) =>
      Effect.logError('FilePresetSource.watch_failed').pipe(
        Effect.annotateLogs({ path: directory, errorTag: error._tag }),
      ),
    ),
    Effect.forkScoped,
  )
  yield* reload()

  return Service.of({ reload })
})

export const layer = (options: Options) => Layer.effect(Service, make(options))

export * as FilePresetSource from './file-source'
