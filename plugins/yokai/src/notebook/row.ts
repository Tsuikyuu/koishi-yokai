import { MessageArchiveEvent, NotebookModel } from '@yokai-internal/memory'
import { Effect, Option, Schema } from 'effect'

import type { YokaiMemoryRow } from './model'

const NoteTopicsJson = Schema.fromJsonString(NotebookModel.NoteTopics)
const NoteSourcesJson = Schema.fromJsonString(NotebookModel.NoteSources)

const decodeNote = Schema.decodeUnknownEffect(NotebookModel.Note)
const decodeTopics = Schema.decodeUnknownEffect(NoteTopicsJson)
const decodeSources = Schema.decodeUnknownEffect(NoteSourcesJson)
const encodeTopics = Schema.encodeEffect(NoteTopicsJson)
const encodeSources = Schema.encodeEffect(NoteSourcesJson)

const nullableString = <A extends string>(value: Option.Option<A>): A | null =>
  Option.match(value, {
    onNone: () => null,
    onSome: (item) => item,
  })

const nullableTimestamp = (value: Option.Option<MessageArchiveEvent.Timestamp>): Date | null =>
  Option.match(value, {
    onNone: () => null,
    onSome: (timestamp) => new Date(timestamp),
  })

export const decode = Effect.fn('KoishiNotebookRow.decode')(function* (row: YokaiMemoryRow) {
  const topics = yield* decodeTopics(row.topicsJson)
  const sourceMessageIds = yield* decodeSources(row.sourceMessageIdsJson)
  return yield* decodeNote({
    instanceId: row.instanceId,
    platform: row.platform,
    guildId: row.guildId,
    channelId: row.channelId,
    noteId: row.noteId,
    kind: row.kind,
    objectId: row.objectId,
    content: row.content,
    topics,
    sourceMessageIds,
    confidence: row.confidence,
    importance: row.importance,
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt === null ? null : row.expiresAt.getTime(),
    correctsNoteId: row.correctsNoteId,
    supersededByNoteId: row.supersededByNoteId,
  })
})

export const encode = Effect.fn('KoishiNotebookRow.encode')(function* (note: NotebookModel.Note) {
  const topicsJson = yield* encodeTopics(note.topics)
  const sourceMessageIdsJson = yield* encodeSources(note.sourceMessageIds)
  return {
    instanceId: note.instanceId,
    platform: note.platform,
    guildId: note.guildId,
    channelId: note.channelId,
    noteId: note.noteId,
    kind: note.kind,
    objectId: nullableString(note.objectId),
    content: note.content,
    topicsJson,
    sourceMessageIdsJson,
    confidence: note.confidence,
    importance: note.importance,
    createdAt: new Date(note.createdAt),
    expiresAt: nullableTimestamp(note.expiresAt),
    correctsNoteId: nullableString(note.correctsNoteId),
    supersededByNoteId: nullableString(note.supersededByNoteId),
  } satisfies YokaiMemoryRow
})

export * as YokaiNotebookRowCodec from './row'
