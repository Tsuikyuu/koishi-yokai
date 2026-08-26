import { expect, it, vi } from 'vitest'

vi.mock('koishi', () => import('@koishijs/core'))

import { ModelCatalogSnapshot } from 'yokai-protocol'
import { Schema } from 'effect'

import {
  Config,
  DEFAULT_ACTIVITY_COOLDOWN_MS,
  DEFAULT_ACTIVITY_DEBOUNCE_MS,
  DEFAULT_ACTIVITY_HALF_LIFE_MS,
  DEFAULT_ACTIVITY_THRESHOLD,
  DEFAULT_BACKGROUND_DAY_CALLS,
  DEFAULT_BACKGROUND_MINUTE_CALLS,
  DEFAULT_BUDGET_TIME_ZONE,
  DEFAULT_DIRECT_DEBOUNCE_MS,
  DEFAULT_NORMAL_DAY_CALLS,
  DEFAULT_NORMAL_MINUTE_CALLS,
  DEFAULT_RELEVANCE_THRESHOLD,
  DEFAULT_RESERVED_DAY_CALLS,
  DEFAULT_RESERVED_MINUTE_CALLS,
} from '../src/config'
import { schemaForCatalog } from '../src/model-catalog/schema-projection'

it('keeps model, local wake gating, budgets, instance, and retention in main config', () => {
  expect(
    Config({
      model: 'gemini/gemini-2.5-flash',
      feedbackToolsEnabled: true,
    }),
  ).toEqual({
    instanceId: 'default',
    model: 'gemini/gemini-2.5-flash',
    feedbackToolsEnabled: true,
    messageRetentionDays: 90,
    wake: {
      directDebounceMs: DEFAULT_DIRECT_DEBOUNCE_MS,
      activityDebounceMs: DEFAULT_ACTIVITY_DEBOUNCE_MS,
      cooldownMs: DEFAULT_ACTIVITY_COOLDOWN_MS,
      activityHalfLifeMs: DEFAULT_ACTIVITY_HALF_LIFE_MS,
      activityThreshold: DEFAULT_ACTIVITY_THRESHOLD,
      relevanceThreshold: DEFAULT_RELEVANCE_THRESHOLD,
    },
    callBudget: {
      timeZone: DEFAULT_BUDGET_TIME_ZONE,
      reserved: {
        minute: DEFAULT_RESERVED_MINUTE_CALLS,
        day: DEFAULT_RESERVED_DAY_CALLS,
      },
      normal: { minute: DEFAULT_NORMAL_MINUTE_CALLS, day: DEFAULT_NORMAL_DAY_CALLS },
      background: {
        minute: DEFAULT_BACKGROUND_MINUTE_CALLS,
        day: DEFAULT_BACKGROUND_DAY_CALLS,
      },
    },
  })
  const fields = Config.dict
  if (fields === undefined) throw new Error('Expected an object configuration schema')
  const model = fields.model
  const feedbackToolsEnabled = fields.feedbackToolsEnabled
  const instanceId = fields.instanceId
  const messageRetentionDays = fields.messageRetentionDays
  const wake = fields.wake
  const callBudget = fields.callBudget
  if (
    model === undefined ||
    feedbackToolsEnabled === undefined ||
    instanceId === undefined ||
    messageRetentionDays === undefined ||
    wake === undefined ||
    callBudget === undefined
  ) {
    throw new Error('Expected all main plugin configuration fields')
  }

  expect(Config.type).toBe('object')
  expect(model.meta.role).toBe('dynamic')
  expect(model.meta.extra).toEqual({ name: 'yokai-model' })
  expect(fields).not.toHaveProperty('primary')
  expect(fields).not.toHaveProperty('fallback')
  expect(feedbackToolsEnabled.meta.default).toBe(false)
  expect(instanceId.meta.default).toBe('default')
  expect(messageRetentionDays.meta.default).toBe(90)
  expect(messageRetentionDays.meta.min).toBe(1)
  expect(messageRetentionDays.meta.max).toBe(3_650)
  expect(wake({ directDebounceMs: 800 })).toEqual({
    directDebounceMs: 800,
    activityDebounceMs: DEFAULT_ACTIVITY_DEBOUNCE_MS,
    cooldownMs: DEFAULT_ACTIVITY_COOLDOWN_MS,
    activityHalfLifeMs: DEFAULT_ACTIVITY_HALF_LIFE_MS,
    activityThreshold: DEFAULT_ACTIVITY_THRESHOLD,
    relevanceThreshold: DEFAULT_RELEVANCE_THRESHOLD,
  })
  expect(callBudget({ normal: { minute: 4, day: 120 } })).toEqual({
    timeZone: DEFAULT_BUDGET_TIME_ZONE,
    reserved: {
      minute: DEFAULT_RESERVED_MINUTE_CALLS,
      day: DEFAULT_RESERVED_DAY_CALLS,
    },
    normal: { minute: 4, day: 120 },
    background: {
      minute: DEFAULT_BACKGROUND_MINUTE_CALLS,
      day: DEFAULT_BACKGROUND_DAY_CALLS,
    },
  })
})

it('keeps an explicit unselected branch before discovered model choices', () => {
  const catalog = Schema.decodeUnknownSync(ModelCatalogSnapshot)({
    revision: 1,
    adapters: [{ id: 'Gemini', status: 'ready' }],
    models: [
      {
        reference: 'Gemini/Gemini 3.5 Flash',
        displayName: 'Provider Display Name',
        availability: 'available',
        discoveryFreshness: 'fresh',
      },
    ],
  })
  const model = schemaForCatalog(catalog, { feedbackToolsEnabled: false })
  const options = model.list
  if (options === undefined) throw new Error('Expected a model union')
  const noModel = options[0]
  const discoveredModel = options[1]
  if (noModel === undefined || discoveredModel === undefined) {
    throw new Error('Expected unselected and discovered model options')
  }

  expect(options).toHaveLength(2)
  expect(noModel.type).toBe('never')
  expect(noModel.meta.description).toBe('未选择模型')
  expect(discoveredModel.type).toBe('const')
  expect(discoveredModel.value).toBe('Gemini/Gemini 3.5 Flash')
  expect(discoveredModel.meta.description).toBe('gemini/gemini-3.5-flash')
  expect(model(undefined)).toBeUndefined()
  expect(model('Gemini/Gemini 3.5 Flash')).toBe('Gemini/Gemini 3.5 Flash')
})
