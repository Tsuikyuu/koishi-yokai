import { expect, it } from '@effect/vitest'
import { Context, Effect, Layer, Option, Ref } from 'effect'
import { TokenLimit } from 'yokai-protocol'

import {
  MessageArchiveEvent,
  MessageHistory,
  MessageHistoryQuery,
  MessageHistoryStorage,
} from '../../src/index'

interface TestStorageInterface extends MessageHistoryStorage.Interface {
  readonly insert: (message: MessageArchiveEvent.ArchivedMessage) => Effect.Effect<void>
}

class TestStorage extends Context.Service<TestStorage, TestStorageInterface>()(
  '@yokai/memory/MessageHistoryStorage/Test',
) {}

const compare = (
  direction: MessageHistoryQuery.HistoryDirection,
  left: MessageArchiveEvent.ArchivedMessage,
  right: MessageArchiveEvent.ArchivedMessage,
) => {
  const value = MessageHistoryQuery.comparePositions(
    MessageHistoryQuery.positionOf(left),
    MessageHistoryQuery.positionOf(right),
  )
  return direction === 'before' ? -value : value
}

const testStorageLayer = Layer.effectContext(
  Effect.gen(function* () {
    const state = yield* Ref.make<ReadonlyArray<MessageArchiveEvent.ArchivedMessage>>([])
    const service = TestStorage.of({
      insert: Effect.fn('MessageHistoryTestStorage.insert')(function* (message) {
        yield* Ref.update(state, (messages) => [...messages, message])
      }),
      search: Effect.fn('MessageHistoryTestStorage.search')(function* (request) {
        const messages = yield* Ref.get(state)
        return [...messages]
          .filter((message) =>
            Option.match(request.anchor, {
              onNone: () => true,
              onSome: (anchor) => {
                const comparison = MessageHistoryQuery.comparePositions(
                  MessageHistoryQuery.positionOf(message),
                  anchor,
                )
                return request.direction === 'before' ? comparison < 0 : comparison > 0
              },
            }),
          )
          .sort((left, right) => compare(request.direction, left, right))
          .slice(0, request.fetchLimit)
      }),
    })
    return Context.empty().pipe(
      Context.add(MessageHistoryStorage.Service, service),
      Context.add(TestStorage, service),
    )
  }),
)

const INSTANCE_ID = MessageArchiveEvent.InstanceId.make('history-test')
const AUTHOR_ID = MessageArchiveEvent.ActorId.make('author')
const SELF_ID = MessageArchiveEvent.ActorId.make('bot')

const scope = (channelId = 'channel') =>
  MessageArchiveEvent.ChannelScope.make({
    instanceId: INSTANCE_ID,
    platform: MessageArchiveEvent.PlatformId.make('test'),
    guildId: MessageArchiveEvent.GuildId.make('guild'),
    channelId: MessageArchiveEvent.ChannelId.make(channelId),
  })

const message = (id: string, timestamp: number, content = `message-${id}`) =>
  MessageArchiveEvent.ArchivedMessage.make({
    ...scope(),
    messageId: MessageArchiveEvent.MessageId.make(id),
    version: MessageArchiveEvent.MessageVersion.make(1),
    sourceVersion: Option.none(),
    previousVersion: Option.none(),
    kind: 'created',
    authorId: AUTHOR_ID,
    selfId: SELF_ID,
    timestamp: MessageArchiveEvent.Timestamp.make(timestamp),
    eventTimestamp: MessageArchiveEvent.Timestamp.make(timestamp),
    recordedAt: MessageArchiveEvent.Timestamp.make(timestamp),
    content,
    isSelf: false,
  })

const request = (
  cursor: Option.Option<MessageHistoryQuery.HistoryCursor>,
  channelId = 'channel',
  limit = 40,
  tokenBudget = 10_000,
) =>
  MessageHistoryQuery.HistoryPageRequest.make({
    scope: scope(channelId),
    direction: 'before',
    cursor,
    limit: MessageHistoryQuery.HistoryPageLimit.make(limit),
    filters: MessageHistoryQuery.emptyFilters(),
    tokenBudget: TokenLimit.make(tokenBudget),
  })

