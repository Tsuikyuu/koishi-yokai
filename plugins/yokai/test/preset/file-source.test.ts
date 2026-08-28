import { expect, it } from '@effect/vitest'
import { CapabilityRegistry, PresetRegistry } from '@yokai-internal/core'
import { CapabilityProtocolVersion, PresetId, Skill, SkillId } from 'yokai-protocol'
import { Deferred, Effect, Fiber, Layer, Option, Queue, Ref, Stream } from 'effect'
import { TestClock } from 'effect/testing'

import { FilePresetSource } from '../../src/preset/file-source'
import { FilePresetStore, FileSystemError } from '../../src/preset/file-store'

const FILE = '/virtual/presets/koharu.yaml'

const yamlPreset = (name: string, skill: string | undefined = undefined): string => `
id: koharu
persona:
  name: ${name}
  selfConcept: A curious long-time member of the group.
  background: Grew up around a small neighborhood library.
  values:
    - honesty
    - patience
  interests:
    - folklore
    - tea
  opinions:
    - Small practical help is better than grand promises.
  speakingStyle: Warm, concise, and lightly playful.
  socialBoundaries:
    - Do not pressure people to disclose private matters.
  knowledgeBoundaries:
    - Admit when a fact is not known.
${skill === undefined ? '' : `skills:\n  - ${skill}\n`}
`

interface FileEntry {
  readonly path: string
  readonly content: string
}

const testLayer = (
  entries: Ref.Ref<ReadonlyArray<FileEntry>>,
  changes: Queue.Queue<void>,
  observed: Deferred.Deferred<void>,
) => {
  const store = FilePresetStore.Service.of({
    ensureDirectory: () => Effect.void,
    files: () => Ref.get(entries).pipe(Effect.map((current) => current.map((entry) => entry.path))),
    read: (path) =>
      Ref.get(entries).pipe(
        Effect.flatMap((current) => {
          const entry = current.find((candidate) => candidate.path === path)
          return entry === undefined
            ? Effect.fail(
                new FileSystemError({
                  operation: 'read-file',
                  path,
                  cause: new Error('missing test file'),
                }),
              )
            : Effect.succeed(entry.content)
        }),
      ),
    changes: () =>
      Stream.fromQueue(changes).pipe(Stream.tap(() => Deferred.succeed(observed, undefined))),
  })
  const foundation = Layer.merge(CapabilityRegistry.layer, PresetRegistry.layer)
  return FilePresetSource.layer({
    directory: Option.some('/virtual/presets'),
    debounceMs: 100,
  }).pipe(
    Layer.provide(Layer.succeed(FilePresetStore.Service, store)),
    Layer.provideMerge(foundation),
  )
}

const currentPreset = Effect.fn('FilePresetSourceTest.currentPreset')(function* () {
  const presets = yield* PresetRegistry.Service
  const snapshot = yield* presets.snapshot(PresetId.make('koharu'))
  if (Option.isNone(snapshot)) return yield* Effect.die('Expected a loaded file preset')
  return snapshot.value
})

it.effect('loads YAML, debounces file events, and retains the last valid version', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entries = yield* Ref.make<ReadonlyArray<FileEntry>>([
        { path: FILE, content: yamlPreset('Koharu') },
      ])
      const changes = yield* Queue.unbounded<void>()
      const observed = yield* Deferred.make<void>()

      yield* Effect.gen(function* () {
        const source = yield* FilePresetSource.Service
        const presets = yield* PresetRegistry.Service
        const initial = yield* currentPreset()
        expect(initial.version).toBe(1)
        expect(initial.persona.name).toBe('Koharu')

        const updateFiber = yield* presets.updates.pipe(Stream.runHead, Effect.forkScoped)
        yield* Effect.yieldNow
        yield* Ref.set(entries, [{ path: FILE, content: yamlPreset('Haru') }])
        yield* Queue.offer(changes, undefined)
        yield* Deferred.await(observed)
        yield* TestClock.adjust('99 millis')
        expect((yield* currentPreset()).version).toBe(1)
        yield* TestClock.adjust('1 millis')

        const update = yield* Fiber.join(updateFiber)
        if (Option.isNone(update)) return yield* Effect.die('Expected a preset update event')
        expect(update.value.version).toBe(2)
        expect(update.value.persona.name).toBe('Haru')

        yield* Ref.set(entries, [{ path: FILE, content: 'id: [malformed' }])
        yield* source.reload()
        const retained = yield* currentPreset()
        expect(retained.version).toBe(2)
        expect(retained.persona.name).toBe('Haru')

        yield* Ref.set(entries, [{ path: FILE, content: yamlPreset('Haru') }])
        yield* source.reload()
        expect((yield* currentPreset()).version).toBe(2)
      }).pipe(Effect.provide(testLayer(entries, changes, observed)))
    }),
  ),
)

it.effect('retries a valid file when a referenced capability is installed later', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entries = yield* Ref.make<ReadonlyArray<FileEntry>>([
        { path: FILE, content: yamlPreset('Koharu', 'late.skill') },
      ])
      const changes = yield* Queue.unbounded<void>()
      const observed = yield* Deferred.make<void>()

      yield* Effect.gen(function* () {
        const presets = yield* PresetRegistry.Service
        const initial = yield* presets.snapshot(PresetId.make('koharu'))
        expect(Option.isNone(initial)).toBe(true)

        const updateFiber = yield* presets.updates.pipe(Stream.runHead, Effect.forkScoped)
        yield* Effect.yieldNow
        const capabilities = yield* CapabilityRegistry.Service
        yield* capabilities.registerSkill(
          Skill.make({
            id: SkillId.make('late.skill'),
            protocolVersion: CapabilityProtocolVersion.make({ major: 0, minor: 1 }),
          }),
        )
        yield* Effect.yieldNow
        yield* TestClock.adjust('100 millis')

        const update = yield* Fiber.join(updateFiber)
        if (Option.isNone(update)) return yield* Effect.die('Expected the preset to retry')
        expect(update.value.persona.name).toBe('Koharu')
        expect(update.value.skills).toEqual(['late.skill'])
      }).pipe(Effect.provide(testLayer(entries, changes, observed)))
    }),
  ),
)
