import { expect, it } from '@effect/vitest'
import { PresetId, PresetSourceId, type PresetCandidate } from 'yokai-protocol'
import { Effect, Option } from 'effect'
import { TestClock } from 'effect/testing'

import { PresetRegistry, type AvailableCapabilities } from '../../src/index'

const AVAILABLE: AvailableCapabilities = {
  skills: [],
  actionTools: [],
  feedbackTools: [],
}

const candidate = (name: string, skills: ReadonlyArray<string> = []): PresetCandidate => ({
  id: 'koharu',
  persona: {
    name,
    selfConcept: 'A curious long-time member of the group.',
    background: 'Grew up around a small neighborhood library.',
    values: ['honesty', 'patience'],
    interests: ['folklore', 'tea'],
    opinions: ['Small practical help is better than grand promises.'],
    speakingStyle: 'Warm, concise, and lightly playful.',
    socialBoundaries: ['Do not pressure people to disclose private matters.'],
    knowledgeBoundaries: ['Admit when a fact is not known.'],
  },
  skills,
})

const getSnapshot = Effect.fn('PresetRegistryTest.getSnapshot')(function* () {
  const registry = yield* PresetRegistry.Service
  const snapshot = yield* registry.snapshot(PresetId.make('koharu'))
  if (Option.isNone(snapshot)) return yield* Effect.die('Expected a preset snapshot')
  return snapshot.value
})

it.effect('atomically versions changed content and keeps old snapshots immutable', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(1_000)
    const registry = yield* PresetRegistry.Service
    const source = yield* registry.registerSource(PresetSourceId.make('test.file'))

    expect(yield* source.publish(candidate('Koharu'), AVAILABLE)).toBe(true)
    const first = yield* getSnapshot()
    expect(first.version).toBe(1)
    expect(first.loadedAt).toBe(1_000)
    expect(first.compiledPrompt).toContain('Name:\nKoharu')
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.persona.values)).toBe(true)

    expect(yield* source.publish(candidate('Koharu'), AVAILABLE)).toBe(false)
    expect((yield* getSnapshot()).version).toBe(1)

    yield* TestClock.setTime(2_000)
    expect(yield* source.publish(candidate('Haru'), AVAILABLE)).toBe(true)
    const second = yield* getSnapshot()
    expect(second.version).toBe(2)
    expect(second.loadedAt).toBe(2_000)
    expect(second.contentHash).not.toBe(first.contentHash)
    expect(second.persona.name).toBe('Haru')
    expect(first.persona.name).toBe('Koharu')
    expect(first.version).toBe(1)
  }).pipe(Effect.provide(PresetRegistry.layer)),
)

it.effect('retains the last valid snapshot after malformed content or missing capabilities', () =>
  Effect.gen(function* () {
    const registry = yield* PresetRegistry.Service
    const source = yield* registry.registerSource(PresetSourceId.make('test.file'))
    yield* source.publish(candidate('Koharu'), AVAILABLE)
    const valid = yield* getSnapshot()

    const malformed = yield* source
      .publish({ id: 'koharu', persona: { name: 'incomplete' } }, AVAILABLE)
      .pipe(Effect.flip)
    expect(malformed._tag).toBe('PresetInvalidDefinitionError')

    const missingCapability = yield* source
      .publish(candidate('Changed', ['missing.skill']), AVAILABLE)
      .pipe(Effect.flip)
    expect(missingCapability).toMatchObject({
      _tag: 'PresetCapabilityUnavailableError',
      domain: 'skill',
      capabilityId: 'missing.skill',
    })

    expect(yield* getSnapshot()).toBe(valid)
  }).pipe(Effect.provide(PresetRegistry.layer)),
)

it.effect('keeps the last snapshot offline and rejects stale source handles', () =>
  Effect.gen(function* () {
    const registry = yield* PresetRegistry.Service
    const first = yield* registry.registerSource(PresetSourceId.make('test.file'))
    yield* first.publish(candidate('Koharu'), AVAILABLE)

    expect(yield* first.unregister()).toBe(true)
    expect((yield* getSnapshot()).sourceAvailable).toBe(false)
    expect(yield* first.publish(candidate('Changed'), AVAILABLE)).toBe(false)
    expect((yield* getSnapshot()).persona.name).toBe('Koharu')

    const replacement = yield* registry.registerSource(PresetSourceId.make('test.file'))
    expect(yield* replacement.publish(candidate('Koharu'), AVAILABLE)).toBe(false)
    const restored = yield* getSnapshot()
    expect(restored.sourceAvailable).toBe(true)
    expect(restored.version).toBe(1)
  }).pipe(Effect.provide(PresetRegistry.layer)),
)

it.effect('does not let a different source silently take over an existing preset ID', () =>
  Effect.gen(function* () {
    const registry = yield* PresetRegistry.Service
    const owner = yield* registry.registerSource(PresetSourceId.make('owner'))
    const candidateSource = yield* registry.registerSource(PresetSourceId.make('candidate'))
    yield* owner.publish(candidate('Koharu'), AVAILABLE)

    const conflict = yield* candidateSource
      .publish(candidate('Impostor'), AVAILABLE)
      .pipe(Effect.flip)
    expect(conflict).toMatchObject({
      _tag: 'PresetOwnershipConflictError',
      presetId: 'koharu',
      ownerSourceId: 'owner',
      candidateSourceId: 'candidate',
    })
    expect((yield* getSnapshot()).persona.name).toBe('Koharu')
  }).pipe(Effect.provide(PresetRegistry.layer)),
)
