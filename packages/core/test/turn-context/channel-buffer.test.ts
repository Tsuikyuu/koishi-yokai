import { MessageArchiveEvent } from '@yokai-internal/memory'
import { expect, it } from '@effect/vitest'
import { CapabilityScope, FocusMessage, TokenLimit } from 'yokai-protocol'
import { Effect, Option, Schema } from 'effect'

import { ChannelMessageBuffer, TurnSnapshot } from '../../src/index'

const INSTANCE_ID = MessageArchiveEvent.InstanceId.make('snapshot-test')
const PLATFORM_ID = MessageArchiveEvent.PlatformId.make('test')
const GUILD_ID = MessageArchiveEvent.GuildId.make('guild')
const AUTHOR_ID = MessageArchiveEvent.ActorId.make('author')
const SELF_ID = MessageArchiveEvent.ActorId.make('bot')

const archiveScope = (channelId = 'channel') =>
  MessageArchiveEvent.ChannelScope.make({
    instanceId: INSTANCE_ID,
    platform: PLATFORM_ID,
    guildId: GUILD_ID,
    channelId: MessageArchiveEvent.ChannelId.make(channelId),
  })

const capabilityScope = (channelId = 'channel') =>
  CapabilityScope.make({
    instanceId: INSTANCE_ID,
    platform: PLATFORM_ID,
    guildId: GUILD_ID,
    channelId,
  })

const message = (
  index: number,
  options: {
    readonly channelId?: string
    readonly content?: string
    readonly version?: number
  } = {},
) => {
  const timestamp = MessageArchiveEvent.Timestamp.make(index)
  return MessageArchiveEvent.ArchivedMessage.make({
    ...archiveScope(options.channelId),
    messageId: MessageArchiveEvent.MessageId.make(`message-${String(index).padStart(3, '0')}`),
    version: MessageArchiveEvent.MessageVersion.make(
      options.version === undefined ? 1 : options.version,
    ),
    sourceVersion:
      options.version === undefined || options.version === 1
        ? Option.none()
        : Option.some(MessageArchiveEvent.MessageVersion.make(1)),
    previousVersion:
      options.version === undefined || options.version === 1
        ? Option.none()
        : Option.some(MessageArchiveEvent.MessageVersion.make(options.version - 1)),
    kind: options.version === undefined || options.version === 1 ? 'created' : 'updated',
    authorId: AUTHOR_ID,
    selfId: SELF_ID,
    replyToMessageId: Option.none(),
    timestamp,
    eventTimestamp: timestamp,
    recordedAt: timestamp,
    content: options.content === undefined ? `content-${index}` : options.content,
    isSelf: false,
  })
}

const focus = (index: number, content = `focus-${index}`) =>
  FocusMessage.make({
    messageId: `message-${String(index).padStart(3, '0')}`,
    authorId: AUTHOR_ID,
    timestamp: index,
    content,
  })

const request = (
  focusMessage: FocusMessage,
  options: {
    readonly channelId?: string
    readonly messageCount?: number
    readonly tokenBudget?: number
  } = {},
) =>
  TurnSnapshot.Request.make({
    scope: capabilityScope(options.channelId),
    focus: focusMessage,
    messageCount: TurnSnapshot.MessageCount.make(
      options.messageCount === undefined ? 40 : options.messageCount,
    ),
    tokenBudget: TokenLimit.make(options.tokenBudget === undefined ? 10_000 : options.tokenBudget),
  })

it.effect('keeps the latest 80 messages per channel and replaces edited messages in place', () =>
  Effect.gen(function* () {
    const buffer = yield* ChannelMessageBuffer.Service
    yield* Effect.forEach(
      Array.from({ length: 85 }, (_, index) => index),
      (index) => buffer.ingest(message(index)),
    )
    yield* buffer.ingest(message(83, { content: 'edited-content', version: 2 }))
    yield* buffer.ingest(message(83, { content: 'stale-content', version: 1 }))
    yield* buffer.ingest(message(1, { channelId: 'other' }))

    const snapshot = yield* buffer.snapshot(request(focus(84), { messageCount: 80 }))
    expect(snapshot.recentMessages).toHaveLength(79)
    const oldest = snapshot.recentMessages[0]
    const newest = snapshot.recentMessages.at(-1)
    if (oldest === undefined || newest === undefined) {
      return yield* Effect.die('Expected a full recent-message snapshot')
    }
    expect(oldest.messageId).toBe('message-005')
    expect(newest.messageId).toBe('message-083')
    expect(snapshot.recentMessages.filter((entry) => entry.messageId === 'message-083')).toEqual([
      expect.objectContaining({ content: 'edited-content' }),
    ])

    const isolated = yield* buffer.snapshot(
      request(focus(1), { channelId: 'other', messageCount: 20 }),
    )
    expect(isolated.recentMessages).toEqual([])
  }).pipe(Effect.provide(ChannelMessageBuffer.layer)),
)

