import { expect, it, vi } from 'vitest'
import { Context } from 'koishi'

vi.mock('koishi', () => import('@koishijs/core'))

import { YokaiNotebookModel } from '../../src/notebook/index'

it('defines notebook memory with a complete scope primary key and recall indexes', () => {
  const ctx = new Context()
  YokaiNotebookModel.define(ctx)

  const memory = ctx.model.tables.yokai_memory
  if (memory === undefined) throw new Error('Expected the Yokai memory model')

  expect(memory.primary).toEqual(['instanceId', 'platform', 'guildId', 'channelId', 'noteId'])
  expect(Object.keys(memory.fields)).toEqual([
    'instanceId',
    'platform',
    'guildId',
    'channelId',
    'noteId',
    'kind',
    'objectId',
    'content',
    'topicsJson',
    'sourceMessageIdsJson',
    'confidence',
    'importance',
    'createdAt',
    'expiresAt',
    'correctsNoteId',
    'supersededByNoteId',
  ])
  expect(memory.indexes.map((index) => Object.keys(index.keys))).toEqual([
    [
      'instanceId',
      'platform',
      'guildId',
      'channelId',
      'supersededByNoteId',
      'expiresAt',
      'confidence',
      'importance',
      'createdAt',
      'noteId',
    ],
    ['instanceId', 'platform', 'guildId', 'channelId', 'objectId', 'createdAt', 'noteId'],
  ])
})
