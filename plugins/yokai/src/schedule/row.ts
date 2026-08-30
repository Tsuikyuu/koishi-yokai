import { ScheduledTaskModel } from '@yokai-internal/core'
import { Effect, Schema } from 'effect'

import type { YokaiScheduleRow } from './model'

const decodeTask = Schema.decodeUnknownEffect(ScheduledTaskModel.Task)
const encodeTask = Schema.encodeEffect(ScheduledTaskModel.Task)

export const decode = Effect.fn('KoishiScheduleRow.decode')(function* (row: YokaiScheduleRow) {
  return yield* decodeTask({
    instanceId: row.instanceId,
    platform: row.platform,
    guildId: row.guildId,
    channelId: row.channelId,
    scheduleId: row.scheduleId,
    dedupeKey: row.dedupeKey,
    creationFingerprint: row.creationFingerprint,
    createdMessageId: row.createdMessageId,
    creatorId: row.creatorId,
    selfId: row.selfId,
    reason: row.reason,
    dueAt: row.dueAt.getTime(),
    repeatEveryMs: row.repeatEveryMs,
    timeZone: row.timeZone,
    status: row.status,
    occurrence: row.occurrence,
    revision: row.revision,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    lastTriggeredAt: row.lastTriggeredAt === null ? null : row.lastTriggeredAt.getTime(),
  })
})

export const encode = Effect.fn('KoishiScheduleRow.encode')(function* (
  task: ScheduledTaskModel.Task,
) {
  const encoded = yield* encodeTask(task)
  return {
    instanceId: encoded.instanceId,
    platform: encoded.platform,
    guildId: encoded.guildId,
    channelId: encoded.channelId,
    scheduleId: encoded.scheduleId,
    dedupeKey: encoded.dedupeKey,
    creationFingerprint: encoded.creationFingerprint,
    createdMessageId: encoded.createdMessageId,
    creatorId: encoded.creatorId,
    selfId: encoded.selfId,
    reason: encoded.reason,
    dueAt: new Date(encoded.dueAt),
    repeatEveryMs: encoded.repeatEveryMs,
    timeZone: encoded.timeZone,
    status: encoded.status,
    occurrence: encoded.occurrence,
    revision: encoded.revision,
    createdAt: new Date(encoded.createdAt),
    updatedAt: new Date(encoded.updatedAt),
    lastTriggeredAt: encoded.lastTriggeredAt === null ? null : new Date(encoded.lastTriggeredAt),
  } satisfies YokaiScheduleRow
})

export * as YokaiScheduleRowCodec from './row'
