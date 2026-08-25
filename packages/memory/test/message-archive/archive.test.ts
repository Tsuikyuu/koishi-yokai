import { expect, it } from '@effect/vitest'
import { Context, Duration, Effect, Layer, Option, SynchronizedRef } from 'effect'
import { TestClock } from 'effect/testing'

import { MessageArchive, MessageArchiveEvent, MessageArchiveStorage } from '../../src/index'

interface TestStorageInterface extends MessageArchiveStorage.Interface {
  readonly all: () => Effect.Effect<ReadonlyArray<MessageArchiveEvent.ArchivedMessage>>
}

class TestStorage extends Context.Service<TestStorage, TestStorageInterface>()(
  '@yokai/memory/MessageArchiveStorage/Test',
) {}

const matchesScope = (
  message: MessageArchiveEvent.ArchivedMessage,
  scope: MessageArchiveEvent.ChannelScope,
): boolean =>
  message.instanceId === scope.instanceId &&
  message.platform === scope.platform &&
  message.guildId === scope.guildId &&
  message.channelId === scope.channelId

const latestFrom = (
  messages: ReadonlyArray<MessageArchiveEvent.ArchivedMessage>,
  scope: MessageArchiveEvent.ChannelScope,
  messageId: MessageArchiveEvent.MessageId,
): Option.Option<MessageArchiveEvent.ArchivedMessage> =>
  messages
    .filter((message) => matchesScope(message, scope) && message.messageId === messageId)
    .reduce<Option.Option<MessageArchiveEvent.ArchivedMessage>>(
      (latest, message) =>
        Option.match(latest, {
          onNone: () => Option.some(message),
          onSome: (current) =>
            current.version < message.version ? Option.some(message) : Option.some(current),
        }),
      Option.none(),
    )

const testStorageLayer = Layer.effectContext(
  Effect.gen(function* () {
    const state = yield* SynchronizedRef.make<ReadonlyArray<MessageArchiveEvent.ArchivedMessage>>(
      [],
    )

    const latest = Effect.fn('MessageArchiveTestStorage.latest')(function* (
      scope: MessageArchiveEvent.ChannelScope,
      messageId: MessageArchiveEvent.MessageId,
    ) {
      return latestFrom(yield* SynchronizedRef.get(state), scope, messageId)
    })

    const versions = Effect.fn('MessageArchiveTestStorage.versions')(function* (
      scope: MessageArchiveEvent.ChannelScope,
      messageId: MessageArchiveEvent.MessageId,
    ) {
      return (yield* SynchronizedRef.get(state))
        .filter((message) => matchesScope(message, scope) && message.messageId === messageId)
        .sort((left, right) => left.version - right.version)
    })

    const store = Effect.fn('MessageArchiveTestStorage.store')(function* (
      event: MessageArchiveEvent.NormalizedEvent,
      recordedAt: MessageArchiveEvent.Timestamp,
    ) {
      const updateState = (
        messages: ReadonlyArray<MessageArchiveEvent.ArchivedMessage>,
      ): Effect.Effect<
        readonly [
          MessageArchiveEvent.RecordResult,
          ReadonlyArray<MessageArchiveEvent.ArchivedMessage>,
        ],
        MessageArchiveStorage.OriginalMessageNotFoundError
      > => {
        const scope = MessageArchiveEvent.scopeOf(event)
        const current = latestFrom(messages, scope, event.messageId)
        if (event._tag === 'MessageCreated') {
          if (Option.isSome(current)) {
            return Effect.succeed([
              MessageArchiveEvent.RecordResult.Replay({ message: current.value }),
              messages,
            ] as const)
          }
          const message = MessageArchiveEvent.originalMessage(event, recordedAt)
          return Effect.succeed([
            MessageArchiveEvent.RecordResult.Stored({ message }),
            [...messages, message],
          ] as const)
        }
        if (Option.isNone(current)) {
          return Effect.fail(
            new MessageArchiveStorage.OriginalMessageNotFoundError({
              instanceId: event.instanceId,
              messageId: event.messageId,
            }),
          )
        }
        if (current.value.content === event.content) {
          return Effect.succeed([
            MessageArchiveEvent.RecordResult.Replay({ message: current.value }),
            messages,
          ] as const)
        }
        const message = MessageArchiveEvent.editedVersion(event, current.value, recordedAt)
        return Effect.succeed([
          MessageArchiveEvent.RecordResult.Stored({ message }),
          [...messages, message],
        ] as const)
      }
      return yield* SynchronizedRef.modifyEffect(state, updateState)
    })

    const removeExpired = Effect.fn('MessageArchiveTestStorage.removeExpired')(function* (
      instanceId: MessageArchiveEvent.InstanceId,
      cutoff: MessageArchiveEvent.Timestamp,
    ) {
      return yield* SynchronizedRef.modify(state, (messages) => {
        const retained = messages.filter(
          (message) => message.instanceId !== instanceId || message.timestamp >= cutoff,
        )
        return [messages.length - retained.length, retained] as const
      })
    })

    const all = Effect.fn('MessageArchiveTestStorage.all')(function* () {
      return yield* SynchronizedRef.get(state)
    })

    const service = TestStorage.of({ store, latest, versions, removeExpired, all })
    return Context.empty().pipe(
      Context.add(MessageArchiveStorage.Service, service),
      Context.add(TestStorage, service),
    )
  }),
)

