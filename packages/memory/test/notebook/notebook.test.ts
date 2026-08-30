import { expect, it } from '@effect/vitest'
import { Context, Effect, Layer, Option, Ref } from 'effect'
import { TestClock } from 'effect/testing'

import {
  MessageArchive,
  MessageArchiveEvent,
  Notebook,
  NotebookModel,
  NotebookStorage,
} from '../../src/index'
import {
  INSTANCE_ID,
  MISSING_SOURCE,
  OTHER_CHANNEL_SCOPE,
  OTHER_INSTANCE_SCOPE,
  SCOPE,
  SOURCE_ONE,
  SOURCE_THREE,
  SOURCE_TWO,
  objectId,
  proposal,
  topic,
} from './fixtures'

const sameScope = (
  left: MessageArchiveEvent.ChannelScope,
  right: MessageArchiveEvent.ChannelScope,
): boolean =>
  left.instanceId === right.instanceId &&
  left.platform === right.platform &&
  left.guildId === right.guildId &&
  left.channelId === right.channelId

const archived = (
  scope: MessageArchiveEvent.ChannelScope,
  messageId: MessageArchiveEvent.MessageId,
): MessageArchiveEvent.ArchivedMessage =>
  MessageArchiveEvent.ArchivedMessage.make({
    ...scope,
    messageId,
    version: MessageArchiveEvent.MessageVersion.make(1),
    sourceVersion: Option.none(),
    previousVersion: Option.none(),
    kind: 'created',
    authorId: MessageArchiveEvent.ActorId.make('alice'),
    selfId: MessageArchiveEvent.ActorId.make('yokai'),
    replyToMessageId: Option.none(),
    timestamp: MessageArchiveEvent.Timestamp.make(0),
    eventTimestamp: MessageArchiveEvent.Timestamp.make(0),
    recordedAt: MessageArchiveEvent.Timestamp.make(0),
    content: `source ${messageId}`,
    isSelf: false,
  })

const availableSources: ReadonlyArray<MessageArchiveEvent.MessageId> = [
  SOURCE_ONE,
  SOURCE_TWO,
  SOURCE_THREE,
]

const archiveLayer = Layer.succeed(
  MessageArchive.Service,
  MessageArchive.Service.of({
    record: () => Effect.die('MessageArchive.record is not used by notebook tests'),
    latest: (scope, messageId) =>
      Effect.succeed(
        availableSources.includes(messageId)
          ? Option.some(archived(scope, messageId))
          : Option.none<MessageArchiveEvent.ArchivedMessage>(),
      ),
    versions: () => Effect.succeed([]),
  }),
)

interface TestStorageInterface extends NotebookStorage.Interface {
  readonly seed: (note: NotebookModel.Note) => Effect.Effect<void>
  readonly all: () => Effect.Effect<ReadonlyArray<NotebookModel.Note>>
}

class TestStorage extends Context.Service<TestStorage, TestStorageInterface>()(
  '@yokai/memory/NotebookStorage/Test',
) {}

const storeResult = (
  notes: ReadonlyArray<NotebookModel.Note>,
  incoming: NotebookModel.Note,
): readonly [NotebookStorage.StoreResult, ReadonlyArray<NotebookModel.Note>] => {
  if (notes.some((note) => sameScope(note, incoming) && note.noteId === incoming.noteId)) {
    return [NotebookStorage.StoreResult.Replay(), notes]
  }
  if (Option.isNone(incoming.correctsNoteId)) {
    return [NotebookStorage.StoreResult.Stored(), [...notes, incoming]]
  }

  const correctsNoteId = incoming.correctsNoteId.value
  const target = notes.find((note) => sameScope(note, incoming) && note.noteId === correctsNoteId)
  if (target === undefined) {
    return [NotebookStorage.StoreResult.CorrectionTargetMissing(), notes]
  }
  if (Option.isSome(target.supersededByNoteId)) {
    return [NotebookStorage.StoreResult.CorrectionTargetInactive(), notes]
  }
  const corrected = notes.map((note) =>
    note.noteId === target.noteId && sameScope(note, target)
      ? NotebookModel.Note.make({
          ...note,
          supersededByNoteId: Option.some(incoming.noteId),
        })
      : note,
  )
  return [NotebookStorage.StoreResult.Stored(), [...corrected, incoming]]
}

