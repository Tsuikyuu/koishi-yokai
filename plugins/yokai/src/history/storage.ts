import {
  MessageHistoryQuery,
  MessageHistoryStorage,
  type MessageArchiveEvent,
} from '@yokai-internal/memory'
import { Effect, HashMap, Layer, Option } from 'effect'
import type { Context } from 'koishi'

import { YokaiMessageRowCodec } from '../message-archive/row'

const scopeQuery = (scope: MessageArchiveEvent.ChannelScope) => ({
  instanceId: scope.instanceId,
  platform: scope.platform,
  guildId: scope.guildId,
  channelId: scope.channelId,
})

const authorQuery = (filters: MessageHistoryQuery.HistoryFilters) =>
  Option.match(filters.authorId, {
    onNone: () => ({}),
    onSome: (authorId) => ({ authorId }),
  })

const timeQuery = (filters: MessageHistoryQuery.HistoryFilters) => {
  const lower = Option.match(filters.fromTimestamp, {
    onNone: () => ({}),
    onSome: (timestamp) => ({ $gte: new Date(timestamp) }),
  })
  const upper = Option.match(filters.toTimestamp, {
    onNone: () => ({}),
    onSome: (timestamp) => ({ $lte: new Date(timestamp) }),
  })
  return Option.isNone(filters.fromTimestamp) && Option.isNone(filters.toTimestamp)
    ? {}
    : { timestamp: { ...lower, ...upper } }
}

const anchorQuery = (request: MessageHistoryQuery.StorageSearchRequest) =>
  Option.match(request.anchor, {
    onNone: () => ({}),
    onSome: (anchor) => {
      const timestamp = new Date(anchor.timestamp)
      return request.direction === 'before'
        ? {
            $or: [
              { timestamp: { $lt: timestamp } },
              { timestamp, messageId: { $lt: anchor.messageId } },
            ],
          }
        : {
            $or: [
              { timestamp: { $gt: timestamp } },
              { timestamp, messageId: { $gt: anchor.messageId } },
            ],
          }
    },
  })

const historyQuery = (request: MessageHistoryQuery.StorageSearchRequest) => ({
  $and: [
    scopeQuery(request.scope),
    authorQuery(request.filters),
    timeQuery(request.filters),
    anchorQuery(request),
  ],
})

const storageFailure = Effect.mapError((cause) => new MessageHistoryStorage.StorageError({ cause }))

const latestVersions = (
  messages: ReadonlyArray<MessageArchiveEvent.ArchivedMessage>,
): ReadonlyArray<MessageArchiveEvent.ArchivedMessage> => {
  const latest = messages.reduce(
    (current, message) =>
      Option.match(HashMap.get(current, message.messageId), {
        onNone: () => HashMap.set(current, message.messageId, message),
        onSome: (existing) =>
          existing.version >= message.version
            ? current
            : HashMap.set(current, message.messageId, message),
      }),
    HashMap.empty<MessageArchiveEvent.MessageId, MessageArchiveEvent.ArchivedMessage>(),
  )
  return Array.from(HashMap.values(latest))
}

const matchesFilters = (
  message: MessageArchiveEvent.ArchivedMessage,
  filters: MessageHistoryQuery.HistoryFilters,
): boolean => {
  if (Option.isSome(filters.authorId) && message.authorId !== filters.authorId.value) return false
  if (
    Option.isSome(filters.keyword) &&
    !message.content.toLowerCase().includes(filters.keyword.value.toLowerCase())
  ) {
    return false
  }
  if (Option.isSome(filters.fromTimestamp) && message.timestamp < filters.fromTimestamp.value) {
    return false
  }
  if (Option.isSome(filters.toTimestamp) && message.timestamp > filters.toTimestamp.value) {
    return false
  }
  return true
}

const matchesAnchor = (
  message: MessageArchiveEvent.ArchivedMessage,
  direction: MessageHistoryQuery.HistoryDirection,
  anchor: Option.Option<MessageHistoryQuery.HistoryPosition>,
): boolean =>
  Option.match(anchor, {
    onNone: () => true,
    onSome: (position) => {
      const comparison = MessageHistoryQuery.comparePositions(
        MessageHistoryQuery.positionOf(message),
        position,
      )
      return direction === 'before' ? comparison < 0 : comparison > 0
    },
  })

const compareMessages = (
  direction: MessageHistoryQuery.HistoryDirection,
  left: MessageArchiveEvent.ArchivedMessage,
  right: MessageArchiveEvent.ArchivedMessage,
): number => {
  const comparison = MessageHistoryQuery.comparePositions(
    MessageHistoryQuery.positionOf(left),
    MessageHistoryQuery.positionOf(right),
  )
  return direction === 'before' ? -comparison : comparison
}

export const layer = (ctx: Context) =>
  Layer.succeed(
    MessageHistoryStorage.Service,
    MessageHistoryStorage.Service.of({
      search: Effect.fn('KoishiMessageHistoryStorage.search')(function* (
        request: MessageHistoryQuery.StorageSearchRequest,
      ) {
        const rows = yield* Effect.tryPromise(() =>
          ctx.database.get('yokai_message', historyQuery(request), {
            sort: {
              timestamp: request.direction === 'before' ? 'desc' : 'asc',
              messageId: request.direction === 'before' ? 'desc' : 'asc',
              version: 'desc',
            },
          }),
        ).pipe(storageFailure)
        const decoded = yield* Effect.forEach(rows, (row) =>
          YokaiMessageRowCodec.decode(row).pipe(storageFailure),
        )
        return [...latestVersions(decoded)]
          .filter(
            (message) =>
              matchesFilters(message, request.filters) &&
              matchesAnchor(message, request.direction, request.anchor),
          )
          .sort((left, right) => compareMessages(request.direction, left, right))
          .slice(0, request.fetchLimit)
      }),
    }),
  )

export * as KoishiMessageHistoryStorage from './storage'
