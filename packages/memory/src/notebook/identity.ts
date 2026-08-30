import { createHash } from 'node:crypto'

import { Option } from 'effect'

import { NoteId, type WriteProposal } from './model'
import type { ChannelScope } from '../message-archive/event'

const optionalValue = <A>(value: Option.Option<A>): A | null =>
  Option.match(value, { onNone: () => null, onSome: (item) => item })

export const stableId = (scope: ChannelScope, proposal: WriteProposal): NoteId => {
  const canonical = JSON.stringify({
    scope: [scope.instanceId, scope.platform, scope.guildId, scope.channelId],
    kind: proposal.kind,
    objectId: optionalValue(proposal.objectId),
    content: proposal.content,
    topics: [...proposal.topics].sort(),
    sourceMessageIds: [...proposal.sourceMessageIds].sort(),
    correctsNoteId: optionalValue(proposal.correctsNoteId),
  })
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 32)
  return NoteId.make(`note_${digest}`)
}

export * as NotebookIdentity from './identity'
