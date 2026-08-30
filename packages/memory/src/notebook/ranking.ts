import { Option } from 'effect'

import { type RecallQuery, type Note, isRecallable, isUncertain } from './model'

const DAY_MS = 24 * 60 * 60 * 1_000
const RECENCY_WINDOW_DAYS = 30

const normalizedTerms = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  values.map((value) => value.toLowerCase())

const topicScore = (note: Note, query: RecallQuery): number => {
  const queryTerms = normalizedTerms(query.topics)
  const noteTopics = normalizedTerms(note.topics)
  const content = note.content.toLowerCase()
  return queryTerms.reduce(
    (score, term) => score + (noteTopics.includes(term) ? 4 : content.includes(term) ? 1 : 0),
    0,
  )
}

const objectScore = (note: Note, query: RecallQuery): number =>
  Option.isSome(note.objectId) && query.objectIds.includes(note.objectId.value) ? 1 : 0

const temporalImportanceScore = (note: Note, query: RecallQuery): number => {
  const ageDays = Math.max(0, query.at - note.createdAt) / DAY_MS
  const recency = 1 / (1 + ageDays / RECENCY_WINDOW_DAYS)
  return recency + note.importance
}

interface Ranked {
  readonly note: Note
  readonly topic: number
  readonly object: number
  readonly temporalImportance: number
}

const compare = (left: Ranked, right: Ranked): number =>
  right.topic - left.topic ||
  right.object - left.object ||
  right.temporalImportance - left.temporalImportance ||
  right.note.createdAt - left.note.createdAt ||
  (left.note.noteId < right.note.noteId ? -1 : left.note.noteId > right.note.noteId ? 1 : 0)

export const select = (
  notes: ReadonlyArray<Note>,
  query: RecallQuery,
): ReadonlyArray<{ readonly note: Note; readonly uncertain: boolean }> =>
  notes
    .filter((note) => isRecallable(note, query.at))
    .map((note): Ranked => ({
      note,
      topic: topicScore(note, query),
      object: objectScore(note, query),
      temporalImportance: temporalImportanceScore(note, query),
    }))
    .sort(compare)
    .slice(0, query.limit)
    .map(({ note }) => ({ note, uncertain: isUncertain(note) }))

export * as NotebookRanking from './ranking'
