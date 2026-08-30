import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SQLiteDriver } from '@minatojs/driver-sqlite'
import { expect, it } from '@effect/vitest'
import { MessageArchiveEvent, NotebookModel, NotebookStorage } from '@yokai-internal/memory'
import { Effect, Option } from 'effect'
import { Context } from 'koishi'
import { vi } from 'vitest'

vi.mock('koishi', () => import('@koishijs/core'))

import { YokaiNotebookModel } from '../../src/notebook/model'
import { KoishiNotebookStorage } from '../../src/notebook/storage'

const NOTE_A = NotebookModel.NoteId.make(`note_${'a'.repeat(32)}`)
const NOTE_B = NotebookModel.NoteId.make(`note_${'b'.repeat(32)}`)
const NOTE_C = NotebookModel.NoteId.make(`note_${'c'.repeat(32)}`)
const NOTE_D = NotebookModel.NoteId.make(`note_${'d'.repeat(32)}`)
const NOTE_E = NotebookModel.NoteId.make(`note_${'e'.repeat(32)}`)
const NOTE_F = NotebookModel.NoteId.make(`note_${'f'.repeat(32)}`)

const scope = (
  instanceId = 'notebook-test',
  platform = 'test',
  guildId = 'guild',
  channelId = 'channel',
): MessageArchiveEvent.ChannelScope =>
  MessageArchiveEvent.ChannelScope.make({
    instanceId: MessageArchiveEvent.InstanceId.make(instanceId),
    platform: MessageArchiveEvent.PlatformId.make(platform),
    guildId: MessageArchiveEvent.GuildId.make(guildId),
    channelId: MessageArchiveEvent.ChannelId.make(channelId),
  })

interface NoteOptions {
  readonly content?: string
  readonly objectId?: string | null
  readonly topics?: ReadonlyArray<string>
  readonly sourceMessageIds?: ReadonlyArray<string>
  readonly confidence?: number
  readonly importance?: number
  readonly expiresAt?: number | null
  readonly correctsNoteId?: NotebookModel.NoteId | null
}

const note = (
  channelScope: MessageArchiveEvent.ChannelScope,
  noteId: NotebookModel.NoteId,
  createdAt: number,
  options: NoteOptions = {},
): NotebookModel.Note => {
  const objectId = options.objectId === undefined ? 'alice' : options.objectId
  const topics = options.topics === undefined ? ['folklore'] : options.topics
  const sourceMessageIds =
    options.sourceMessageIds === undefined ? ['source-message'] : options.sourceMessageIds
  const expiresAt = options.expiresAt === undefined ? null : options.expiresAt
  const correctsNoteId = options.correctsNoteId === undefined ? null : options.correctsNoteId
  return NotebookModel.Note.make({
    ...channelScope,
    noteId,
    kind: 'fact',
    objectId:
      objectId === null ? Option.none() : Option.some(NotebookModel.NoteObjectId.make(objectId)),
    content: NotebookModel.NoteContent.make(
      options.content === undefined ? `content:${noteId}` : options.content,
    ),
    topics: topics.map((topic) => NotebookModel.NoteTopic.make(topic)),
    sourceMessageIds: sourceMessageIds.map((messageId) =>
      MessageArchiveEvent.MessageId.make(messageId),
    ),
    confidence: NotebookModel.Confidence.make(
      options.confidence === undefined ? 0.75 : options.confidence,
    ),
    importance: NotebookModel.Importance.make(
      options.importance === undefined ? 0.5 : options.importance,
    ),
    createdAt: MessageArchiveEvent.Timestamp.make(createdAt),
    expiresAt:
      expiresAt === null
        ? Option.none()
        : Option.some(MessageArchiveEvent.Timestamp.make(expiresAt)),
    correctsNoteId: correctsNoteId === null ? Option.none() : Option.some(correctsNoteId),
    supersededByNoteId: Option.none(),
  })
}

const databaseContext = (path: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const ctx = yield* Effect.sync(() => {
        const context = new Context()
        YokaiNotebookModel.define(context)
        context.plugin(SQLiteDriver, { path })
        return context
      })
      yield* Effect.promise(() => ctx.start())
      return ctx
    }),
    (ctx) => Effect.promise(() => ctx.stop()),
  )

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), 'yokai-notebook-'))),
  (directory) => Effect.tryPromise(() => rm(directory, { recursive: true, force: true })),
)

