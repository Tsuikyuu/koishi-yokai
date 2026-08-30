import { expect, it, vi } from 'vitest'
import { Context } from 'koishi'

vi.mock('koishi', () => import('@koishijs/core'))

import { YokaiRoleStateModel } from '../../src/role-state/index'

it('defines channel and member state with complete scope primary keys', () => {
  const ctx = new Context()
  YokaiRoleStateModel.define(ctx)

  const channel = ctx.model.tables.yokai_channel_state
  const member = ctx.model.tables.yokai_member_state
  if (channel === undefined || member === undefined) {
    throw new Error('Expected Yokai role-state models')
  }

  expect(channel.primary).toEqual(['instanceId', 'platform', 'guildId', 'channelId'])
  expect(member.primary).toEqual(['instanceId', 'platform', 'guildId', 'channelId', 'memberId'])
  expect(Object.keys(channel.fields)).toEqual([
    'instanceId',
    'platform',
    'guildId',
    'channelId',
    'payload',
    'updatedAt',
  ])
  expect(Object.keys(member.fields)).toEqual([
    'instanceId',
    'platform',
    'guildId',
    'channelId',
    'memberId',
    'payload',
    'updatedAt',
  ])
})
