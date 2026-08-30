import { createHash } from 'node:crypto'

import { Option } from 'effect'

import type { MessageArchiveEvent } from '@yokai-internal/memory'
import {
  CreationFingerprint,
  type DedupeKey,
  type Reason,
  type RepeatEveryMilliseconds,
  ScheduleId,
  type TimeExpression,
  type TimeZoneId,
} from './model'

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

const scopeTuple = (scope: MessageArchiveEvent.ChannelScope): ReadonlyArray<string> => [
  scope.instanceId,
  scope.platform,
  scope.guildId,
  scope.channelId,
]

export const stableId = (
  scope: MessageArchiveEvent.ChannelScope,
  dedupeKey: DedupeKey,
): ScheduleId => {
  const canonical = JSON.stringify({ scope: scopeTuple(scope), dedupeKey })
  return ScheduleId.make(`schedule_${digest(canonical).slice(0, 32)}`)
}

export interface CreationPayload {
  readonly sourceMessageId: MessageArchiveEvent.MessageId
  readonly creatorId: MessageArchiveEvent.ActorId
  readonly selfId: MessageArchiveEvent.ActorId
  readonly reason: Reason
  readonly time: TimeExpression
  readonly repeatEveryMs: Option.Option<RepeatEveryMilliseconds>
  readonly timeZone: TimeZoneId
}

export const creationFingerprint = (
  scope: MessageArchiveEvent.ChannelScope,
  dedupeKey: DedupeKey,
  payload: CreationPayload,
): CreationFingerprint => {
  const canonical = JSON.stringify({
    scope: scopeTuple(scope),
    dedupeKey,
    sourceMessageId: payload.sourceMessageId,
    creatorId: payload.creatorId,
    selfId: payload.selfId,
    reason: payload.reason,
    time: payload.time,
    repeatEveryMs: Option.getOrNull(payload.repeatEveryMs),
    timeZone: payload.timeZone,
  })
  return CreationFingerprint.make(digest(canonical))
}

export * as ScheduledTaskIdentity from './identity'