it.effect('stores schema-validated rows and atomically replaces a corrected note', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* databaseContext(':memory:')
      const channelScope = scope()
      const original = note(channelScope, NOTE_A, 1_000, {
        content: 'Alice prefers tea.',
        topics: ['tea', 'preferences'],
        sourceMessageIds: ['source-one', 'source-two'],
        expiresAt: 5_000,
      })
      const correction = note(channelScope, NOTE_B, 4_000, {
        content: 'Alice prefers coffee.',
        topics: ['coffee', 'preferences'],
        sourceMessageIds: ['correction-source'],
        correctsNoteId: NOTE_A,
      })

      const program = Effect.gen(function* () {
        const storage = yield* NotebookStorage.Service
        const stored = yield* storage.store(original)
        const corrected = yield* storage.store(correction)
        const replayed = yield* storage.store(correction)
        const recalled = yield* storage.query(channelScope)
        const old = yield* storage.get(channelScope, NOTE_A)
        return { stored, corrected, replayed, recalled, old }
      }).pipe(Effect.provide(KoishiNotebookStorage.layer(ctx)))

      const result = yield* program
      expect(result.stored._tag).toBe('Stored')
      expect(result.corrected._tag).toBe('Stored')
      expect(result.replayed._tag).toBe('Replay')
      expect(result.recalled).toEqual([correction])
      if (Option.isNone(result.old)) return yield* Effect.die('Expected the corrected source note')
      expect(Option.getOrUndefined(result.old.value.supersededByNoteId)).toBe(NOTE_B)

      const rows = yield* Effect.promise(() => ctx.database.get('yokai_memory', {}))
      expect(rows).toHaveLength(2)
      const originalRow = rows.find((row) => row.noteId === NOTE_A)
      if (originalRow === undefined) return yield* Effect.die('Expected the original row')
      expect(originalRow.supersededByNoteId).toBe(NOTE_B)
      expect(JSON.parse(originalRow.topicsJson)).toEqual(['tea', 'preferences'])
      expect(JSON.parse(originalRow.sourceMessageIdsJson)).toEqual(['source-one', 'source-two'])
      expect(originalRow.createdAt.getTime()).toBe(1_000)
      if (originalRow.expiresAt === null) return yield* Effect.die('Expected an expiration')
      expect(originalRow.expiresAt.getTime()).toBe(5_000)
    }),
  ),
)

it.effect('queries recallable rows in stable importance, time, and note ID order', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* databaseContext(':memory:')
      const channelScope = scope()
      const notes = [
        note(channelScope, NOTE_A, 1_000, { importance: 0.5 }),
        note(channelScope, NOTE_B, 1_000, { importance: 0.9 }),
        note(channelScope, NOTE_C, 2_000, { importance: 0.9 }),
        note(channelScope, NOTE_D, 1_000, { importance: 0.9 }),
        note(channelScope, NOTE_E, 3_000, { confidence: 0.2, importance: 1 }),
      ]

      const recalled = yield* Effect.gen(function* () {
        const storage = yield* NotebookStorage.Service
        yield* Effect.forEach(notes, (entry) => storage.store(entry), { discard: true })
        return yield* storage.query(channelScope)
      }).pipe(Effect.provide(KoishiNotebookStorage.layer(ctx)))

      expect(recalled.map((entry) => entry.noteId)).toEqual([NOTE_C, NOTE_B, NOTE_D, NOTE_A])
    }),
  ),
)

it.effect('isolates every scope field and treats the exact expiration boundary as inactive', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* databaseContext(':memory:')
      const primaryScope = scope('one', 'test', 'guild', 'channel')
      const scopes = [
        primaryScope,
        scope('two', 'test', 'guild', 'channel'),
        scope('one', 'other-platform', 'guild', 'channel'),
        scope('one', 'test', 'other-guild', 'channel'),
        scope('one', 'test', 'guild', 'other-channel'),
      ]
      const remoteTargetScope = scope('one', 'test', 'guild', 'remote')

      const program = Effect.gen(function* () {
        const storage = yield* NotebookStorage.Service
        yield* Effect.forEach(
          scopes,
          (channelScope, index) =>
            storage.store(
              note(channelScope, NOTE_A, 1_000 + index, {
                content: `scope:${index}`,
              }),
            ),
          { discard: true },
        )
        const loaded = yield* Effect.forEach(scopes, (channelScope) =>
          storage.get(channelScope, NOTE_A),
        )

        const expiring = note(primaryScope, NOTE_C, 1_500, { expiresAt: 2_000 })
        yield* storage.store(expiring)
        const boundaryCorrection = yield* storage.store(
          note(primaryScope, NOTE_D, 2_000, { correctsNoteId: NOTE_C }),
        )

        yield* storage.store(note(remoteTargetScope, NOTE_E, 1_000))
        const crossScopeCorrection = yield* storage.store(
          note(primaryScope, NOTE_F, 3_000, { correctsNoteId: NOTE_E }),
        )
        return { loaded, boundaryCorrection, crossScopeCorrection, storage }
      }).pipe(Effect.provide(KoishiNotebookStorage.layer(ctx)))

      const result = yield* program
      expect(
        result.loaded.map((entry) =>
          Option.match(entry, {
            onNone: () => undefined,
            onSome: (value) => value.content,
          }),
        ),
      ).toEqual(['scope:0', 'scope:1', 'scope:2', 'scope:3', 'scope:4'])
      expect(result.boundaryCorrection._tag).toBe('CorrectionTargetInactive')
      expect(result.crossScopeCorrection._tag).toBe('CorrectionTargetMissing')
      expect(Option.isNone(yield* result.storage.get(primaryScope, NOTE_D))).toBe(true)
      expect(Option.isNone(yield* result.storage.get(primaryScope, NOTE_F))).toBe(true)
      expect(Option.isSome(yield* result.storage.get(remoteTargetScope, NOTE_E))).toBe(true)
    }),
  ),
)

