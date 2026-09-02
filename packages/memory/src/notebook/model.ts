import { Option, Schema } from 'effect'

import { ChannelScope, MessageId, Timestamp } from '../message-archive/event'

export const MAX_NOTE_CONTENT_LENGTH = 2_048
export const MAX_NOTE_OBJECT_ID_LENGTH = 512
export const MAX_NOTE_TOPIC_LENGTH = 128
export const MAX_NOTE_TOPICS = 8
export const MAX_NOTE_SOURCES = 8
export const MAX_NOTES_PER_REPLY = 8
export const MAX_RECALL_LIMIT = 32

export const LOW_CONFIDENCE_THRESHOLD = 0.35
export const CERTAIN_CONFIDENCE_THRESHOLD = 0.7
export const DEFAULT_NOTE_CONFIDENCE = 0.75
export const DEFAULT_NOTE_IMPORTANCE = 0.5

export const NoteId = Schema.String.check(Schema.isPattern(/^note_[a-f0-9]{32}$/)).pipe(
  Schema.brand('@yokai/memory/NoteId'),
)

export type NoteId = typeof NoteId.Type

export const NoteKind = Schema.Literals(['episode', 'fact', 'relationship', 'self'])
export type NoteKind = typeof NoteKind.Type

export const NoteObjectId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_NOTE_OBJECT_ID_LENGTH),
  Schema.isPattern(/^[^\p{C}]+$/u),
).pipe(Schema.brand('@yokai/memory/NoteObjectId'))

export type NoteObjectId = typeof NoteObjectId.Type

export const NoteContent = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_NOTE_CONTENT_LENGTH),
).pipe(Schema.brand('@yokai/memory/NoteContent'))

export type NoteContent = typeof NoteContent.Type

export const NoteTopic = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_NOTE_TOPIC_LENGTH),
).pipe(Schema.brand('@yokai/memory/NoteTopic'))

export type NoteTopic = typeof NoteTopic.Type

export const NoteTopics = Schema.Array(NoteTopic).check(
  Schema.isMaxLength(MAX_NOTE_TOPICS),
  Schema.isUnique(),
)

export type NoteTopics = typeof NoteTopics.Type

export const NoteSources = Schema.Array(MessageId).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_NOTE_SOURCES),
  Schema.isUnique(),
)

export type NoteSources = typeof NoteSources.Type

export const Confidence = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(
  Schema.brand('@yokai/memory/Confidence'),
)

export type Confidence = typeof Confidence.Type

export const Importance = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(
  Schema.brand('@yokai/memory/Importance'),
)

export type Importance = typeof Importance.Type

export const NotesPerReply = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_NOTES_PER_REPLY }),
).pipe(Schema.brand('@yokai/memory/NotesPerReply'))

export type NotesPerReply = typeof NotesPerReply.Type

export const RecallLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_RECALL_LIMIT }),
).pipe(Schema.brand('@yokai/memory/RecallLimit'))

export type RecallLimit = typeof RecallLimit.Type

export const ExpirationDays = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 3_650 }),
).pipe(Schema.brand('@yokai/memory/ExpirationDays'))

export type ExpirationDays = typeof ExpirationDays.Type

export const Note = Schema.Struct({
  ...ChannelScope.fields,
  noteId: NoteId,
  kind: NoteKind,
  objectId: Schema.OptionFromNullOr(NoteObjectId),
  content: NoteContent,
  topics: NoteTopics,
  sourceMessageIds: NoteSources,
  confidence: Confidence,
  importance: Importance,
  createdAt: Timestamp,
  expiresAt: Schema.OptionFromNullOr(Timestamp),
  correctsNoteId: Schema.OptionFromNullOr(NoteId),
  supersededByNoteId: Schema.OptionFromNullOr(NoteId),
})

export interface Note extends Schema.Schema.Type<typeof Note> {}

export const WriteProposal = Schema.Struct({
  kind: NoteKind,
  objectId: Schema.OptionFromNullOr(NoteObjectId),
  content: NoteContent,
  topics: NoteTopics,
  sourceMessageIds: NoteSources,
  confidence: Confidence,
  importance: Importance,
  expiresAt: Schema.OptionFromNullOr(Timestamp),
  correctsNoteId: Schema.OptionFromNullOr(NoteId),
})

export interface WriteProposal extends Schema.Schema.Type<typeof WriteProposal> {}

export const RecallQuery = Schema.Struct({
  scope: ChannelScope,
  topics: NoteTopics,
  objectIds: Schema.Array(NoteObjectId).check(
    Schema.isMaxLength(MAX_NOTE_SOURCES),
    Schema.isUnique(),
  ),
  at: Timestamp,
  limit: RecallLimit,
})

export interface RecallQuery extends Schema.Schema.Type<typeof RecallQuery> {}

export const RecallRequest = Schema.Struct({
  scope: ChannelScope,
  topics: NoteTopics,
  objectIds: RecallQuery.fields.objectIds,
})

export interface RecallRequest extends Schema.Schema.Type<typeof RecallRequest> {}

export const EvidenceRequest = Schema.Struct({
  scope: ChannelScope,
  kind: NoteKind,
  limit: RecallLimit,
})

export interface EvidenceRequest extends Schema.Schema.Type<typeof EvidenceRequest> {}

/** Content-free proof that a recallable note exists in the requested channel scope. */
export const NoteEvidence = Schema.Struct({
  noteId: NoteId,
  kind: NoteKind,
  createdAt: Timestamp,
})

export interface NoteEvidence extends Schema.Schema.Type<typeof NoteEvidence> {}

export const RecalledNote = Schema.Struct({
  note: Note,
  uncertain: Schema.Boolean,
})

export interface RecalledNote extends Schema.Schema.Type<typeof RecalledNote> {}

export const WriteReport = Schema.Struct({
  proposed: Schema.Natural,
  stored: Schema.Natural,
  skippedMissingSource: Schema.Natural,
  skippedInvalidCorrection: Schema.Natural,
  skippedExpired: Schema.Natural,
  replayed: Schema.Natural,
})

export interface WriteReport extends Schema.Schema.Type<typeof WriteReport> {}

export const emptyWriteReport = (proposed: number): WriteReport =>
  WriteReport.make({
    proposed,
    stored: 0,
    skippedMissingSource: 0,
    skippedInvalidCorrection: 0,
    skippedExpired: 0,
    replayed: 0,
  })

export const isActive = (note: Note, at: Timestamp): boolean =>
  Option.isNone(note.supersededByNoteId) &&
  (Option.isNone(note.expiresAt) || note.expiresAt.value > at)

export const isRecallable = (note: Note, at: Timestamp): boolean =>
  isActive(note, at) && note.confidence >= LOW_CONFIDENCE_THRESHOLD

export const isUncertain = (note: Note): boolean => note.confidence < CERTAIN_CONFIDENCE_THRESHOLD

export * as NotebookModel from './model'