const INSTANCE_ID = MessageArchiveEvent.InstanceId.make('primary')
const OTHER_INSTANCE_ID = MessageArchiveEvent.InstanceId.make('secondary')
const MESSAGE_ID = MessageArchiveEvent.MessageId.make('message-1')
const SELF_ID = MessageArchiveEvent.ActorId.make('bot')
const USER_ID = MessageArchiveEvent.ActorId.make('user')

const scope = (
  instanceId = INSTANCE_ID,
  platform = 'test',
  guildId = 'guild',
  channelId = 'channel',
): MessageArchiveEvent.ChannelScope =>
  MessageArchiveEvent.ChannelScope.make({
    instanceId,
    platform: MessageArchiveEvent.PlatformId.make(platform),
    guildId: MessageArchiveEvent.GuildId.make(guildId),
    channelId: MessageArchiveEvent.ChannelId.make(channelId),
  })

const created = (
  channelScope: MessageArchiveEvent.ChannelScope,
  content: string,
  timestamp = 0,
  isSelf = false,
): MessageArchiveEvent.NormalizedEvent =>
  MessageArchiveEvent.NormalizedEvent.cases.MessageCreated.make({
    ...channelScope,
    messageId: MESSAGE_ID,
    authorId: isSelf ? SELF_ID : USER_ID,
    selfId: SELF_ID,
    timestamp: MessageArchiveEvent.Timestamp.make(timestamp),
    content,
    isSelf,
  })

const updated = (
  channelScope: MessageArchiveEvent.ChannelScope,
  content: string,
  timestamp: number,
): MessageArchiveEvent.NormalizedEvent =>
  MessageArchiveEvent.NormalizedEvent.cases.MessageUpdated.make({
    ...channelScope,
    messageId: MESSAGE_ID,
    authorId: USER_ID,
    selfId: SELF_ID,
    timestamp: MessageArchiveEvent.Timestamp.make(timestamp),
    content,
    isSelf: false,
  })

const archiveLayer = (retentionDays: number) =>
  MessageArchive.layer({
    instanceId: INSTANCE_ID,
    retentionDays: MessageArchiveEvent.RetentionDays.make(retentionDays),
    cleanupInterval: MessageArchive.DEFAULT_CLEANUP_INTERVAL,
  }).pipe(Layer.provideMerge(testStorageLayer))

