import { expect, it } from '@effect/vitest'
import { ScheduledTaskModel } from '@yokai-internal/core'
import { MessageArchiveEvent } from '@yokai-internal/memory'
import { Effect, Option } from 'effect'

import { YokaiScheduleRowCodec } from '../../src/schedule/row'

const task = ScheduledTaskModel.Task.make({
  instanceId: MessageArchiveEvent.InstanceId.make('schedule-row-test'),
  platform: MessageArchiveEvent.PlatformId.make('test'),
  guildId: MessageArchiveEvent.GuildId.make('guild'),
  channelId: MessageArchiveEvent.ChannelId.make('channel'),
  scheduleId: ScheduledTaskModel.ScheduleId.make(`schedule_${'a'.repeat(32)}`),
  dedupeKey: ScheduledTaskModel.DedupeKey.make('morning-class'),
  creationFingerprint: ScheduledTaskModel.CreationFingerprint.make('b'.repeat(64)),
  createdMessageId: MessageArchiveEvent.MessageId.make('message'),
  creatorId: MessageArchiveEvent.ActorId.make('user'),
  selfId: MessageArchiveEvent.ActorId.make('bot'),
  reason: ScheduledTaskModel.Reason.make('Attend class'),
  dueAt: ScheduledTaskModel.EpochMilliseconds.make(10_000),
  repeatEveryMs: Option.some(ScheduledTaskModel.RepeatEveryMilliseconds.make(60_000)),
  timeZone: ScheduledTaskModel.TimeZoneId.make('Asia/Shanghai'),
  status: 'pending',
  occurrence: ScheduledTaskModel.Occurrence.make(0),
  revision: ScheduledTaskModel.Revision.make(1),
  createdAt: ScheduledTaskModel.EpochMilliseconds.make(1_000),
  updatedAt: ScheduledTaskModel.EpochMilliseconds.make(2_000),
  lastTriggeredAt: Option.none(),
})

it.effect('round-trips every scheduled task field through the Koishi row codec', () =>
  Effect.gen(function* () {
    const row = yield* YokaiScheduleRowCodec.encode(task)
    expect(row.dueAt).toEqual(new Date(10_000))
    expect(row.repeatEveryMs).toBe(60_000)
    expect(row.lastTriggeredAt).toBeNull()
    expect(yield* YokaiScheduleRowCodec.decode(row)).toEqual(task)
  }),
)

it.effect('rejects malformed persisted scalar fields through the task schema', () =>
  Effect.gen(function* () {
    const row = yield* YokaiScheduleRowCodec.encode(task)
    const error = yield* YokaiScheduleRowCodec.decode({ ...row, revision: 0 }).pipe(Effect.flip)
    expect(error).toMatchObject({ _tag: 'SchemaError' })
  }),
)
