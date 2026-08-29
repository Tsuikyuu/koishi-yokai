import { createHash } from 'node:crypto'

import {
  PresetContentHash,
  PresetDefinition,
  PresetLoadedAt,
  PresetSnapshot,
  PresetVersion,
  type ActionToolId,
  type FeedbackToolId,
  type PresetCandidate,
  type PresetId,
  type PresetSourceId,
  type SkillId,
} from 'yokai-protocol'
import {
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  PubSub,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from 'effect'

import { PersonaCompiler } from './compiler'

export interface AvailableCapabilities {
  readonly skills: ReadonlyArray<SkillId>
  readonly actionTools: ReadonlyArray<ActionToolId>
  readonly feedbackTools: ReadonlyArray<FeedbackToolId>
}

export const ReferencedCapabilityDomain = Schema.Literals(['skill', 'action-tool', 'feedback-tool'])

export type ReferencedCapabilityDomain = typeof ReferencedCapabilityDomain.Type

export class InvalidDefinitionError extends Schema.TaggedError<InvalidDefinitionError>(
  '@yokai/core/PresetRegistry.InvalidDefinitionError',
)('PresetInvalidDefinitionError', {
  sourceId: Schema.String,
}) {}

export class CapabilityUnavailableError extends Schema.TaggedError<CapabilityUnavailableError>(
  '@yokai/core/PresetRegistry.CapabilityUnavailableError',
)('PresetCapabilityUnavailableError', {
  sourceId: Schema.String,
  presetId: Schema.String,
  domain: ReferencedCapabilityDomain,
  capabilityId: Schema.String,
}) {}

export class PresetOwnershipConflictError extends Schema.TaggedError<PresetOwnershipConflictError>(
  '@yokai/core/PresetRegistry.PresetOwnershipConflictError',
)('PresetOwnershipConflictError', {
  presetId: Schema.String,
  ownerSourceId: Schema.String,
  candidateSourceId: Schema.String,
}) {}

export class SourceConflictError extends Schema.TaggedError<SourceConflictError>(
  '@yokai/core/PresetRegistry.SourceConflictError',
)('PresetSourceConflictError', {
  sourceId: Schema.String,
}) {}

export type PublishError =
  InvalidDefinitionError | CapabilityUnavailableError | PresetOwnershipConflictError

export interface SourceRegistration {
  readonly publish: (
    candidate: PresetCandidate,
    capabilities: AvailableCapabilities,
  ) => Effect.Effect<boolean, PublishError>
  readonly unregister: () => Effect.Effect<boolean>
}

export interface Interface {
  readonly registerSource: (
    sourceId: PresetSourceId,
  ) => Effect.Effect<SourceRegistration, SourceConflictError>
  readonly snapshot: (presetId: PresetId) => Effect.Effect<Option.Option<PresetSnapshot>>
  readonly snapshots: () => Effect.Effect<ReadonlyArray<PresetSnapshot>>
  readonly updates: Stream.Stream<PresetSnapshot>
}

export class Service extends Context.Service<Service, Interface>()('@yokai/core/PresetRegistry') {}

interface RegisteredSource {
  readonly key: number
  readonly id: PresetSourceId
}

interface State {
  readonly nextSourceKey: number
  readonly sources: ReadonlyArray<RegisteredSource>
  readonly snapshots: ReadonlyArray<PresetSnapshot>
}

const initialState = (): State => ({
  nextSourceKey: 1,
  sources: [],
  snapshots: [],
})

const freezePersona = (persona: PresetDefinition['persona']): PresetDefinition['persona'] =>
  Object.freeze({
    ...persona,
    values: Object.freeze([...persona.values]),
    interests: Object.freeze([...persona.interests]),
    opinions: Object.freeze([...persona.opinions]),
    socialBoundaries: Object.freeze([...persona.socialBoundaries]),
    knowledgeBoundaries: Object.freeze([...persona.knowledgeBoundaries]),
  })

const freezeDefinition = (definition: PresetDefinition): PresetDefinition =>
  Object.freeze({
    ...definition,
    persona: freezePersona(definition.persona),
    skills: Object.freeze([...definition.skills]),
    actionTools: Object.freeze([...definition.actionTools]),
    feedbackTools: Object.freeze([...definition.feedbackTools]),
  })

const freezeSnapshot = (snapshot: PresetSnapshot): PresetSnapshot =>
  Object.freeze({
    ...snapshot,
    persona: freezePersona(snapshot.persona),
    skills: Object.freeze([...snapshot.skills]),
    actionTools: Object.freeze([...snapshot.actionTools]),
    feedbackTools: Object.freeze([...snapshot.feedbackTools]),
  })

const contentHash = (definition: PresetDefinition): PresetContentHash =>
  PresetContentHash.make(
    createHash('sha256').update(JSON.stringify(definition), 'utf8').digest('hex'),
  )

const nextVersion = (current: PresetSnapshot | undefined): PresetVersion =>
  PresetVersion.make(current === undefined ? 1 : current.version + 1)

const compareSnapshots = (left: PresetSnapshot, right: PresetSnapshot): number => {
  if (left.id < right.id) return -1
  if (left.id > right.id) return 1
  return 0
}

const validateReferences = (
  sourceId: PresetSourceId,
  definition: PresetDefinition,
  capabilities: AvailableCapabilities,
): Effect.Effect<void, CapabilityUnavailableError> => {
  const missingSkill = definition.skills.find((id) => !capabilities.skills.includes(id))
  if (missingSkill !== undefined) {
    return Effect.fail(
      new CapabilityUnavailableError({
        sourceId,
        presetId: definition.id,
        domain: 'skill',
        capabilityId: missingSkill,
      }),
    )
  }

  const missingActionTool = definition.actionTools.find(
    (id) => !capabilities.actionTools.includes(id),
  )
  if (missingActionTool !== undefined) {
    return Effect.fail(
      new CapabilityUnavailableError({
        sourceId,
        presetId: definition.id,
        domain: 'action-tool',
        capabilityId: missingActionTool,
      }),
    )
  }

  const missingFeedbackTool = definition.feedbackTools.find(
    (id) => !capabilities.feedbackTools.includes(id),
  )
  return missingFeedbackTool === undefined
    ? Effect.void
    : Effect.fail(
        new CapabilityUnavailableError({
          sourceId,
          presetId: definition.id,
          domain: 'feedback-tool',
          capabilityId: missingFeedbackTool,
        }),
      )
}

const decodeCandidate = (
  sourceId: PresetSourceId,
  candidate: PresetCandidate,
): Effect.Effect<PresetDefinition, InvalidDefinitionError> =>
  Schema.decodeUnknownEffect(PresetDefinition)(candidate).pipe(
    Effect.map(freezeDefinition),
    Effect.mapError(() => new InvalidDefinitionError({ sourceId })),
  )

const make = Effect.fn('PresetRegistry.make')(function* () {
  const stateRef = yield* Ref.make(initialState())
  const updatePubSub = yield* PubSub.unbounded<PresetSnapshot>()
  yield* Effect.addFinalizer(() => PubSub.shutdown(updatePubSub))
  const gate = yield* Semaphore.make(1)

  const publish = Effect.fn('PresetRegistry.publish')(function* (
    source: RegisteredSource,
    candidate: PresetCandidate,
    capabilities: AvailableCapabilities,
  ) {
    return yield* gate.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef)
          const active = state.sources.some(
            (registered) => registered.key === source.key && registered.id === source.id,
          )
          if (!active) return false

          const definition = yield* decodeCandidate(source.id, candidate)
          yield* validateReferences(source.id, definition, capabilities)
          const hash = contentHash(definition)
          const current = state.snapshots.find((snapshot) => snapshot.id === definition.id)
          if (current !== undefined && current.sourceId !== source.id) {
            return yield* Effect.fail(
              new PresetOwnershipConflictError({
                presetId: definition.id,
                ownerSourceId: current.sourceId,
                candidateSourceId: source.id,
              }),
            )
          }

          if (current !== undefined && current.contentHash === hash) {
            if (!current.sourceAvailable) {
              const restored = freezeSnapshot({ ...current, sourceAvailable: true })
              yield* Ref.set(stateRef, {
                ...state,
                snapshots: state.snapshots.map((snapshot) =>
                  snapshot.id === restored.id ? restored : snapshot,
                ),
              })
            }
            return false
          }

          const loadedAt = PresetLoadedAt.make(yield* Clock.currentTimeMillis)
          const snapshot = freezeSnapshot(
            PresetSnapshot.make({
              id: definition.id,
              version: nextVersion(current),
              contentHash: hash,
              persona: definition.persona,
              skills: definition.skills,
              actionTools: definition.actionTools,
              feedbackTools: definition.feedbackTools,
              compiledPrompt: PersonaCompiler.compile(definition.persona),
              loadedAt,
              sourceId: source.id,
              sourceAvailable: true,
            }),
          )
          const retained = state.snapshots.filter((existing) => existing.id !== snapshot.id)
          yield* Ref.set(stateRef, {
            ...state,
            snapshots: [...retained, snapshot].sort(compareSnapshots),
          })
          yield* PubSub.publish(updatePubSub, snapshot)
          return true
        }),
      ),
    )
  })

  const unregister = Effect.fn('PresetRegistry.unregisterSource')(function* (
    source: RegisteredSource,
  ) {
    return yield* gate.withPermit(
      Ref.modify(stateRef, (state) => {
        const active = state.sources.some(
          (registered) => registered.key === source.key && registered.id === source.id,
        )
        if (!active) return [false, state]
        return [
          true,
          {
            ...state,
            sources: state.sources.filter((registered) => registered.key !== source.key),
            snapshots: state.snapshots.map((snapshot) =>
              snapshot.sourceId === source.id
                ? freezeSnapshot({ ...snapshot, sourceAvailable: false })
                : snapshot,
            ),
          },
        ]
      }),
    )
  })

  const registerSource = Effect.fn('PresetRegistry.registerSource')(function* (
    sourceId: PresetSourceId,
  ) {
    return yield* gate.withPermit(
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef)
        if (state.sources.some((source) => source.id === sourceId)) {
          return yield* Effect.fail(new SourceConflictError({ sourceId }))
        }
        const source: RegisteredSource = { key: state.nextSourceKey, id: sourceId }
        yield* Ref.set(stateRef, {
          ...state,
          nextSourceKey: state.nextSourceKey + 1,
          sources: [...state.sources, source],
        })
        return {
          publish: (candidate, capabilities) => publish(source, candidate, capabilities),
          unregister: () => unregister(source),
        } satisfies SourceRegistration
      }),
    )
  })

  const snapshot = Effect.fn('PresetRegistry.snapshot')(function* (presetId: PresetId) {
    const state = yield* Ref.get(stateRef)
    return Option.fromUndefinedOr(state.snapshots.find((candidate) => candidate.id === presetId))
  })

  const snapshots = Effect.fn('PresetRegistry.snapshots')(function* () {
    return (yield* Ref.get(stateRef)).snapshots
  })

  return Service.of({
    registerSource,
    snapshot,
    snapshots,
    updates: Stream.fromPubSub(updatePubSub),
  })
})

export const layer = Layer.effect(Service, make())

export * as PresetRegistry from './registry'