it.effect('serializes competing corrections so only one replacement becomes active', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* databaseContext(':memory:')
      const channelScope = scope()
      const target = note(channelScope, NOTE_A, 1_000)
      const first = note(channelScope, NOTE_B, 2_000, { correctsNoteId: NOTE_A })
      const second = note(channelScope, NOTE_C, 2_000, { correctsNoteId: NOTE_A })

      const outcomes = yield* Effect.gen(function* () {
        const storage = yield* NotebookStorage.Service
        yield* storage.store(target)
        return yield* Effect.all([storage.store(first), storage.store(second)], {
          concurrency: 'unbounded',
        })
      }).pipe(Effect.provide(KoishiNotebookStorage.layer(ctx)))

      expect(outcomes.map((outcome) => outcome._tag).sort()).toEqual([
        'CorrectionTargetInactive',
        'Stored',
      ])
      const rows = yield* Effect.promise(() => ctx.database.get('yokai_memory', {}))
      expect(rows).toHaveLength(2)
      expect(rows.filter((row) => row.supersededByNoteId === null)).toHaveLength(1)
    }),
  ),
)

it.effect('rolls back the superseding update when the replacement insert fails', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* databaseContext(':memory:')
      const channelScope = scope()
      const original = note(channelScope, NOTE_A, 1_000)
      const correction = note(channelScope, NOTE_B, 2_000, { correctsNoteId: NOTE_A })

      yield* NotebookStorage.Service.pipe(
        Effect.flatMap((storage) => storage.store(original)),
        Effect.provide(KoishiNotebookStorage.layer(ctx)),
      )
      const create = vi
        .spyOn(ctx.database, 'create')
        .mockRejectedValueOnce(new Error('expected replacement insert failure'))
      const error = yield* NotebookStorage.Service.pipe(
        Effect.flatMap((storage) => storage.store(correction)),
        Effect.provide(KoishiNotebookStorage.layer(ctx)),
        Effect.flip,
      )
      create.mockRestore()

      expect(error).toMatchObject({ _tag: 'NotebookStorageError', operation: 'store' })
      const rows = yield* Effect.promise(() => ctx.database.get('yokai_memory', {}))
      expect(rows).toHaveLength(1)
      const row = rows[0]
      if (row === undefined) return yield* Effect.die('Expected the original row')
      expect(row.noteId).toBe(NOTE_A)
      expect(row.supersededByNoteId).toBeNull()
    }),
  ),
)

it.effect('loads the same schema-validated note after a SQLite restart', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory
      const path = join(directory, 'notebook.db')
      const channelScope = scope('restart')
      const expected = note(channelScope, NOTE_A, 42_000, {
        objectId: null,
        topics: [],
        sourceMessageIds: ['restart-source'],
        expiresAt: 84_000,
      })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const ctx = yield* databaseContext(path)
          yield* NotebookStorage.Service.pipe(
            Effect.flatMap((storage) => storage.store(expected)),
            Effect.provide(KoishiNotebookStorage.layer(ctx)),
          )
        }),
      )

      const loaded = yield* Effect.scoped(
        Effect.gen(function* () {
          const ctx = yield* databaseContext(path)
          return yield* NotebookStorage.Service.pipe(
            Effect.flatMap((storage) => storage.get(channelScope, NOTE_A)),
            Effect.provide(KoishiNotebookStorage.layer(ctx)),
          )
        }),
      )
      expect(Option.getOrUndefined(loaded)).toEqual(expected)
    }),
  ),
)

it.effect('returns typed failures for malformed persisted JSON', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* databaseContext(':memory:')
      const channelScope = scope()
      yield* Effect.promise(() =>
        ctx.database.create('yokai_memory', {
          ...channelScope,
          noteId: NOTE_A,
          kind: 'fact',
          objectId: null,
          content: 'corrupt row',
          topicsJson: '{not-json',
          sourceMessageIdsJson: '["source"]',
          confidence: 0.75,
          importance: 0.5,
          createdAt: new Date(1_000),
          expiresAt: null,
          correctsNoteId: null,
          supersededByNoteId: null,
        }),
      )

      const queryError = yield* NotebookStorage.Service.pipe(
        Effect.flatMap((storage) => storage.query(channelScope)),
        Effect.provide(KoishiNotebookStorage.layer(ctx)),
        Effect.flip,
      )
      const getError = yield* NotebookStorage.Service.pipe(
        Effect.flatMap((storage) => storage.get(channelScope, NOTE_A)),
        Effect.provide(KoishiNotebookStorage.layer(ctx)),
        Effect.flip,
      )
      expect(queryError).toMatchObject({ _tag: 'NotebookStorageError', operation: 'query' })
      expect(getError).toMatchObject({ _tag: 'NotebookStorageError', operation: 'get' })
    }),
  ),
)
