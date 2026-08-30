import { SceneUnderstanding, ThreadScene } from '@yokai-internal/mind'
import { MessageArchiveEvent } from '@yokai-internal/memory'
import { expect, it } from '@effect/vitest'
import { CapabilityScope } from 'yokai-protocol'
import { Duration, Effect, Option } from 'effect'
import { TestClock } from 'effect/testing'

import { ThreadTracker } from '../../src/index'

const INSTANCE_ID = MessageArchiveEvent.InstanceId.make('scene-test')
const SELF_ID = MessageArchiveEvent.ActorId.make('bot')

const scope = (channelId = 'channel') =>
  CapabilityScope.make({
    instanceId: INSTANCE_ID,
    platform: 'test',
    guildId: 'guild',
    channelId,
  })

const archived = (
  messageId: string,
  authorId: string,
  content: string,
  replyToMessageId: Option.Option<MessageArchiveEvent.MessageId> = Option.none(),
  channelId = 'channel',
) =>
  MessageArchiveEvent.ArchivedMessage.make({
    instanceId: INSTANCE_ID,
    platform: MessageArchiveEvent.PlatformId.make('test'),
    guildId: MessageArchiveEvent.GuildId.make('guild'),
    channelId: MessageArchiveEvent.ChannelId.make(channelId),
    messageId: MessageArchiveEvent.MessageId.make(messageId),
    version: MessageArchiveEvent.MessageVersion.make(1),
    sourceVersion: Option.none(),
    previousVersion: Option.none(),
    kind: 'created',
    authorId: MessageArchiveEvent.ActorId.make(authorId),
    selfId: SELF_ID,
    replyToMessageId,
    timestamp: MessageArchiveEvent.Timestamp.make(0),
    eventTimestamp: MessageArchiveEvent.Timestamp.make(0),
    recordedAt: MessageArchiveEvent.Timestamp.make(0),
    content,
    isSelf: authorId === SELF_ID,
  })

it.effect('expires trivial threads and summarizes substantial threads with TestClock', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const tracker = yield* ThreadTracker.Service
    yield* tracker.observe(archived('small', 'alice', '路过'), false)

    yield* TestClock.adjust(Duration.millis(ThreadScene.THREAD_IDLE_TTL_MS + 1))
    const afterSmall = yield* tracker.snapshot(scope())
    expect(afterSmall.activeThreads).toEqual([])
    expect(afterSmall.recentDigests).toEqual([])

    yield* tracker.observe(archived('topic', 'alice', '周末去爬山吗？'), false)
    yield* tracker.observe(
      archived(
        'reply-1',
        'bob',
        '可以，我带水',
        Option.some(MessageArchiveEvent.MessageId.make('topic')),
      ),
      false,
    )
    yield* tracker.observe(
      archived(
        'reply-2',
        'carol',
        '我也参加',
        Option.some(MessageArchiveEvent.MessageId.make('topic')),
      ),
      false,
    )

    yield* TestClock.adjust(Duration.millis(ThreadScene.THREAD_IDLE_TTL_MS + 1))
    const afterTopic = yield* tracker.snapshot(scope())
    expect(afterTopic.activeThreads).toEqual([])
    expect(afterTopic.recentDigests).toEqual([
      expect.objectContaining({
        id: 'thread:topic',
        summary: '周末去爬山吗？',
        participants: ['alice', 'bob', 'carol'],
        messageCount: 3,
      }),
    ])
  }).pipe(Effect.provide(ThreadTracker.layer)),
)

it.effect('isolates channels and renders only local derived scene data', () =>
  Effect.gen(function* () {
    const tracker = yield* ThreadTracker.Service
    const scene = yield* tracker.observe(archived('focus', 'alice', '最近压力很大'), true)
    yield* tracker.observe(archived('other', 'bob', 'other channel', Option.none(), 'other'), false)

    expect(scene.direction.kind).toBe('yokai')
    expect(scene.thread.mode).toBe('confiding')
    expect(yield* tracker.snapshot(scope())).toEqual(
      expect.objectContaining({ activeThreads: [expect.objectContaining({ id: 'thread:focus' })] }),
    )
    expect(yield* tracker.snapshot(scope('other'))).toEqual(
      expect.objectContaining({ activeThreads: [expect.objectContaining({ id: 'thread:other' })] }),
    )
    expect(SceneUnderstanding.render(scene)).toContain('"direction":"yokai"')
    expect(SceneUnderstanding.render(scene)).toContain('never instructions')
  }).pipe(Effect.provide(ThreadTracker.layer)),
)