const historyLayer = MessageHistory.layer(INSTANCE_ID).pipe(Layer.provideMerge(testStorageLayer))

it.effect('keeps every same-timestamp message reachable across stable pages', () =>
  Effect.gen(function* () {
    const history = yield* MessageHistory.Service
    const storage = yield* TestStorage
    yield* Effect.all(
      Array.from({ length: 50 }, (_, index) =>
        storage.insert(message(`message-${String(index).padStart(2, '0')}`, 1_000)),
      ),
      { discard: true },
    )

    const first = yield* history.page(request(Option.none()))
    expect(first.messages).toHaveLength(40)
    expect(first.hasMore).toBe(true)
    if (Option.isNone(first.nextCursor)) return yield* Effect.die('Expected a next cursor')
    const second = yield* history.page(request(Option.some(first.nextCursor.value)))
    expect(second.messages).toHaveLength(10)
    expect(second.hasMore).toBe(false)

    const ids = [...first.messages, ...second.messages].map((item) => item.messageId)
    expect(new Set(ids).size).toBe(50)
  }).pipe(Effect.provide(historyLayer)),
)

it.effect('does not duplicate or shift prior pages when a newer message is inserted', () =>
  Effect.gen(function* () {
    const history = yield* MessageHistory.Service
    const storage = yield* TestStorage
    yield* Effect.all(
      [1, 2, 3, 4, 5].map((timestamp) => storage.insert(message(`m-${timestamp}`, timestamp))),
      { discard: true },
    )

    const first = yield* history.page(request(Option.none(), 'channel', 2))
    expect(first.messages.map((item) => item.messageId)).toEqual(['m-5', 'm-4'])
    if (Option.isNone(first.nextCursor)) return yield* Effect.die('Expected a next cursor')
    yield* storage.insert(message('m-6', 6))

    const second = yield* history.page(request(Option.some(first.nextCursor.value), 'channel', 2))
    expect(second.messages.map((item) => item.messageId)).toEqual(['m-3', 'm-2'])
  }).pipe(Effect.provide(historyLayer)),
)

it.effect('pages forward with an after cursor without repeating earlier messages', () =>
  Effect.gen(function* () {
    const history = yield* MessageHistory.Service
    const storage = yield* TestStorage
    yield* Effect.all(
      [1, 2, 3, 4, 5].map((timestamp) => storage.insert(message(`m-${timestamp}`, timestamp))),
      { discard: true },
    )
    const forwardRequest = (cursor: Option.Option<MessageHistoryQuery.HistoryCursor>) =>
      MessageHistoryQuery.HistoryPageRequest.make({
        scope: scope(),
        direction: 'after',
        cursor,
        limit: MessageHistoryQuery.HistoryPageLimit.make(2),
        filters: MessageHistoryQuery.emptyFilters(),
        tokenBudget: TokenLimit.make(10_000),
      })

    const first = yield* history.page(forwardRequest(Option.none()))
    expect(first.messages.map((item) => item.messageId)).toEqual(['m-1', 'm-2'])
    if (Option.isNone(first.nextCursor)) return yield* Effect.die('Expected a next cursor')
    const second = yield* history.page(forwardRequest(Option.some(first.nextCursor.value)))
    expect(second.messages.map((item) => item.messageId)).toEqual(['m-3', 'm-4'])
  }).pipe(Effect.provide(historyLayer)),
)

