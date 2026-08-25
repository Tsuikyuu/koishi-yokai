import { MessageArchiveEvent } from '@yokai-internal/memory'
import { Effect, Schema } from 'effect'
import type { Session } from 'koishi'

export const EventKind = Schema.Literals(['created', 'updated'])
export type EventKind = typeof EventKind.Type

export class NormalizationError extends Schema.TaggedError<NormalizationError>(
  '@yokai/plugin/MessageArchive.NormalizationError',
)('MessageArchiveNormalizationError', {
  eventKind: EventKind,
}) {}

const decodeEvent = Schema.decodeUnknownEffect(MessageArchiveEvent.NormalizedEvent)

export const normalize = Effect.fn('KoishiMessageArchive.normalize')(function* (
  session: Session,
  instanceId: string,
  eventKind: EventKind,
) {
  const tag = eventKind === 'created' ? 'MessageCreated' : 'MessageUpdated'
  return yield* decodeEvent({
    _tag: tag,
    instanceId,
    platform: session.platform,
    guildId: session.guildId,
    channelId: session.channelId,
    messageId: session.messageId,
    authorId: session.userId,
    selfId: session.selfId,
    timestamp: session.timestamp,
    content: session.content,
    isSelf: session.userId === session.selfId,
  }).pipe(Effect.mapError(() => new NormalizationError({ eventKind })))
})

export * as KoishiMessageNormalization from './normalization'