const testStorageLayer = Layer.effectContext(
  Effect.gen(function* () {
    const notes = yield* Ref.make<ReadonlyArray<NotebookModel.Note>>([])
    const service = TestStorage.of({
      get: Effect.fn('NotebookTestStorage.get')(function* (scope, noteId) {
        return Option.fromUndefinedOr(
          (yield* Ref.get(notes)).find((note) => sameScope(note, scope) && note.noteId === noteId),
        )
      }),
      query: Effect.fn('NotebookTestStorage.query')(function* (scope) {
        return (yield* Ref.get(notes)).filter((note) => sameScope(note, scope))
      }),
      store: Effect.fn('NotebookTestStorage.store')(function* (note) {
        return yield* Ref.modify(notes, (current) => storeResult(current, note))
      }),
      seed: (note) => Ref.update(notes, (current) => [...current, note]),
      all: () => Ref.get(notes),
    })
    return Context.empty().pipe(
      Context.add(NotebookStorage.Service, service),
      Context.add(TestStorage, service),
    )
  }),
)

const notebookLayer = Notebook.layer({
  instanceId: INSTANCE_ID,
  maxNotesPerReply: NotebookModel.NotesPerReply.make(4),
  recallLimit: NotebookModel.RecallLimit.make(8),
  defaultExpirationDays: Option.some(NotebookModel.ExpirationDays.make(30)),
}).pipe(Layer.provideMerge(Layer.merge(testStorageLayer, archiveLayer)))

it.effect('writes all four kinds with stable replay IDs and one shared default expiry', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(1_000)
    const notebook = yield* Notebook.Service
    const storage = yield* TestStorage
    const kinds: ReadonlyArray<NotebookModel.NoteKind> = ['episode', 'fact', 'relationship', 'self']
    const proposals = kinds.map((kind, index) =>
      proposal({
        kind,
        content: `${kind} memory`,
        sourceMessageIds: [availableSources[index % availableSources.length] ?? SOURCE_ONE],
      }),
    )

    expect(yield* notebook.write(SCOPE, proposals)).toEqual({
      proposed: 4,
      stored: 4,
      skippedMissingSource: 0,
      skippedInvalidCorrection: 0,
      skippedExpired: 0,
      replayed: 0,
    })
    const first = yield* storage.all()
    expect(first.map((note) => note.kind)).toEqual(kinds)
    expect(first.every((note) => note.createdAt === 1_000)).toBe(true)
    expect(
      first.every(
        (note) =>
          Option.isSome(note.expiresAt) &&
          note.expiresAt.value === 1_000 + 30 * 24 * 60 * 60 * 1_000,
      ),
    ).toBe(true)

    yield* TestClock.adjust(100)
    expect(yield* notebook.write(SCOPE, proposals)).toEqual({
      proposed: 4,
      stored: 0,
      skippedMissingSource: 0,
      skippedInvalidCorrection: 0,
      skippedExpired: 0,
      replayed: 4,
    })
    expect((yield* storage.all()).map((note) => note.noteId)).toEqual(
      first.map((note) => note.noteId),
    )
  }).pipe(Effect.provide(notebookLayer)),
)