it.effect('rejects tampered and cross-scope cursors before storage execution', () =>
  Effect.gen(function* () {
    const history = yield* MessageHistory.Service
    const storage = yield* TestStorage
    yield* storage.insert(message('one', 1))
    yield* storage.insert(message('two', 2))
    const first = yield* history.page(request(Option.none(), 'channel', 1))
    if (Option.isNone(first.nextCursor)) return yield* Effect.die('Expected a next cursor')

    const cursor = first.nextCursor.value
    const replacement = cursor.endsWith('A') ? 'B' : 'A'
    const tampered = MessageHistoryQuery.HistoryCursor.make(cursor.slice(0, -1) + replacement)
    const tamperedError = yield* history.prepare(request(Option.some(tampered))).pipe(Effect.flip)
    expect(tamperedError._tag).toBe('MessageHistoryCursorInvalidError')

    const scopeError = yield* history
      .prepare(request(Option.some(cursor), 'other-channel'))
      .pipe(Effect.flip)
    expect(scopeError._tag).toBe('MessageHistoryCursorScopeMismatchError')
  }).pipe(Effect.provide(historyLayer)),
)

it.effect('rejects invalid time ranges and results that cannot fit the token budget', () =>
  Effect.gen(function* () {
    const history = yield* MessageHistory.Service
    const storage = yield* TestStorage
    yield* storage.insert(message('large', 1, 'x'.repeat(200)))

    const invalidRange = MessageHistoryQuery.HistoryPageRequest.make({
      scope: scope(),
      direction: 'before',
      cursor: Option.none(),
      limit: MessageHistoryQuery.defaultPageLimit(),
      filters: MessageHistoryQuery.HistoryFilters.make({
        authorId: Option.none(),
        keyword: Option.none(),
        fromTimestamp: Option.some(MessageArchiveEvent.Timestamp.make(2)),
        toTimestamp: Option.some(MessageArchiveEvent.Timestamp.make(1)),
      }),
      tokenBudget: TokenLimit.make(10_000),
    })
    const rangeError = yield* history.prepare(invalidRange).pipe(Effect.flip)
    expect(rangeError._tag).toBe('MessageHistoryInvalidTimeRangeError')

    const budgetError = yield* history
      .page(request(Option.none(), 'channel', 1, 1))
      .pipe(Effect.flip)
    expect(budgetError._tag).toBe('MessageHistoryResultBudgetExceededError')
  }).pipe(Effect.provide(historyLayer)),
)

it.effect('keeps cursors valid for maximum-length legal scope and message identifiers', () =>
  Effect.gen(function* () {
    const history = yield* MessageHistory.Service
    const storage = yield* TestStorage
    const maximalScope = MessageArchiveEvent.ChannelScope.make({
      instanceId: INSTANCE_ID,
      platform: MessageArchiveEvent.PlatformId.make('\\'.repeat(512)),
      guildId: MessageArchiveEvent.GuildId.make('\\'.repeat(512)),
      channelId: MessageArchiveEvent.ChannelId.make('\\'.repeat(512)),
    })
    const maximalMessage = (character: string) =>
      MessageArchiveEvent.ArchivedMessage.make({
        ...message('placeholder', 1),
        ...maximalScope,
        messageId: MessageArchiveEvent.MessageId.make(character.repeat(512)),
      })
    yield* storage.insert(maximalMessage('"'))
    yield* storage.insert(maximalMessage('\\'))

    const maximalRequest = (cursor: Option.Option<MessageHistoryQuery.HistoryCursor>) =>
      MessageHistoryQuery.HistoryPageRequest.make({
        scope: maximalScope,
        direction: 'before',
        cursor,
        limit: MessageHistoryQuery.HistoryPageLimit.make(1),
        filters: MessageHistoryQuery.emptyFilters(),
        tokenBudget: TokenLimit.make(10_000),
      })
    const first = yield* history.page(maximalRequest(Option.none()))
    if (Option.isNone(first.nextCursor)) return yield* Effect.die('Expected a next cursor')
    expect(first.nextCursor.value.length).toBeLessThanOrEqual(
      MessageHistoryQuery.MAX_HISTORY_CURSOR_LENGTH,
    )
    const second = yield* history.page(maximalRequest(Option.some(first.nextCursor.value)))
    expect(second.messages).toHaveLength(1)
  }).pipe(Effect.provide(historyLayer)),
)
