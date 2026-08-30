import { expect, it, vi } from 'vitest'
import { Context } from 'koishi'

vi.mock('koishi', () => import('@koishijs/core'))

import { YokaiScheduleModel } from '../../src/schedule/model'

it('defines persistent schedules with a complete scope primary key and due-time indexes', () => {
  const ctx = new Context()
  YokaiScheduleModel.define(ctx)

  const schedule = ctx.model.tables.yokai_schedule
  if (schedule === undefined) throw new Error('Expected the Yokai schedule model')

  expect(schedule.primary).toEqual(['instanceId', 'platform', 'guildId', 'channelId', 'scheduleId'])
  expect(Object.keys(schedule.fields)).toEqual([
    'instanceId',
    'platform',
    'guildId',
    'channelId',
    'scheduleId',
    'dedupeKey',
    'creationFingerprint',
    'createdMessageId',
    'creatorId',
    'selfId',
    'reason',
    'dueAt',
    'repeatEveryMs',
    'timeZone',
    'status',
    'occurrence',
    'revision',
    'createdAt',
    'updatedAt',
    'lastTriggeredAt',
  ])
  expect(schedule.indexes.map((index) => Object.keys(index.keys))).toEqual([
    ['instanceId', 'status', 'dueAt', 'scheduleId'],
    ['instanceId', 'platform', 'guildId', 'channelId', 'status', 'dueAt', 'scheduleId'],
  ])
  expect(schedule.fields.repeatEveryMs).toMatchObject({ deftype: 'unsigned', length: 8 })
  expect(schedule.fields.occurrence).toMatchObject({ deftype: 'unsigned', length: 8 })
  expect(schedule.fields.revision).toMatchObject({ deftype: 'unsigned', length: 8 })
})
