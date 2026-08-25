import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { Context, Effect, Encoding, Layer, Option, Result, Schema } from 'effect'
import { TokenCount } from 'yokai-protocol'

import { ChannelScope, type InstanceId } from '../message-archive/event'
import {
  HistoryCursor,
  type HistoryFilters,
  HistoryPage,
  type HistoryPageRequest,
  HistoryPosition,
  type StorageSearchRequest,
  estimateMessageTokens,
  positionOf,
} from './query'
import { MessageHistoryStorage, type StorageError } from './storage'

const CURSOR_VERSION = 1
const CURSOR_KEY_BYTES = 32

const CursorPayload = Schema.Struct({
  version: Schema.Literal(CURSOR_VERSION),
  scope: ChannelScope,
  position: HistoryPosition,
})

interface CursorPayload extends Schema.Schema.Type<typeof CursorPayload> {}

export class CursorInvalidError extends Schema.TaggedError<CursorInvalidError>(
  '@yokai/memory/MessageHistory.CursorInvalidError',
)('MessageHistoryCursorInvalidError', {}) {}

export class CursorScopeMismatchError extends Schema.TaggedError<CursorScopeMismatchError>(
  '@yokai/memory/MessageHistory.CursorScopeMismatchError',
)('MessageHistoryCursorScopeMismatchError', {}) {}

export class InstanceScopeMismatchError extends Schema.TaggedError<InstanceScopeMismatchError>(
  '@yokai/memory/MessageHistory.InstanceScopeMismatchError',
)('MessageHistoryInstanceScopeMismatchError', {
  configuredInstanceId: Schema.String,
  requestedInstanceId: Schema.String,
}) {}

export class InvalidTimeRangeError extends Schema.TaggedError<InvalidTimeRangeError>(
  '@yokai/memory/MessageHistory.InvalidTimeRangeError',
)('MessageHistoryInvalidTimeRangeError', {}) {}

export class ResultBudgetExceededError extends Schema.TaggedError<ResultBudgetExceededError>(
  '@yokai/memory/MessageHistory.ResultBudgetExceededError',
)('MessageHistoryResultBudgetExceededError', {
  tokenBudget: Schema.Number,
}) {}

export class CursorKeyError extends Schema.TaggedError<CursorKeyError>(
  '@yokai/memory/MessageHistory.CursorKeyError',
)('MessageHistoryCursorKeyError', {
  cause: Schema.Defect(),
}) {}

export class CursorEncodingError extends Schema.TaggedError<CursorEncodingError>(
  '@yokai/memory/MessageHistory.CursorEncodingError',
)('MessageHistoryCursorEncodingError', {
  cause: Schema.Defect(),
}) {}

export interface PreparedQuery {
  readonly execute: () => Effect.Effect<
    HistoryPage,
    StorageError | ResultBudgetExceededError | CursorEncodingError
  >
}

export interface Interface {
  readonly prepare: (
    request: HistoryPageRequest,
  ) => Effect.Effect<
    PreparedQuery,
    | CursorInvalidError
    | CursorScopeMismatchError
    | InstanceScopeMismatchError
    | InvalidTimeRangeError
  >
  readonly page: (
    request: HistoryPageRequest,
  ) => Effect.Effect<
    HistoryPage,
    | StorageError
    | CursorInvalidError
    | CursorScopeMismatchError
    | InstanceScopeMismatchError
    | InvalidTimeRangeError
    | ResultBudgetExceededError
    | CursorEncodingError
  >
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/memory/MessageHistory',
) {}

const scopeEqual = (left: ChannelScope, right: CursorPayload['scope']): boolean =>
  left.instanceId === right.instanceId &&
  left.platform === right.platform &&
  left.guildId === right.guildId &&
  left.channelId === right.channelId

const ensureInstance = (
  configuredInstanceId: InstanceId,
  requestedInstanceId: InstanceId,
): Effect.Effect<void, InstanceScopeMismatchError> =>
  configuredInstanceId === requestedInstanceId
    ? Effect.void
    : Effect.fail(new InstanceScopeMismatchError({ configuredInstanceId, requestedInstanceId }))

const validateRange = (filters: HistoryFilters): Effect.Effect<void, InvalidTimeRangeError> =>
  Option.isSome(filters.fromTimestamp) &&
  Option.isSome(filters.toTimestamp) &&
  filters.fromTimestamp.value > filters.toTimestamp.value
    ? Effect.fail(new InvalidTimeRangeError({}))
    : Effect.void

const serializePayload = (scope: ChannelScope, position: HistoryPosition): string =>
  JSON.stringify({
    version: CURSOR_VERSION,
    scope: {
      instanceId: scope.instanceId,
      platform: scope.platform,
      guildId: scope.guildId,
      channelId: scope.channelId,
    },
    position,
  })

const sign = (key: Uint8Array, body: string): string =>
  createHmac('sha256', key).update(body).digest('base64url')

const encodeCursor = Effect.fn('MessageHistory.encodeCursor')(function* (
  key: Uint8Array,
  scope: ChannelScope,
  position: HistoryPosition,
) {
  return yield* Effect.try({
    try: () => {
      const body = Encoding.encodeBase64Url(serializePayload(scope, position))
      return HistoryCursor.make(`${body}.${sign(key, body)}`)
    },
    catch: (cause) => new CursorEncodingError({ cause }),
  })
})