it.effect('replays a message ID idempotently and appends linked edit versions', () =>
  Effect.gen(function* () {
    const archive = yield* MessageArchive.Service
    const channelScope = scope()

    const first = yield* archive.record(created(channelScope, 'original', 1_000))
    const replay = yield* archive.record(created(channelScope, 'different replay', 2_000))
    const edit = yield* archive.record(updated(channelScope, 'edited', 3_000))
    const editReplay = yield* archive.record(updated(channelScope, 'edited', 4_000))
    const versions = yield* archive.versions(channelScope, MESSAGE_ID)
    const latest = yield* archive.latest(channelScope, MESSAGE_ID)

    expect(first._tag).toBe('Stored')
    expect(replay._tag).toBe('Replay')
    expect(edit._tag).toBe('Stored')
    expect(editReplay._tag).toBe('Replay')
    expect(versions).toHaveLength(2)
    expect(versions.map((message) => message.content)).toEqual(['original', 'edited'])
    const edited = versions[1]
    if (edited === undefined) return yield* Effect.die('Expected an edited version')
    expect(Option.getOrUndefined(edited.sourceVersion)).toBe(1)
    expect(Option.getOrUndefined(edited.previousVersion)).toBe(1)
    if (Option.isNone(latest)) return yield* Effect.die('Expected a latest message')
    expect(latest.value.content).toBe('edited')
  }).pipe(Effect.provide(archiveLayer(MessageArchive.DEFAULT_RETENTION_DAYS))),
)

it.effect('isolates every instance, platform, guild, and channel dimension', () =>
  Effect.gen(function* () {
    const archive = yield* MessageArchive.Service
    const scopes = [
      scope(INSTANCE_ID, 'one', 'guild', 'channel'),
      scope(INSTANCE_ID, 'two', 'guild', 'channel'),
      scope(INSTANCE_ID, 'one', 'other-guild', 'channel'),
      scope(INSTANCE_ID, 'one', 'guild', 'other-channel'),
    ]

    yield* Effect.forEach(
      scopes,
      (channelScope, index) => archive.record(created(channelScope, `scope-${index}`)),
      { discard: true },
    )

    const contents = yield* Effect.forEach(scopes, (channelScope) =>
      archive
        .latest(channelScope, MESSAGE_ID)
        .pipe(Effect.map((message) => Option.map(message, (value) => value.content))),
    )
    expect(contents.map(Option.getOrUndefined)).toEqual([
      'scope-0',
      'scope-1',
      'scope-2',
      'scope-3',
    ])

    yield* archive.latest(scope(OTHER_INSTANCE_ID), MESSAGE_ID).pipe(
      Effect.flip,
      Effect.map((error) => expect(error._tag).toBe('MessageArchiveInstanceScopeMismatchError')),
    )
  }).pipe(Effect.provide(archiveLayer(MessageArchive.DEFAULT_RETENTION_DAYS))),
)

it.effect('marks self messages as ineligible for activity', () =>
  Effect.gen(function* () {
    const archive = yield* MessageArchive.Service
    const result = yield* archive.record(created(scope(), 'self message', 0, true))

    expect(result.message.isSelf).toBe(true)
    expect(MessageArchiveEvent.contributesToActivity(result.message)).toBe(false)
  }).pipe(Effect.provide(archiveLayer(MessageArchive.DEFAULT_RETENTION_DAYS))),
)

const retentionBoundaryTest = (retentionDays: number) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const archive = yield* MessageArchive.Service
    const storage = yield* TestStorage
    yield* archive.record(created(scope(), 'retained at boundary'))

    yield* TestClock.adjust(Duration.days(retentionDays))
    expect(yield* storage.all()).toHaveLength(1)

    yield* TestClock.adjust(MessageArchive.DEFAULT_CLEANUP_INTERVAL)
    expect(yield* storage.all()).toHaveLength(0)
  }).pipe(Effect.provide(archiveLayer(retentionDays)))

it.effect('keeps the default 90-day retention boundary and removes older messages', () =>
  retentionBoundaryTest(MessageArchive.DEFAULT_RETENTION_DAYS),
)

it.effect('honors a custom retention boundary with TestClock', () => retentionBoundaryTest(7))
