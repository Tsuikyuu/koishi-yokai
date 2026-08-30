import { Option } from 'effect'

import { MessageArchiveEvent, NotebookModel } from '../../src/index'

export const INSTANCE_ID = MessageArchiveEvent.InstanceId.make('notebook-test')
export const OTHER_INSTANCE_ID = MessageArchiveEvent.InstanceId.make('notebook-other')

export const SCOPE = MessageArchiveEvent.ChannelScope.make({
  instanceId: INSTANCE_ID,
  platform: MessageArchiveEvent.PlatformId.make('test'),
  guildId: MessageArchiveEvent.GuildId.make('guild'),
  channelId: MessageArchiveEvent.ChannelId.make('channel'),
})

export const OTHER_CHANNEL_SCOPE = MessageArchiveEvent.ChannelScope.make({
  ...SCOPE,
  channelId: MessageArchiveEvent.ChannelId.make('other-channel'),
})

export const OTHER_INSTANCE_SCOPE = MessageArchiveEvent.ChannelScope.make({
  ...SCOPE,
  instanceId: OTHER_INSTANCE_ID,
})

export const SOURCE_ONE = MessageArchiveEvent.MessageId.make('source-1')
export const SOURCE_TWO = MessageArchiveEvent.MessageId.make('source-2')
export const SOURCE_THREE = MessageArchiveEvent.MessageId.make('source-3')
export const MISSING_SOURCE = MessageArchiveEvent.MessageId.make('missing-source')

export const objectId = (value: string): NotebookModel.NoteObjectId =>
  NotebookModel.NoteObjectId.make(value)

export const topic = (value: string): NotebookModel.NoteTopic => NotebookModel.NoteTopic.make(value)

export const noteId = (value: number): NotebookModel.NoteId =>
  NotebookModel.NoteId.make(`note_${value.toString(16).padStart(32, '0')}`)

interface ProposalOptions {
  readonly kind?: NotebookModel.NoteKind
  readonly objectId?: NotebookModel.NoteObjectId | null
  readonly content?: string
  readonly topics?: ReadonlyArray<NotebookModel.NoteTopic>
  readonly sourceMessageIds?: ReadonlyArray<MessageArchiveEvent.MessageId>
  readonly confidence?: number
  readonly importance?: number
  readonly expiresAt?: number | null
  readonly correctsNoteId?: NotebookModel.NoteId | null
}

export const proposal = (options: ProposalOptions = {}): NotebookModel.WriteProposal =>
  NotebookModel.WriteProposal.make({
    kind: options.kind === undefined ? 'fact' : options.kind,
    objectId:
      options.objectId === undefined || options.objectId === null
        ? Option.none()
        : Option.some(options.objectId),
    content: NotebookModel.NoteContent.make(
      options.content === undefined ? 'Alice prefers tea' : options.content,
    ),
    topics: options.topics === undefined ? [topic('tea')] : options.topics,
    sourceMessageIds:
      options.sourceMessageIds === undefined ? [SOURCE_ONE] : options.sourceMessageIds,
    confidence: NotebookModel.Confidence.make(
      options.confidence === undefined ? 0.8 : options.confidence,
    ),
    importance: NotebookModel.Importance.make(
      options.importance === undefined ? 0.5 : options.importance,
    ),
    expiresAt:
      options.expiresAt === undefined || options.expiresAt === null
        ? Option.none()
        : Option.some(MessageArchiveEvent.Timestamp.make(options.expiresAt)),
    correctsNoteId:
      options.correctsNoteId === undefined || options.correctsNoteId === null
        ? Option.none()
        : Option.some(options.correctsNoteId),
  })

interface NoteOptions extends ProposalOptions {
  readonly noteId?: NotebookModel.NoteId
  readonly scope?: MessageArchiveEvent.ChannelScope
  readonly createdAt?: number
  readonly supersededByNoteId?: NotebookModel.NoteId | null
}

export const note = (options: NoteOptions = {}): NotebookModel.Note => {
  const writeProposal = proposal(options)
  const scope = options.scope === undefined ? SCOPE : options.scope
  return NotebookModel.Note.make({
    ...scope,
    noteId: options.noteId === undefined ? noteId(1) : options.noteId,
    kind: writeProposal.kind,
    objectId: writeProposal.objectId,
    content: writeProposal.content,
    topics: writeProposal.topics,
    sourceMessageIds: writeProposal.sourceMessageIds,
    confidence: writeProposal.confidence,
    importance: writeProposal.importance,
    createdAt: MessageArchiveEvent.Timestamp.make(
      options.createdAt === undefined ? 0 : options.createdAt,
    ),
    expiresAt: writeProposal.expiresAt,
    correctsNoteId: writeProposal.correctsNoteId,
    supersededByNoteId:
      options.supersededByNoteId === undefined || options.supersededByNoteId === null
        ? Option.none()
        : Option.some(options.supersededByNoteId),
  })
}
