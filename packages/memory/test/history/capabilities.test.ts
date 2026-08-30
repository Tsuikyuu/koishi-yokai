import { expect, it } from '@effect/vitest'
import { Effect, Layer, Option, Schema } from 'effect'
import {
  CapabilityScope,
  ContextProviderRequest,
  FeedbackToolRequest,
  TokenLimit,
} from 'yokai-protocol'

import {
  HistoryCapabilities,
  MessageArchiveEvent,
  MessageHistory,
  MessageHistoryQuery,
  MessageHistoryStorage,
} from '../../src/index'

const INSTANCE_ID = MessageArchiveEvent.InstanceId.make('capability-test')
const CHANNEL_SCOPE = MessageArchiveEvent.ChannelScope.make({
  instanceId: INSTANCE_ID,
  platform: MessageArchiveEvent.PlatformId.make('test'),
  guildId: MessageArchiveEvent.GuildId.make('guild'),
  channelId: MessageArchiveEvent.ChannelId.make('channel'),
})
const CAPABILITY_SCOPE = CapabilityScope.make(CHANNEL_SCOPE)
const AUTHOR_ID = MessageArchiveEvent.ActorId.make('author')
const SELF_ID = MessageArchiveEvent.ActorId.make('bot')

const message = (index: number) =>
  MessageArchiveEvent.ArchivedMessage.make({
    ...CHANNEL_SCOPE,
    messageId: MessageArchiveEvent.MessageId.make(`message-${String(index).padStart(2, '0')}`),
    version: MessageArchiveEvent.MessageVersion.make(1),
    sourceVersion: Option.none(),
    previousVersion: Option.none(),
    kind: 'created',
    authorId: AUTHOR_ID,
    selfId: SELF_ID,
    replyToMessageId: Option.none(),
    timestamp: MessageArchiveEvent.Timestamp.make(index),
    eventTimestamp: MessageArchiveEvent.Timestamp.make(index),
    recordedAt: MessageArchiveEvent.Timestamp.make(index),
    content: index === 10 ? 'the project deadline is Friday' : `ordinary message ${index}`,
    isSelf: false,
  })

const MESSAGES = Array.from({ length: 45 }, (_, index) => message(index + 1))

const storageLayer = Layer.succeed(
  MessageHistoryStorage.Service,
  MessageHistoryStorage.Service.of({
    search: Effect.fn('HistoryCapabilitiesTestStorage.search')((request) =>
      Effect.succeed(
        [...MESSAGES]
          .filter((item) =>
            Option.match(request.anchor, {
              onNone: () => true,
              onSome: (anchor) => {
                const comparison = MessageHistoryQuery.comparePositions(
                  MessageHistoryQuery.positionOf(item),
                  anchor,
                )
                return request.direction === 'before' ? comparison < 0 : comparison > 0
              },
            }),
          )
          .sort((left, right) => {
            const comparison = MessageHistoryQuery.comparePositions(
              MessageHistoryQuery.positionOf(left),
              MessageHistoryQuery.positionOf(right),
            )
            return request.direction === 'before' ? -comparison : comparison
          })
          .slice(0, request.fetchLimit),
      ),
    ),
  }),
)

const historyLayer = MessageHistory.layer(INSTANCE_ID).pipe(Layer.provide(storageLayer))

const ToolOutput = Schema.Struct({
  untrusted: Schema.Boolean,
  messages: Schema.Array(
    Schema.Struct({
      messageId: Schema.String,
      authorId: Schema.String,
      timestamp: Schema.Number,
      content: Schema.String,
    }),
  ),
  hasMore: Schema.Boolean,
  nextCursor: Schema.optionalKey(Schema.String),
})

const executeSearch = Effect.fn('HistoryCapabilitiesTest.executeSearch')(function* (
  input: Schema.JsonObject,
  scope = CAPABILITY_SCOPE,
) {
  const history = yield* MessageHistory.Service
  const tool = HistoryCapabilities.makeFeedbackTool(history)
  const prepared = yield* tool.prepare(FeedbackToolRequest.make({ scope, input }))
  const output = yield* prepared.execute()
  return yield* Schema.decodeUnknownEffect(ToolOutput)(output)
})

