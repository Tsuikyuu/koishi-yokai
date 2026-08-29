import { Effect, Schema } from 'effect'

import { ActionToolId, PresetSourceId, SkillId } from './capability'
import { FeedbackToolId } from '../llm-adapter/identity'

const presetIdChecks = [
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9._-]*$/),
] as const

export const PresetId = Schema.String.check(...presetIdChecks).pipe(
  Schema.brand('@yokai/protocol/PresetId'),
)

export type PresetId = typeof PresetId.Type

const PersonaText = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(8_192),
)

const PersonaStatement = PersonaText.check(Schema.isMaxLength(2_048))

const PersonaStatements = Schema.Array(PersonaStatement).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isUnique(),
)

export const Persona = Schema.Struct({
  name: PersonaText.check(Schema.isMaxLength(128)),
  selfConcept: PersonaText,
  background: PersonaText,
  values: PersonaStatements,
  interests: PersonaStatements,
  opinions: PersonaStatements,
  speakingStyle: PersonaText,
  socialBoundaries: PersonaStatements,
  knowledgeBoundaries: PersonaStatements,
})

export interface Persona extends Schema.Schema.Type<typeof Persona> {}

const SkillReferences = Schema.Array(SkillId).check(Schema.isMaxLength(64), Schema.isUnique())

const ActionToolReferences = Schema.Array(ActionToolId).check(
  Schema.isMaxLength(64),
  Schema.isUnique(),
)

const FeedbackToolReferences = Schema.Array(FeedbackToolId).check(
  Schema.isMaxLength(64),
  Schema.isUnique(),
)

export const PresetDefinition = Schema.Struct({
  id: PresetId,
  persona: Persona,
  skills: SkillReferences.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  actionTools: ActionToolReferences.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  feedbackTools: FeedbackToolReferences.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
})

export interface PresetDefinition extends Schema.Schema.Type<typeof PresetDefinition> {}

export type PresetCandidate = Schema.Json

export const PresetVersion = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand('@yokai/protocol/PresetVersion'),
)

export type PresetVersion = typeof PresetVersion.Type

export const PresetContentHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(
  Schema.brand('@yokai/protocol/PresetContentHash'),
)

export type PresetContentHash = typeof PresetContentHash.Type

export const PresetLoadedAt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand('@yokai/protocol/PresetLoadedAt'),
)

export type PresetLoadedAt = typeof PresetLoadedAt.Type

export const PresetSnapshot = Schema.Struct({
  id: PresetId,
  version: PresetVersion,
  contentHash: PresetContentHash,
  persona: Persona,
  skills: SkillReferences,
  actionTools: ActionToolReferences,
  feedbackTools: FeedbackToolReferences,
  compiledPrompt: Schema.NonEmptyString,
  loadedAt: PresetLoadedAt,
  sourceId: PresetSourceId,
  sourceAvailable: Schema.Boolean,
})

export interface PresetSnapshot extends Schema.Schema.Type<typeof PresetSnapshot> {}