const decodePayload = (encoded: string) =>
  Result.match(Encoding.decodeBase64UrlString(encoded), {
    onFailure: () => Effect.fail(new CursorInvalidError({})),
    onSuccess: (json) =>
      Effect.try({
        try: () => JSON.parse(json),
        catch: () => new CursorInvalidError({}),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CursorPayload)),
        Effect.mapError(() => new CursorInvalidError({})),
      ),
  })

const decodeCursor = Effect.fn('MessageHistory.decodeCursor')(function* (
  key: Uint8Array,
  scope: ChannelScope,
  cursor: HistoryCursor,
) {
  const separator = cursor.indexOf('.')
  if (
    separator <= 0 ||
    separator === cursor.length - 1 ||
    cursor.indexOf('.', separator + 1) >= 0
  ) {
    return yield* Effect.fail(new CursorInvalidError({}))
  }
  const body = cursor.slice(0, separator)
  const candidate = cursor.slice(separator + 1)
  const expected = yield* Effect.try({
    try: () => sign(key, body),
    catch: () => new CursorInvalidError({}),
  })
  const signatureMatches = yield* Effect.try({
    try: () => {
      const left = Buffer.from(candidate)
      const right = Buffer.from(expected)
      return left.length === right.length && timingSafeEqual(left, right)
    },
    catch: () => new CursorInvalidError({}),
  })
  if (!signatureMatches) return yield* Effect.fail(new CursorInvalidError({}))

  const payload = yield* decodePayload(body)
  if (!scopeEqual(scope, payload.scope)) {
    return yield* Effect.fail(new CursorScopeMismatchError({}))
  }
  return payload.position
})

interface BudgetedMessages {
  readonly messages: HistoryPage['messages']
  readonly estimatedTokens: TokenCount
  readonly truncated: boolean
}

const applyTokenBudget = (
  messages: HistoryPage['messages'],
  tokenBudget: number,
): BudgetedMessages => {
  const initial: BudgetedMessages = {
    messages: [],
    estimatedTokens: TokenCount.make(0),
    truncated: false,
  }
  return messages.reduce<BudgetedMessages>((current, message) => {
    if (current.truncated) return current
    const nextTokens = current.estimatedTokens + estimateMessageTokens(message)
    return nextTokens > tokenBudget
      ? { ...current, truncated: true }
      : {
          messages: [...current.messages, message],
          estimatedTokens: TokenCount.make(nextTokens),
          truncated: false,
        }
  }, initial)
}

const buildPage = Effect.fn('MessageHistory.buildPage')(function* (
  key: Uint8Array,
  request: HistoryPageRequest,
  rows: ReadonlyArray<HistoryPage['messages'][number]>,
) {
  const hasRowOverflow = rows.length > request.limit
  const limited = rows.slice(0, request.limit)
  const budgeted = applyTokenBudget(limited, request.tokenBudget)
  if (limited.length > 0 && budgeted.messages.length === 0) {
    return yield* Effect.fail(new ResultBudgetExceededError({ tokenBudget: request.tokenBudget }))
  }

  const hasMore = hasRowOverflow || budgeted.truncated
  const last = budgeted.messages[budgeted.messages.length - 1]
  const nextCursor =
    hasMore && last !== undefined
      ? Option.some(yield* encodeCursor(key, request.scope, positionOf(last)))
      : Option.none<HistoryCursor>()
  return HistoryPage.make({
    messages: budgeted.messages,
    nextCursor,
    hasMore,
    estimatedTokens: budgeted.estimatedTokens,
  })
})

export const layer = (instanceId: InstanceId) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const storage = yield* MessageHistoryStorage.Service
      const key = yield* Effect.try({
        try: () => randomBytes(CURSOR_KEY_BYTES),
        catch: (cause) => new CursorKeyError({ cause }),
      })

      const prepare = Effect.fn('MessageHistory.prepare')(function* (request: HistoryPageRequest) {
        yield* ensureInstance(instanceId, request.scope.instanceId)
        yield* validateRange(request.filters)
        const anchor = yield* Option.match(request.cursor, {
          onNone: () => Effect.succeed(Option.none<HistoryPosition>()),
          onSome: (cursor) =>
            decodeCursor(key, request.scope, cursor).pipe(Effect.map(Option.some)),
        })
        const storageRequest: StorageSearchRequest = {
          scope: request.scope,
          direction: request.direction,
          anchor,
          filters: request.filters,
          fetchLimit: request.limit + 1,
        }
        return {
          execute: () =>
            storage
              .search(storageRequest)
              .pipe(Effect.flatMap((rows) => buildPage(key, request, rows))),
        } satisfies PreparedQuery
      })

      const page = Effect.fn('MessageHistory.page')(function* (request: HistoryPageRequest) {
        const prepared = yield* prepare(request)
        return yield* prepared.execute()
      })

      return Service.of({ prepare, page })
    }),
  )

export * as MessageHistory from './history'