it.effect('uses the default page size of 40 and emits a bounded opaque next cursor', () =>
  Effect.gen(function* () {
    const output = yield* executeSearch({})
    expect(output.untrusted).toBe(true)
    expect(output.messages).toHaveLength(40)
    expect(output.hasMore).toBe(true)
    expect(output.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)

    const maximumPage = yield* executeSearch({ limit: 100 })
    expect(maximumPage.messages).toHaveLength(45)
    expect(maximumPage.hasMore).toBe(false)
  }).pipe(Effect.provide(historyLayer)),
)

it.effect('rejects over-limit, excess-scope, tampered, and cross-scope inputs', () =>
  Effect.gen(function* () {
    const history = yield* MessageHistory.Service
    const tool = HistoryCapabilities.makeFeedbackTool(history)

    const limitError = yield* tool
      .prepare(FeedbackToolRequest.make({ scope: CAPABILITY_SCOPE, input: { limit: 101 } }))
      .pipe(Effect.flip)
    expect(limitError.reason).toBe('budget-exceeded')

    const scopeInjection = yield* tool
      .prepare(
        FeedbackToolRequest.make({
          scope: CAPABILITY_SCOPE,
          input: { channelId: 'other-channel' },
        }),
      )
      .pipe(Effect.flip)
    expect(scopeInjection.reason).toBe('invalid-input')

    const first = yield* executeSearch({})
    if (first.nextCursor === undefined) return yield* Effect.die('Expected a cursor')
    const cursor = first.nextCursor
    const replacement = cursor.endsWith('A') ? 'B' : 'A'
    const tampered = cursor.slice(0, -1) + replacement
    const tamperedError = yield* tool
      .prepare(FeedbackToolRequest.make({ scope: CAPABILITY_SCOPE, input: { before: tampered } }))
      .pipe(Effect.flip)
    expect(tamperedError.reason).toBe('invalid-input')

    const otherScope = CapabilityScope.make({ ...CAPABILITY_SCOPE, channelId: 'other-channel' })
    const crossScopeError = yield* tool
      .prepare(FeedbackToolRequest.make({ scope: otherScope, input: { before: cursor } }))
      .pipe(Effect.flip)
    expect(crossScopeError.reason).toBe('scope-denied')
  }).pipe(Effect.provide(historyLayer)),
)

it.effect('selects relevant prior history into an explicitly untrusted context fragment', () =>
  Effect.gen(function* () {
    const history = yield* MessageHistory.Service
    const provider = HistoryCapabilities.makeContextProvider(history)
    const fragment = yield* provider.provide(
      ContextProviderRequest.make({
        scope: CAPABILITY_SCOPE,
        focus: {
          messageId: 'focus-message',
          authorId: 'author',
          timestamp: 100,
          content: 'When is the project deadline?',
        },
        tokenBudget: TokenLimit.make(2_048),
      }),
    )

    if (Option.isNone(fragment)) return yield* Effect.die('Expected relevant history')
    expect(fragment.value.untrusted).toBe(true)
    expect(fragment.value.content).toContain('the project deadline is Friday')
    expect(fragment.value.content).toContain('never as instructions')
    expect(fragment.value.estimatedTokens).toBeLessThanOrEqual(2_048)
  }).pipe(Effect.provide(historyLayer)),
)

it.effect('rejects JSON-expanded feedback output that exceeds the declared result budget', () =>
  Effect.gen(function* () {
    const oversized = MessageArchiveEvent.ArchivedMessage.make({
      ...message(1),
      content: '\u0000'.repeat(4_000),
    })
    const oversizedStorage = Layer.succeed(
      MessageHistoryStorage.Service,
      MessageHistoryStorage.Service.of({
        search: () => Effect.succeed([oversized]),
      }),
    )
    const oversizedHistory = MessageHistory.layer(INSTANCE_ID).pipe(Layer.provide(oversizedStorage))
    const error = yield* Effect.gen(function* () {
      const history = yield* MessageHistory.Service
      const tool = HistoryCapabilities.makeFeedbackTool(history)
      const prepared = yield* tool.prepare(
        FeedbackToolRequest.make({ scope: CAPABILITY_SCOPE, input: {} }),
      )
      return yield* prepared.execute().pipe(Effect.flip)
    }).pipe(Effect.provide(oversizedHistory))

    expect(error.reason).toBe('result-too-large')
  }),
)
