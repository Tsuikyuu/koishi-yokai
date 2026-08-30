import { MessageArchiveEvent, NotebookModel, NotebookStorage } from '@yokai-internal/memory'
import { Effect, Layer, Option, Semaphore } from 'effect'
import type { Context } from 'koishi'

import type { YokaiMemoryRow } from './model'
import { YokaiNotebookRowCodec } from './row'

interface ScopeRow {
  readonly instanceId: string
  readonly platform: string
  readonly guildId: string
  readonly channelId: string
}

const scopeQuery = (scope: ScopeRow) => ({
  instanceId: scope.instanceId,
  platform: scope.platform,
  guildId: scope.guildId,
  channelId: scope.channelId,
})

const noteQuery = (scope: MessageArchiveEvent.ChannelScope, noteId: NotebookModel.NoteId) => ({
  ...scopeQuery(scope),
  noteId,
})

const storageFailure = (operation: NotebookStorage.StorageOperation) =>
  Effect.mapError((cause) => new NotebookStorage.StorageError({ operation, cause }))

const createRow = (
  database: Context['database'],
  row: YokaiMemoryRow,
): Promise<NotebookStorage.StoreResult> =>
  database.create('yokai_memory', row).then(() => NotebookStorage.StoreResult.Stored())

const storeCorrection = (
  database: Context['database'],
  row: YokaiMemoryRow,
): Promise<NotebookStorage.StoreResult> => {
  if (row.correctsNoteId === null) return createRow(database, row)

  return database
    .get(
      'yokai_memory',
      {
        ...scopeQuery(row),
        noteId: row.correctsNoteId,
      },
      { limit: 1 },
    )
    .then((targetRows) => {
      const target = targetRows[0]
      if (target === undefined) {
        return NotebookStorage.StoreResult.CorrectionTargetMissing()
      }
      if (
        target.supersededByNoteId !== null ||
        (target.expiresAt !== null && target.expiresAt.getTime() <= row.createdAt.getTime())
      ) {
        return NotebookStorage.StoreResult.CorrectionTargetInactive()
      }

      return database
        .set(
          'yokai_memory',
          {
            ...scopeQuery(row),
            noteId: target.noteId,
            supersededByNoteId: { $exists: false },
          },
          { supersededByNoteId: row.noteId },
        )
        .then((result) =>
          result.matched === 0
            ? NotebookStorage.StoreResult.CorrectionTargetInactive()
            : createRow(database, row),
        )
    })
}

export const layer = (ctx: Context) =>
  Layer.effect(
    NotebookStorage.Service,
    Effect.gen(function* () {
      const writeGate = yield* Semaphore.make(1)

      const get = Effect.fn('KoishiNotebookStorage.get')(function* (
        scope: MessageArchiveEvent.ChannelScope,
        noteId: NotebookModel.NoteId,
      ) {
        const rows = yield* Effect.tryPromise(() =>
          ctx.database.get('yokai_memory', noteQuery(scope, noteId), { limit: 1 }),
        ).pipe(storageFailure('get'))
        const row = rows[0]
        if (row === undefined) return Option.none<NotebookModel.Note>()
        return Option.some(yield* YokaiNotebookRowCodec.decode(row).pipe(storageFailure('get')))
      })

      const query = Effect.fn('KoishiNotebookStorage.query')(function* (
        scope: MessageArchiveEvent.ChannelScope,
      ) {
        const rows = yield* Effect.tryPromise(() =>
          ctx.database.get(
            'yokai_memory',
            {
              ...scopeQuery(scope),
              supersededByNoteId: { $exists: false },
              confidence: { $gte: NotebookModel.LOW_CONFIDENCE_THRESHOLD },
            },
            {
              sort: { importance: 'desc', createdAt: 'desc', noteId: 'asc' },
            },
          ),
        ).pipe(storageFailure('query'))
        return yield* Effect.forEach(rows, (row) =>
          YokaiNotebookRowCodec.decode(row).pipe(storageFailure('query')),
        )
      })

      const store = Effect.fn('KoishiNotebookStorage.store')(function* (note: NotebookModel.Note) {
        const row = yield* YokaiNotebookRowCodec.encode(note).pipe(storageFailure('store'))
        return yield* writeGate.withPermits(1)(
          Effect.tryPromise({
            try: () =>
              ctx.database.transact((database) =>
                database
                  .get('yokai_memory', noteQuery(note, note.noteId), { limit: 1 })
                  .then((existingRows) =>
                    existingRows[0] === undefined
                      ? storeCorrection(database, row)
                      : NotebookStorage.StoreResult.Replay(),
                  ),
              ),
            catch: (cause) => new NotebookStorage.StorageError({ operation: 'store', cause }),
          }),
        )
      })

      return NotebookStorage.Service.of({ get, query, store })
    }),
  )

export * as KoishiNotebookStorage from './storage'
