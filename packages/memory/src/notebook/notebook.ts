import { Clock, Context, Duration, Effect, Layer, Option, Schema } from 'effect'

import { MessageArchive } from '../message-archive/archive'
import { ChannelScope, type InstanceId, Timestamp } from '../message-archive/event'
import { MessageArchiveStorage } from '../message-archive/storage'
import { NotebookIdentity } from './identity'
import {
  type ExpirationDays,
  Note,
  type NotesPerReply,
  RecallQuery,
  type RecallLimit,
  type RecallRequest,
  RecalledNote,
  type WriteProposal,
  type WriteReport,
  emptyWriteReport,
  isActive,
} from './model'
import { NotebookRanking } from './ranking'
import { NotebookStorage } from './storage'

export interface Options {
  readonly instanceId: InstanceId
  readonly maxNotesPerReply: NotesPerReply
  readonly recallLimit: RecallLimit
  readonly defaultExpirationDays: Option.Option<ExpirationDays>
}

export class InstanceScopeMismatchError extends Schema.TaggedError<InstanceScopeMismatchError>(
  '@yokai/memory/Notebook.InstanceScopeMismatchError',
)('NotebookInstanceScopeMismatchError', {
  configuredInstanceId: Schema.String,
  requestedInstanceId: Schema.String,
}) {}

export class ProposalLimitExceededError extends Schema.TaggedError<ProposalLimitExceededError>(
  '@yokai/memory/Notebook.ProposalLimitExceededError',
)('NotebookProposalLimitExceededError', {
  proposed: Schema.Natural,
  maximum: Schema.Natural,
}) {}

export interface Interface {
  readonly write: (
    scope: ChannelScope,
    proposals: ReadonlyArray<WriteProposal>,
  ) => Effect.Effect<
    WriteReport,
    | NotebookStorage.StorageError
    | MessageArchive.InstanceScopeMismatchError
    | MessageArchiveStorage.StorageError
    | InstanceScopeMismatchError
    | ProposalLimitExceededError
  >
  readonly recall: (
    request: RecallRequest,
  ) => Effect.Effect<
    ReadonlyArray<RecalledNote>,
    NotebookStorage.StorageError | InstanceScopeMismatchError
  >
}

export class Service extends Context.Service<Service, Interface>()('@yokai/memory/Notebook') {}

const ensureInstance = (
  configuredInstanceId: InstanceId,
  requestedInstanceId: InstanceId,
): Effect.Effect<void, InstanceScopeMismatchError> =>
  configuredInstanceId === requestedInstanceId
    ? Effect.void
    : Effect.fail(new InstanceScopeMismatchError({ configuredInstanceId, requestedInstanceId }))

const defaultExpiration = (
  now: Timestamp,
  days: Option.Option<ExpirationDays>,
): Option.Option<Timestamp> =>
  Option.map(days, (value) => Timestamp.make(now + Duration.toMillis(Duration.days(value))))

const proposalExpiration = (
  proposal: WriteProposal,
  now: Timestamp,
  days: Option.Option<ExpirationDays>,
): Option.Option<Timestamp> =>
  Option.isSome(proposal.expiresAt) ? proposal.expiresAt : defaultExpiration(now, days)

const incrementStored = (report: WriteReport): WriteReport => ({
  ...report,
  stored: report.stored + 1,
})

const incrementReplay = (report: WriteReport): WriteReport => ({
  ...report,
  replayed: report.replayed + 1,
})

const incrementMissingSource = (report: WriteReport): WriteReport => ({
  ...report,
  skippedMissingSource: report.skippedMissingSource + 1,
})

const incrementInvalidCorrection = (report: WriteReport): WriteReport => ({
  ...report,
  skippedInvalidCorrection: report.skippedInvalidCorrection + 1,
})

const incrementExpired = (report: WriteReport): WriteReport => ({
  ...report,
  skippedExpired: report.skippedExpired + 1,
})

export const layer = (options: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const archive = yield* MessageArchive.Service
      const storage = yield* NotebookStorage.Service

      const sourcesExist = Effect.fn('Notebook.sourcesExist')(function* (
        scope: ChannelScope,
        proposal: WriteProposal,
      ) {
        const sources = yield* Effect.forEach(proposal.sourceMessageIds, (messageId) =>
          archive.latest(scope, messageId),
        )
        return sources.every(Option.isSome)
      })

      const correctionIsActive = Effect.fn('Notebook.correctionIsActive')(function* (
        scope: ChannelScope,
        proposal: WriteProposal,
        now: Timestamp,
      ) {
        if (Option.isNone(proposal.correctsNoteId)) return true
        const target = yield* storage.get(scope, proposal.correctsNoteId.value)
        return Option.isSome(target) && isActive(target.value, now)
      })

      const writeOne = Effect.fn('Notebook.writeOne')(function* (
        scope: ChannelScope,
        proposal: WriteProposal,
        now: Timestamp,
        report: WriteReport,
      ) {
        const expiresAt = proposalExpiration(proposal, now, options.defaultExpirationDays)
        if (Option.isSome(expiresAt) && expiresAt.value <= now) {
          return incrementExpired(report)
        }
        if (!(yield* sourcesExist(scope, proposal))) {
          return incrementMissingSource(report)
        }
        if (!(yield* correctionIsActive(scope, proposal, now))) {
          return incrementInvalidCorrection(report)
        }

        const noteId = NotebookIdentity.stableId(scope, proposal)
        const note = Note.make({
          ...scope,
          noteId,
          kind: proposal.kind,
          objectId: proposal.objectId,
          content: proposal.content,
          topics: proposal.topics,
          sourceMessageIds: proposal.sourceMessageIds,
          confidence: proposal.confidence,
          importance: proposal.importance,
          createdAt: now,
          expiresAt,
          correctsNoteId: proposal.correctsNoteId,
          supersededByNoteId: Option.none(),
        })
        const result = yield* storage.store(note)
        return NotebookStorage.StoreResult.$match(result, {
          Stored: () => incrementStored(report),
          Replay: () => incrementReplay(report),
          CorrectionTargetMissing: () => incrementInvalidCorrection(report),
          CorrectionTargetInactive: () => incrementInvalidCorrection(report),
        })
      })

      const write = Effect.fn('Notebook.write')(function* (
        scope: ChannelScope,
        proposals: ReadonlyArray<WriteProposal>,
      ) {
        yield* ensureInstance(options.instanceId, scope.instanceId)
        if (proposals.length > options.maxNotesPerReply) {
          return yield* Effect.fail(
            new ProposalLimitExceededError({
              proposed: proposals.length,
              maximum: options.maxNotesPerReply,
            }),
          )
        }
        const now = Timestamp.make(yield* Clock.currentTimeMillis)
        return yield* Effect.reduce(
          proposals,
          () => emptyWriteReport(proposals.length),
          (report, proposal) => writeOne(scope, proposal, now, report),
        )
      })

      const recall = Effect.fn('Notebook.recall')(function* (request: RecallRequest) {
        yield* ensureInstance(options.instanceId, request.scope.instanceId)
        const at = Timestamp.make(yield* Clock.currentTimeMillis)
        const notes = yield* storage.query(request.scope)
        const query = RecallQuery.make({
          ...request,
          at,
          limit: options.recallLimit,
        })
        return NotebookRanking.select(notes, query).map((recalled) => RecalledNote.make(recalled))
      })

      return Service.of({ write, recall })
    }),
  )

export * as Notebook from './notebook'
