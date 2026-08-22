import { expect, it, vi } from 'vitest'

vi.mock('koishi', () => import('@koishijs/core'))

import { Config } from '../src/config'

it('keeps model selection and feedback policy in the main plugin config', () => {
  expect(
    Config({
      primary: 'gemini/gemini-2.5-flash',
      fallback: ['local/qwen', 'gemini/gemini-2.5-pro'],
      feedbackToolsEnabled: true,
    }),
  ).toEqual({
    primary: 'gemini/gemini-2.5-flash',
    fallback: ['local/qwen', 'gemini/gemini-2.5-pro'],
    feedbackToolsEnabled: true,
  })
  const fields = Config.dict
  if (fields === undefined) throw new Error('Expected an object configuration schema')
  const primary = fields.primary
  const fallback = fields.fallback
  const feedbackToolsEnabled = fields.feedbackToolsEnabled
  if (primary === undefined || fallback === undefined || feedbackToolsEnabled === undefined) {
    throw new Error('Expected all main plugin configuration fields')
  }
  const fallbackItem = fallback.inner
  if (fallbackItem === undefined) throw new Error('Expected the fallback item schema')

  expect(Config.type).toBe('object')
  expect(primary.meta.role).toBe('dynamic')
  expect(primary.meta.extra).toEqual({ name: 'yokai-model' })
  expect(fallback.meta.default).toEqual([])
  expect(fallbackItem.meta.role).toBe('dynamic')
  expect(fallbackItem.meta.extra).toEqual({ name: 'yokai-model' })
  expect(feedbackToolsEnabled.meta.default).toBe(false)
})