it.effect('always keeps an old focus and then selects the newest messages at the count limit', () =>
  Effect.gen(function* () {
    const buffer = yield* ChannelMessageBuffer.Service
    yield* Effect.forEach(
      Array.from({ length: 100 }, (_, index) => index),
      (index) => buffer.ingest(message(index)),
    )

    const snapshot = yield* buffer.snapshot(request(focus(0), { messageCount: 20 }))
    expect(snapshot.focus.messageId).toBe('message-000')
    expect(snapshot.recentMessages.map((entry) => entry.messageId)).toEqual(
      Array.from({ length: 19 }, (_, offset) => `message-${String(offset + 81).padStart(3, '0')}`),
    )
  }).pipe(Effect.provide(ChannelMessageBuffer.layer)),
)

it.effect('stops at the token budget while retaining focus and the newest fitting messages', () =>
  Effect.gen(function* () {
    const focusMessage = focus(6, 'bounded focus')
    const newest = message(5, { content: 'newest context' })
    const calibrated = yield* TurnSnapshot.create(
      [newest],
      request(focusMessage, { messageCount: 20 }),
    )
    const buffer = yield* ChannelMessageBuffer.Service
    yield* Effect.forEach([message(1), message(2), message(3), message(4), newest], buffer.ingest)

    const snapshot = yield* buffer.snapshot(
      request(focusMessage, {
        messageCount: 20,
        tokenBudget: calibrated.estimatedTokens,
      }),
    )
    expect(snapshot.focus).toEqual(focusMessage)
    expect(snapshot.recentMessages.map((entry) => entry.messageId)).toEqual(['message-005'])
    expect(snapshot.estimatedTokens).toBe(calibrated.estimatedTokens)

    const error = yield* buffer
      .snapshot(request(focus(7, 'content that cannot fit in one token'), { tokenBudget: 1 }))
      .pipe(Effect.flip)
    expect(error._tag).toBe('TurnSnapshotFocusExceedsTokenBudgetError')
  }).pipe(Effect.provide(ChannelMessageBuffer.layer)),
)

it.effect('keeps an existing snapshot unchanged when messages arrive for the next turn', () =>
  Effect.gen(function* () {
    const buffer = yield* ChannelMessageBuffer.Service
    yield* buffer.ingest(message(1))
    const snapshotRequest = request(focus(2))
    const currentTurn = yield* buffer.snapshot(snapshotRequest)

    yield* buffer.ingest(message(3, { content: 'arrived during generation' }))
    const nextTurn = yield* buffer.snapshot(snapshotRequest)

    expect(currentTurn.recentMessages.map((entry) => entry.messageId)).toEqual(['message-001'])
    expect(TurnSnapshot.renderRecentMessages(currentTurn)).not.toEqual(
      TurnSnapshot.renderRecentMessages(nextTurn),
    )
    expect(nextTurn.recentMessages.map((entry) => entry.messageId)).toEqual([
      'message-001',
      'message-003',
    ])
  }).pipe(Effect.provide(ChannelMessageBuffer.layer)),
)

it.effect('accepts only snapshot message counts from 20 through 80', () =>
  Effect.gen(function* () {
    expect(yield* Schema.decodeUnknownEffect(TurnSnapshot.MessageCount)(20)).toBe(20)
    expect(yield* Schema.decodeUnknownEffect(TurnSnapshot.MessageCount)(80)).toBe(80)
    yield* Effect.all(
      [19, 81].map((value) =>
        Schema.decodeUnknownEffect(TurnSnapshot.MessageCount)(value).pipe(Effect.flip),
      ),
      { discard: true },
    )
  }),
)
