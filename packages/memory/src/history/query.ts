import { Option, Schema } from 'effect'
import { TokenCount, TokenLimit } from 'yokai-protocol'

import {
  ActorId,
  ArchivedMessage,
  ChannelScope,
  MessageId,
  Timestamp,
} from '../message-archive/event'

export const DEFAULT_HISTORY_PAGE_SIZE = 40
export const MAX_HISTORY_PAGE_SIZE = 100
export const MAX_HISTORY_CURSOR_LENGTH = 8_192
export const MAX_HISTORY_KEYWORD_LENGTH = 256

export const HistoryCursor = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_HISTORY_CURSOR_LENGTH),
  Schema.isPattern(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
).pipe(Schema.brand('@yokai/memory/HistoryCursor'))

export type HistoryCursor = typeof HistoryCursor.Type

export const HistoryDirection = Schema.Literals(['before', 'after'])
export type HistoryDirection = typeof HistoryDirection.Type

export const HistoryPageLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_HISTORY_PAGE_SIZE }),
).pipe(Schema.brand('@yokai/memory/HistoryPageLimit'))

export type HistoryPageLimit = typeof HistoryPageLimit.Type

export const HistoryKeyword = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_HISTORY_KEYWORD_LENGTH),
).pipe(Schema.brand('@yokai/memory/HistoryKeyword'))

export type HistoryKeyword = typeof HistoryKeyword.Type

export const HistoryPosition = Schema.Struct({
  timestamp: Timestamp,
  messageId: MessageId,
})

export interface HistoryPosition extends Schema.Schema.Type<typeof HistoryPosition> {}

export const HistoryFilters = Schema.Struct({
  authorId: Schema.OptionFromNullOr(ActorId),
  keyword: Schema.OptionFromNullOr(HistoryKeyword),
  fromTimestamp: Schema.OptionFromNullOr(Timestamp),
  toTimestamp: Schema.OptionFromNullOr(Timestamp),
})

export interface HistoryFilters extends Schema.Schema.Type<typeof HistoryFilters> {}

export const HistoryPageRequest = Schema.Struct({
  scope: ChannelScope,
  direction: HistoryDirection,
  cursor: Schema.OptionFromNullOr(HistoryCursor),
  limit: HistoryPageLimit,
  filters: HistoryFilters,
  tokenBudget: TokenLimit,
})

export interface HistoryPageRequest extends Schema.Schema.Type<typeof HistoryPageRequest> {}

export const HistoryPage = Schema.Struct({
  messages: Schema.Array(ArchivedMessage),
  nextCursor: Schema.OptionFromNullOr(HistoryCursor),
  hasMore: Schema.Boolean,
  estimatedTokens: TokenCount,
})

export interface HistoryPage extends Schema.Schema.Type<typeof HistoryPage> {}

export interface StorageSearchRequest {
  readonly scope: ChannelScope
  readonly direction: HistoryDirection
  readonly anchor: Option.Option<HistoryPosition>
  readonly filters: HistoryFilters
  readonly fetchLimit: number
}

export const emptyFilters = (): HistoryFilters =>
  HistoryFilters.make({
    authorId: Option.none(),
    keyword: Option.none(),
    fromTimestamp: Option.none(),
    toTimestamp: Option.none(),
  })

export const defaultPageLimit = (): HistoryPageLimit =>
  HistoryPageLimit.make(DEFAULT_HISTORY_PAGE_SIZE)

export const positionOf = (message: ArchivedMessage): HistoryPosition =>
  HistoryPosition.make({ timestamp: message.timestamp, messageId: message.messageId })

export const comparePositions = (left: HistoryPosition, right: HistoryPosition): number => {
  if (left.timestamp < right.timestamp) return -1
  if (left.timestamp > right.timestamp) return 1
  if (left.messageId < right.messageId) return -1
  if (left.messageId > right.messageId) return 1
  return 0
}

export const estimateTextTokens = (text: string): TokenCount =>
  TokenCount.make(Math.max(1, Math.ceil(Array.from(text).length / 4)))

export const estimateMessageTokens = (message: ArchivedMessage): TokenCount =>
  TokenCount.make(
    8 +
      estimateTextTokens(message.messageId) +
      estimateTextTokens(message.authorId) +
      estimateTextTokens(message.content),
  )

export * as MessageHistoryQuery from './query'