it.effect('skips absent sources and already-expired proposals before persistence', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(5_000)
    const notebook = yield* Notebook.Service
    const storage = yield* TestStorage

    expect(
      yield* notebook.write(SCOPE, [
        proposal({ sourceMessageIds: [MISSING_SOURCE] }),
        proposal({ content: 'already expired', expiresAt: 5_000 }),
      ]),
    ).toEqual({
      proposed: 2,
      stored: 0,
      skippedMissingSource: 1,
      skippedInvalidCorrection: 0,
      skippedExpired: 1,
      replayed: 0,
    })
    expect(yield* storage.all()).toEqual([])

    const failure = yield* notebook
      .write(
        SCOPE,
        Array.from({ length: 5 }, (_, index) => proposal({ content: `over-limit-${index}` })),
      )
      .pipe(Effect.flip)
    expect(failure._tag).toBe('NotebookProposalLimitExceededError')
    if (failure._tag !== 'NotebookProposalLimitExceededError') {
      return yield* Effect.die('Expected proposal limit failure')
    }
    expect(failure.proposed).toBe(5)
    expect(failure.maximum).toBe(4)
    expect(yield* storage.all()).toEqual([])
  }).pipe(Effect.provide(notebookLayer)),
)

it.effect('atomically supersedes an active correction target and never recalls the old claim', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const notebook = yield* Notebook.Service
    const storage = yield* TestStorage
    yield* notebook.write(SCOPE, [
      proposal({
        objectId: objectId('alice'),
        content: 'Alice prefers tea',
        topics: [topic('drink')],
        sourceMessageIds: [SOURCE_ONE],
      }),
    ])
    const original = (yield* storage.all())[0]
    if (original === undefined) return yield* Effect.die('Expected original note')

    yield* TestClock.adjust(100)
    expect(
      yield* notebook.write(SCOPE, [
        proposal({
          objectId: objectId('alice'),
          content: 'Alice corrected that she prefers coffee',
          topics: [topic('drink')],
          sourceMessageIds: [SOURCE_TWO],
          correctsNoteId: original.noteId,
        }),
      ]),
    ).toEqual({
      proposed: 1,
      stored: 1,
      skippedMissingSource: 0,
      skippedInvalidCorrection: 0,
      skippedExpired: 0,
      replayed: 0,
    })

    const stored = yield* storage.all()
    const replacement = stored.find((note) => note.noteId !== original.noteId)
    if (replacement === undefined) return yield* Effect.die('Expected replacement note')
    const correctedOriginal = stored.find((note) => note.noteId === original.noteId)
    if (correctedOriginal === undefined) return yield* Effect.die('Expected corrected original')
    expect(correctedOriginal.supersededByNoteId).toEqual(Option.some(replacement.noteId))
    expect(replacement.correctsNoteId).toEqual(Option.some(original.noteId))

    const recalled = yield* notebook.recall(
      NotebookModel.RecallRequest.make({
        scope: SCOPE,
        topics: [topic('drink')],
        objectIds: [objectId('alice')],
      }),
    )
    expect(recalled.map(({ note }) => note.noteId)).toEqual([replacement.noteId])

    const invalid = yield* notebook.write(SCOPE, [
      proposal({
        content: 'A second correction cannot replace an inactive target',
        sourceMessageIds: [SOURCE_THREE],
        correctsNoteId: original.noteId,
      }),
    ])
    expect(invalid.skippedInvalidCorrection).toBe(1)
    expect(yield* storage.all()).toHaveLength(2)
  }).pipe(Effect.provide(notebookLayer)),
)

it.effect('keeps channel retrieval isolated and rejects a foreign configured instance', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const notebook = yield* Notebook.Service
    yield* notebook.write(SCOPE, [proposal()])

    expect(
      yield* notebook.recall(
        NotebookModel.RecallRequest.make({
          scope: OTHER_CHANNEL_SCOPE,
          topics: [topic('tea')],
          objectIds: [],
        }),
      ),
    ).toEqual([])

    const failure = yield* notebook
      .recall(
        NotebookModel.RecallRequest.make({
          scope: OTHER_INSTANCE_SCOPE,
          topics: [topic('tea')],
          objectIds: [],
        }),
      )
      .pipe(Effect.flip)
    expect(failure._tag).toBe('NotebookInstanceScopeMismatchError')
  }).pipe(Effect.provide(notebookLayer)),
)
