import { expect, it } from '@effect/vitest'
import { Option } from 'effect'

import {
  MessageArchiveEvent,
  NotebookIdentity,
  NotebookModel,
  NotebookRanking,
} from '../../src/index'
import {
  OTHER_CHANNEL_SCOPE,
  SCOPE,
  SOURCE_ONE,
  note,
  noteId,
  objectId,
  proposal,
  topic,
} from './fixtures'

it('models exactly the four bounded notebook kinds and requires source provenance', () => {
  expect(NotebookModel.NoteKind.literals).toEqual(['episode', 'fact', 'relationship', 'self'])

  const kinds: ReadonlyArray<NotebookModel.NoteKind> = ['episode', 'fact', 'relationship', 'self']
  expect(kinds.map((kind) => proposal({ kind }).kind)).toEqual(kinds)

  expect(() =>
    NotebookModel.WriteProposal.make({
      ...proposal(),
      sourceMessageIds: [],
    }),
  ).toThrow()
  expect(() => NotebookModel.Confidence.make(-0.01)).toThrow()
  expect(() => NotebookModel.Confidence.make(1.01)).toThrow()
  expect(() => NotebookModel.Importance.make(-0.01)).toThrow()
  expect(() => NotebookModel.Importance.make(1.01)).toThrow()
  expect(() =>
    NotebookModel.NoteContent.make('x'.repeat(NotebookModel.MAX_NOTE_CONTENT_LENGTH + 1)),
  ).toThrow()
  expect(() =>
    NotebookModel.NoteTopics.make(
      Array.from({ length: NotebookModel.MAX_NOTE_TOPICS + 1 }, (_, index) =>
        topic(`topic-${index}`),
      ),
    ),
  ).toThrow()
})

it('derives a stable order-insensitive identity while retaining scope and semantic changes', () => {
  const first = proposal({
    objectId: objectId('alice'),
    topics: [topic('tea'), topic('weekend')],
    sourceMessageIds: [SOURCE_ONE, MessageArchiveEvent.MessageId.make('source-2')],
  })
  const reordered = proposal({
    objectId: objectId('alice'),
    topics: [topic('weekend'), topic('tea')],
    sourceMessageIds: [MessageArchiveEvent.MessageId.make('source-2'), SOURCE_ONE],
    confidence: 0.4,
    importance: 1,
    expiresAt: 999,
  })

  const stable = NotebookIdentity.stableId(SCOPE, first)
  expect(NotebookIdentity.stableId(SCOPE, first)).toBe(stable)
  expect(NotebookIdentity.stableId(SCOPE, reordered)).toBe(stable)
  expect(NotebookIdentity.stableId(OTHER_CHANNEL_SCOPE, first)).not.toBe(stable)
  expect(
    NotebookIdentity.stableId(
      SCOPE,
      NotebookModel.WriteProposal.make({
        ...first,
        content: NotebookModel.NoteContent.make('Alice prefers coffee'),
      }),
    ),
  ).not.toBe(stable)
})

it('orders by topic, then object, then recency and importance with a stable ID tie-break', () => {
  const query = NotebookModel.RecallQuery.make({
    scope: SCOPE,
    topics: [topic('tea')],
    objectIds: [objectId('alice')],
    at: MessageArchiveEvent.Timestamp.make(30 * 24 * 60 * 60 * 1_000),
    limit: NotebookModel.RecallLimit.make(10),
  })
  const topicAndObject = note({
    noteId: noteId(4),
    objectId: objectId('alice'),
    topics: [topic('tea')],
    importance: 0,
    createdAt: 0,
  })
  const topicOnly = note({
    noteId: noteId(3),
    objectId: objectId('bob'),
    topics: [topic('tea')],
    importance: 1,
    createdAt: query.at,
  })
  const contentOnly = note({
    noteId: noteId(2),
    objectId: objectId('alice'),
    content: 'tea appears only in content',
    topics: [topic('drink')],
    importance: 1,
    createdAt: query.at,
  })
  const unrelated = note({
    noteId: noteId(1),
    objectId: objectId('alice'),
    content: 'unrelated',
    topics: [topic('games')],
    importance: 1,
    createdAt: query.at,
  })

  expect(
    NotebookRanking.select([unrelated, contentOnly, topicOnly, topicAndObject], query).map(
      ({ note: selected }) => selected.noteId,
    ),
  ).toEqual([topicAndObject.noteId, topicOnly.noteId, contentOnly.noteId, unrelated.noteId])

  const tiedLaterId = note({
    noteId: noteId(6),
    content: 'same',
    topics: [],
    importance: 0.5,
    createdAt: 100,
  })
  const tiedEarlierId = note({
    noteId: noteId(5),
    content: 'same',
    topics: [],
    importance: 0.5,
    createdAt: 100,
  })
  const noTerms = NotebookModel.RecallQuery.make({
    ...query,
    topics: [],
    objectIds: [],
  })
  expect(
    NotebookRanking.select([tiedLaterId, tiedEarlierId], noTerms).map(
      ({ note: selected }) => selected.noteId,
    ),
  ).toEqual([tiedEarlierId.noteId, tiedLaterId.noteId])
})

it('excludes low-confidence, expired, and superseded notes at exact boundaries', () => {
  const at = MessageArchiveEvent.Timestamp.make(1_000)
  const query = NotebookModel.RecallQuery.make({
    scope: SCOPE,
    topics: [],
    objectIds: [],
    at,
    limit: NotebookModel.RecallLimit.make(10),
  })
  const low = note({ noteId: noteId(1), confidence: NotebookModel.LOW_CONFIDENCE_THRESHOLD - 0.01 })
  const lowBoundary = note({
    noteId: noteId(2),
    confidence: NotebookModel.LOW_CONFIDENCE_THRESHOLD,
  })
  const medium = note({ noteId: noteId(3), confidence: 0.69 })
  const certainBoundary = note({
    noteId: noteId(4),
    confidence: NotebookModel.CERTAIN_CONFIDENCE_THRESHOLD,
  })
  const expired = note({ noteId: noteId(5), expiresAt: at })
  const superseded = note({ noteId: noteId(6), supersededByNoteId: noteId(7) })

  const selected = NotebookRanking.select(
    [low, lowBoundary, medium, certainBoundary, expired, superseded],
    query,
  )
  expect(selected.map(({ note: recalled }) => recalled.noteId)).toEqual([
    lowBoundary.noteId,
    medium.noteId,
    certainBoundary.noteId,
  ])
  expect(selected.map(({ uncertain }) => uncertain)).toEqual([true, true, false])
  expect(NotebookModel.isActive(note({ expiresAt: at + 1 }), at)).toBe(true)
  expect(NotebookModel.isActive(expired, at)).toBe(false)
  expect(Option.isSome(superseded.supersededByNoteId)).toBe(true)
})
