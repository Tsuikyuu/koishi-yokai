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
  DEFAULT_VISIBLE_ACTION_TOOLS,
  DEFAULT_VISIBLE_FEEDBACK_TOOLS,
  DEFAULT_VISIBLE_MCP_SERVERS,
  DEFAULT_VISIBLE_SKILLS,
  DEFAULT_HARD_REPLY_AT_MENTION,
  DEFAULT_HARD_REPLY_ON_REPLY_TO_SELF,
  DEFAULT_HARD_REPLY_ROLE_NAME_CONTAINS,
  DEFAULT_HARD_REPLY_ROLE_NAME_PREFIX,
  DEFAULT_INITIATIVE_CHANNEL_COOLDOWN_MS,
  DEFAULT_INITIATIVE_ENABLED,
  DEFAULT_INITIATIVE_INTRINSIC_INTERVAL_MS,
  DEFAULT_INITIATIVE_MAX_RECENT_PARTICIPATION,
  DEFAULT_INITIATIVE_MIN_SOCIAL_ENERGY,
  DEFAULT_INITIATIVE_QUIET_PERIOD_MS,
  DEFAULT_INITIATIVE_RECENT_RELEVANCE_THRESHOLD,
  DEFAULT_INITIATIVE_RECENT_WINDOW_MS,
  DEFAULT_INITIATIVE_RELATIONSHIP_THRESHOLD,
  DEFAULT_ENGAGEMENT_ENABLED,
  DEFAULT_ENGAGEMENT_IDLE_TTL_MS,
  DEFAULT_ENGAGEMENT_MAX_DURATION_MS,
  DEFAULT_ENGAGEMENT_MAX_ROUNDS,
  DEFAULT_NOTEBOOK_EXPIRATION_DAYS,
  DEFAULT_NOTEBOOK_MAX_NOTES_PER_REPLY,
  DEFAULT_NOTEBOOK_RECALL_LIMIT,
  DEFAULT_NORMAL_DAY_CALLS,
  DEFAULT_NORMAL_MINUTE_CALLS,
  DEFAULT_PRESET_RELOAD_DEBOUNCE_MS,
  DEFAULT_RELEVANCE_THRESHOLD,
  DEFAULT_RESERVED_DAY_CALLS,
  DEFAULT_RESERVED_MINUTE_CALLS,
  DEFAULT_SCHEDULE_CONTEXT_LIMIT,
  DEFAULT_SCHEDULE_ENABLED,
  DEFAULT_SCHEDULE_GRACE_PERIOD_MS,
  DEFAULT_SCHEDULE_TIME_ZONE,
  DEFAULT_STATE_ENERGY_RECOVERY_HALF_LIFE_MS,
  DEFAULT_STATE_MAX_INTERACTION_DELTA,
  DEFAULT_STATE_MOOD_HALF_LIFE_MS,
  DEFAULT_STATE_PARTICIPATION_HALF_LIFE_MS,
  MAX_STATE_HALF_LIFE_MS,
  MAX_CONFIGURED_CAPABILITIES_PER_DOMAIN,
  resolveHardReplyPolicy,
} from '../src/config'
import { schemaForCatalog } from '../src/model-catalog/schema-projection'

it('keeps model, wake gating, engagement, initiative, schedules, budgets, storage, and notebook in main config', () => {
  expect(
    Config({
      model: 'gemini/gemini-2.5-flash',
      feedbackToolsEnabled: true,
    }),
  ).toEqual({
    instanceId: 'default',
    model: 'gemini/gemini-2.5-flash',
    feedbackToolsEnabled: true,
    capabilities: {
      skills: DEFAULT_VISIBLE_SKILLS,
      actionTools: DEFAULT_VISIBLE_ACTION_TOOLS,
      feedbackTools: DEFAULT_VISIBLE_FEEDBACK_TOOLS,
      mcpServers: DEFAULT_VISIBLE_MCP_SERVERS,
    },
    messageRetentionDays: 90,
    engagement: {
      enabled: DEFAULT_ENGAGEMENT_ENABLED,
      idleTtlMs: DEFAULT_ENGAGEMENT_IDLE_TTL_MS,
      maxDurationMs: DEFAULT_ENGAGEMENT_MAX_DURATION_MS,
      maxRounds: DEFAULT_ENGAGEMENT_MAX_ROUNDS,
    },
    initiative: {
      enabled: DEFAULT_INITIATIVE_ENABLED,
      quietPeriodMs: DEFAULT_INITIATIVE_QUIET_PERIOD_MS,
      channelCooldownMs: DEFAULT_INITIATIVE_CHANNEL_COOLDOWN_MS,
      intrinsicIntervalMs: DEFAULT_INITIATIVE_INTRINSIC_INTERVAL_MS,
      recentWindowMs: DEFAULT_INITIATIVE_RECENT_WINDOW_MS,
      recentRelevanceThreshold: DEFAULT_INITIATIVE_RECENT_RELEVANCE_THRESHOLD,
      relationshipThreshold: DEFAULT_INITIATIVE_RELATIONSHIP_THRESHOLD,
      minSocialEnergy: DEFAULT_INITIATIVE_MIN_SOCIAL_ENERGY,
      maxRecentParticipation: DEFAULT_INITIATIVE_MAX_RECENT_PARTICIPATION,
    },
    notebook: {
      maxNotesPerReply: DEFAULT_NOTEBOOK_MAX_NOTES_PER_REPLY,
      recallLimit: DEFAULT_NOTEBOOK_RECALL_LIMIT,
      defaultExpirationDays: DEFAULT_NOTEBOOK_EXPIRATION_DAYS,
    },
    schedule: {
      enabled: DEFAULT_SCHEDULE_ENABLED,
      timeZone: DEFAULT_SCHEDULE_TIME_ZONE,
      gracePeriodMs: DEFAULT_SCHEDULE_GRACE_PERIOD_MS,
      contextLimit: DEFAULT_SCHEDULE_CONTEXT_LIMIT,
    },
    presetReloadDebounceMs: DEFAULT_PRESET_RELOAD_DEBOUNCE_MS,
    state: {
      maxInteractionDelta: DEFAULT_STATE_MAX_INTERACTION_DELTA,
      moodHalfLifeMs: DEFAULT_STATE_MOOD_HALF_LIFE_MS,
      participationHalfLifeMs: DEFAULT_STATE_PARTICIPATION_HALF_LIFE_MS,
      energyRecoveryHalfLifeMs: DEFAULT_STATE_ENERGY_RECOVERY_HALF_LIFE_MS,
    },
    wake: {
      directDebounceMs: DEFAULT_DIRECT_DEBOUNCE_MS,
      hardReplyAtMention: DEFAULT_HARD_REPLY_AT_MENTION,
      hardReplyOnReplyToSelf: DEFAULT_HARD_REPLY_ON_REPLY_TO_SELF,
      hardReplyRoleNamePrefix: DEFAULT_HARD_REPLY_ROLE_NAME_PREFIX,
      hardReplyRoleNameContains: DEFAULT_HARD_REPLY_ROLE_NAME_CONTAINS,
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
  const capabilities = fields.capabilities
  const instanceId = fields.instanceId
  const messageRetentionDays = fields.messageRetentionDays
  const engagement = fields.engagement
  const initiative = fields.initiative
  const notebook = fields.notebook
  const schedule = fields.schedule
  const presetId = fields.presetId
  const presetDirectory = fields.presetDirectory
  const presetReloadDebounceMs = fields.presetReloadDebounceMs
  const state = fields.state
  const wake = fields.wake
  const callBudget = fields.callBudget
  if (
    model === undefined ||
    feedbackToolsEnabled === undefined ||
    capabilities === undefined ||
    instanceId === undefined ||
    messageRetentionDays === undefined ||
    engagement === undefined ||
    initiative === undefined ||
    notebook === undefined ||
    schedule === undefined ||
    presetId === undefined ||
    presetDirectory === undefined ||
    presetReloadDebounceMs === undefined ||
    state === undefined ||
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
  expect(capabilities({ actionTools: ['reaction.add'], mcpServers: ['tools'] })).toEqual({
    skills: DEFAULT_VISIBLE_SKILLS,
    actionTools: ['reaction.add'],
    feedbackTools: DEFAULT_VISIBLE_FEEDBACK_TOOLS,
    mcpServers: ['tools'],
  })
  const capabilityFields = capabilities.dict
  if (capabilityFields === undefined) {
    throw new Error('Expected a capability visibility configuration schema')
  }
  const skillAllowlist = capabilityFields.skills
  const actionToolAllowlist = capabilityFields.actionTools
  const feedbackToolAllowlist = capabilityFields.feedbackTools
  const mcpServerAllowlist = capabilityFields.mcpServers
  if (
    skillAllowlist === undefined ||
    actionToolAllowlist === undefined ||
    feedbackToolAllowlist === undefined ||
    mcpServerAllowlist === undefined
  ) {
    throw new Error('Expected all capability visibility allowlists')
  }
  expect(() => capabilities({ skills: ['duplicate', 'duplicate'] })).toThrow()
  expect(() => capabilities({ actionTools: ['contains/slash'] })).toThrow()
  expect(() =>
    capabilities({
      feedbackTools: Array.from(
        { length: MAX_CONFIGURED_CAPABILITIES_PER_DOMAIN + 1 },
        (_, index) => `tool.${String(index)}`,
      ),
    }),
  ).toThrow()
  expect(() => capabilities({ mcpServers: ['valid.server', 'other_server-2'] })).not.toThrow()
  expect(instanceId.meta.default).toBe('default')
  expect(messageRetentionDays.meta.default).toBe(90)
  expect(messageRetentionDays.meta.min).toBe(1)
  expect(messageRetentionDays.meta.max).toBe(3_650)
  expect(engagement({ enabled: false, idleTtlMs: 60_000, maxRounds: 4 })).toEqual({
    enabled: false,
    idleTtlMs: 60_000,
    maxDurationMs: DEFAULT_ENGAGEMENT_MAX_DURATION_MS,
    maxRounds: 4,
  })
  const engagementFields = engagement.dict
  if (engagementFields === undefined) throw new Error('Expected an engagement configuration schema')
  const engagementEnabled = engagementFields.enabled
  const idleTtlMs = engagementFields.idleTtlMs
  const maxDurationMs = engagementFields.maxDurationMs
  const maxRounds = engagementFields.maxRounds
  if (
    engagementEnabled === undefined ||
    idleTtlMs === undefined ||
    maxDurationMs === undefined ||
    maxRounds === undefined
  ) {
    throw new Error('Expected all engagement configuration fields')
  }
  expect(engagementEnabled.meta.default).toBe(DEFAULT_ENGAGEMENT_ENABLED)
  expect(idleTtlMs.meta).toMatchObject({ default: DEFAULT_ENGAGEMENT_IDLE_TTL_MS, min: 1 })
  expect(maxDurationMs.meta).toMatchObject({
    default: DEFAULT_ENGAGEMENT_MAX_DURATION_MS,
    min: 1,
  })
  expect(maxRounds.meta).toMatchObject({ default: DEFAULT_ENGAGEMENT_MAX_ROUNDS, min: 1 })
  expect(() => engagement({ idleTtlMs: 0 })).toThrow()
  expect(() => engagement({ maxDurationMs: 0 })).toThrow()
  expect(() => engagement({ maxRounds: 1.5 })).toThrow()
  expect(
    initiative({
      enabled: false,
      quietPeriodMs: 900_000,
      recentRelevanceThreshold: 0.8,
      relationshipThreshold: 0.2,
    }),
  ).toEqual({
    enabled: false,
    quietPeriodMs: 900_000,
    channelCooldownMs: DEFAULT_INITIATIVE_CHANNEL_COOLDOWN_MS,
    intrinsicIntervalMs: DEFAULT_INITIATIVE_INTRINSIC_INTERVAL_MS,
    recentWindowMs: DEFAULT_INITIATIVE_RECENT_WINDOW_MS,
    recentRelevanceThreshold: 0.8,
    relationshipThreshold: 0.2,
    minSocialEnergy: DEFAULT_INITIATIVE_MIN_SOCIAL_ENERGY,
    maxRecentParticipation: DEFAULT_INITIATIVE_MAX_RECENT_PARTICIPATION,
  })
  const initiativeFields = initiative.dict
  if (initiativeFields === undefined) {
    throw new Error('Expected an initiative configuration schema')
  }
  const initiativeEnabled = initiativeFields.enabled
  const quietPeriodMs = initiativeFields.quietPeriodMs
  const channelCooldownMs = initiativeFields.channelCooldownMs
  const intrinsicIntervalMs = initiativeFields.intrinsicIntervalMs
  const recentWindowMs = initiativeFields.recentWindowMs
  const recentRelevanceThreshold = initiativeFields.recentRelevanceThreshold
  const relationshipThreshold = initiativeFields.relationshipThreshold
  const minSocialEnergy = initiativeFields.minSocialEnergy
  const maxRecentParticipation = initiativeFields.maxRecentParticipation
  if (
    initiativeEnabled === undefined ||
    quietPeriodMs === undefined ||
    channelCooldownMs === undefined ||
    intrinsicIntervalMs === undefined ||
    recentWindowMs === undefined ||
    recentRelevanceThreshold === undefined ||
    relationshipThreshold === undefined ||
    minSocialEnergy === undefined ||
    maxRecentParticipation === undefined
  ) {
    throw new Error('Expected all initiative configuration fields')
  }
  expect(initiativeEnabled.meta.default).toBe(DEFAULT_INITIATIVE_ENABLED)
  expect(quietPeriodMs.meta).toMatchObject({
    default: DEFAULT_INITIATIVE_QUIET_PERIOD_MS,
    min: 60_000,
    max: 24 * 60 * 60 * 1_000,
  })
  expect(channelCooldownMs.meta).toMatchObject({
    default: DEFAULT_INITIATIVE_CHANNEL_COOLDOWN_MS,
    min: 60_000,
    max: 30 * 24 * 60 * 60 * 1_000,
  })
  expect(intrinsicIntervalMs.meta).toMatchObject({
    default: DEFAULT_INITIATIVE_INTRINSIC_INTERVAL_MS,
    min: 60 * 60 * 1_000,
    max: 90 * 24 * 60 * 60 * 1_000,
  })
  expect(recentWindowMs.meta).toMatchObject({
    default: DEFAULT_INITIATIVE_RECENT_WINDOW_MS,
    min: 60_000,
    max: 30 * 24 * 60 * 60 * 1_000,
  })
  expect(recentRelevanceThreshold.meta).toMatchObject({
    default: DEFAULT_INITIATIVE_RECENT_RELEVANCE_THRESHOLD,
    min: 0,
    max: 1,
  })
  expect(relationshipThreshold.meta).toMatchObject({
    default: DEFAULT_INITIATIVE_RELATIONSHIP_THRESHOLD,
    min: 0,
    max: 1,
  })
  expect(minSocialEnergy.meta).toMatchObject({
    default: DEFAULT_INITIATIVE_MIN_SOCIAL_ENERGY,
    min: 0,
    max: 1,
  })
  expect(maxRecentParticipation.meta).toMatchObject({
    default: DEFAULT_INITIATIVE_MAX_RECENT_PARTICIPATION,
    min: 0,
    max: 1,
  })
  expect(initiativeFields).not.toHaveProperty('allowDirectMessages')
  expect(() => initiative({ quietPeriodMs: 59_999 })).toThrow()
  expect(() => initiative({ intrinsicIntervalMs: 3_599_999 })).toThrow()
  expect(() => initiative({ recentRelevanceThreshold: 1.01 })).toThrow()
  expect(() => initiative({ relationshipThreshold: -0.01 })).toThrow()
  expect(() => initiative({ minSocialEnergy: 1.01 })).toThrow()
  expect(() => initiative({ maxRecentParticipation: -0.01 })).toThrow()
  expect(notebook({ recallLimit: 12 })).toEqual({
    maxNotesPerReply: DEFAULT_NOTEBOOK_MAX_NOTES_PER_REPLY,
    recallLimit: 12,
    defaultExpirationDays: DEFAULT_NOTEBOOK_EXPIRATION_DAYS,
  })
  const notebookFields = notebook.dict
  if (notebookFields === undefined) throw new Error('Expected a notebook configuration schema')
  const maxNotesPerReply = notebookFields.maxNotesPerReply
  const recallLimit = notebookFields.recallLimit
  const defaultExpirationDays = notebookFields.defaultExpirationDays
  if (
    maxNotesPerReply === undefined ||
    recallLimit === undefined ||
    defaultExpirationDays === undefined
  ) {
    throw new Error('Expected all notebook configuration fields')
  }
  expect(maxNotesPerReply.meta).toMatchObject({
    default: DEFAULT_NOTEBOOK_MAX_NOTES_PER_REPLY,
    min: 1,
    max: 8,
  })
  expect(recallLimit.meta).toMatchObject({
    default: DEFAULT_NOTEBOOK_RECALL_LIMIT,
    min: 1,
    max: 32,
  })
  expect(defaultExpirationDays.meta).toMatchObject({
    default: DEFAULT_NOTEBOOK_EXPIRATION_DAYS,
    min: 1,
    max: 3_650,
  })
  expect(schedule({ timeZone: 'Asia/Shanghai', contextLimit: 12 })).toEqual({
    enabled: DEFAULT_SCHEDULE_ENABLED,
    timeZone: 'Asia/Shanghai',
    gracePeriodMs: DEFAULT_SCHEDULE_GRACE_PERIOD_MS,
    contextLimit: 12,
  })
  const scheduleFields = schedule.dict
  if (scheduleFields === undefined) throw new Error('Expected a schedule configuration schema')
  const scheduleEnabled = scheduleFields.enabled
  const scheduleTimeZone = scheduleFields.timeZone
  const gracePeriodMs = scheduleFields.gracePeriodMs
  const contextLimit = scheduleFields.contextLimit
  if (
    scheduleEnabled === undefined ||
    scheduleTimeZone === undefined ||
    gracePeriodMs === undefined ||
    contextLimit === undefined
  ) {
    throw new Error('Expected all schedule configuration fields')
  }
  expect(scheduleEnabled.meta.default).toBe(DEFAULT_SCHEDULE_ENABLED)
  expect(scheduleTimeZone.meta.default).toBe(DEFAULT_SCHEDULE_TIME_ZONE)
  expect(gracePeriodMs.meta).toMatchObject({
    default: DEFAULT_SCHEDULE_GRACE_PERIOD_MS,
    min: 0,
  })
  expect(contextLimit.meta).toMatchObject({
    default: DEFAULT_SCHEDULE_CONTEXT_LIMIT,
    min: 1,
    max: 32,
  })
  expect(() => schedule({ gracePeriodMs: -1 })).toThrow()
  expect(() => schedule({ contextLimit: 0 })).toThrow()
  expect(presetId.meta.default).toBeUndefined()
  expect(presetDirectory.meta.role).toBe('path')
  expect(presetReloadDebounceMs.meta.default).toBe(DEFAULT_PRESET_RELOAD_DEBOUNCE_MS)
  expect(state({ maxInteractionDelta: 0.05, moodHalfLifeMs: 60_000 })).toEqual({
    maxInteractionDelta: 0.05,
    moodHalfLifeMs: 60_000,
    participationHalfLifeMs: DEFAULT_STATE_PARTICIPATION_HALF_LIFE_MS,
    energyRecoveryHalfLifeMs: DEFAULT_STATE_ENERGY_RECOVERY_HALF_LIFE_MS,
  })
  const stateFields = state.dict
  if (stateFields === undefined) throw new Error('Expected a role-state configuration schema')
  const maxInteractionDelta = stateFields.maxInteractionDelta
  const moodHalfLifeMs = stateFields.moodHalfLifeMs
  const participationHalfLifeMs = stateFields.participationHalfLifeMs
  const energyRecoveryHalfLifeMs = stateFields.energyRecoveryHalfLifeMs
  if (
    maxInteractionDelta === undefined ||
    moodHalfLifeMs === undefined ||
    participationHalfLifeMs === undefined ||
    energyRecoveryHalfLifeMs === undefined
  ) {
    throw new Error('Expected all role-state configuration fields')
  }
  expect(maxInteractionDelta.meta).toMatchObject({ min: 0.001, max: 0.5 })
  expect(moodHalfLifeMs.meta).toMatchObject({ min: 1, max: MAX_STATE_HALF_LIFE_MS })
  expect(participationHalfLifeMs.meta).toMatchObject({
    min: 1,
    max: MAX_STATE_HALF_LIFE_MS,
  })
  expect(energyRecoveryHalfLifeMs.meta).toMatchObject({
    min: 1,
    max: MAX_STATE_HALF_LIFE_MS,
  })
  expect(wake({ directDebounceMs: 800 })).toEqual({
    directDebounceMs: 800,
    hardReplyAtMention: DEFAULT_HARD_REPLY_AT_MENTION,
    hardReplyOnReplyToSelf: DEFAULT_HARD_REPLY_ON_REPLY_TO_SELF,
    hardReplyRoleNamePrefix: DEFAULT_HARD_REPLY_ROLE_NAME_PREFIX,
    hardReplyRoleNameContains: DEFAULT_HARD_REPLY_ROLE_NAME_CONTAINS,
    activityDebounceMs: DEFAULT_ACTIVITY_DEBOUNCE_MS,
    cooldownMs: DEFAULT_ACTIVITY_COOLDOWN_MS,
    activityHalfLifeMs: DEFAULT_ACTIVITY_HALF_LIFE_MS,
    activityThreshold: DEFAULT_ACTIVITY_THRESHOLD,
    relevanceThreshold: DEFAULT_RELEVANCE_THRESHOLD,
  })
  expect(
    wake({
      hardReplyAtMention: false,
      hardReplyOnReplyToSelf: false,
      hardReplyRoleNamePrefix: true,
      hardReplyRoleNameContains: true,
    }),
  ).toMatchObject({
    hardReplyAtMention: false,
    hardReplyOnReplyToSelf: false,
    hardReplyRoleNamePrefix: true,
    hardReplyRoleNameContains: true,
  })
  const wakeFields = wake.dict
  if (wakeFields === undefined) throw new Error('Expected a wake configuration schema')
  const hardReplyAtMention = wakeFields.hardReplyAtMention
  const hardReplyOnReplyToSelf = wakeFields.hardReplyOnReplyToSelf
  const hardReplyRoleNamePrefix = wakeFields.hardReplyRoleNamePrefix
  const hardReplyRoleNameContains = wakeFields.hardReplyRoleNameContains
  if (
    hardReplyAtMention === undefined ||
    hardReplyOnReplyToSelf === undefined ||
    hardReplyRoleNamePrefix === undefined ||
    hardReplyRoleNameContains === undefined
  ) {
    throw new Error('Expected all hard reply configuration fields')
  }
  expect(hardReplyAtMention.meta.default).toBe(DEFAULT_HARD_REPLY_AT_MENTION)
  expect(hardReplyOnReplyToSelf.meta.default).toBe(DEFAULT_HARD_REPLY_ON_REPLY_TO_SELF)
  expect(hardReplyRoleNamePrefix.meta.default).toBe(DEFAULT_HARD_REPLY_ROLE_NAME_PREFIX)
  expect(hardReplyRoleNameContains.meta.default).toBe(DEFAULT_HARD_REPLY_ROLE_NAME_CONTAINS)
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

it('resolves explicit false values for each hard reply switch', () => {
  expect(resolveHardReplyPolicy({ feedbackToolsEnabled: false })).toEqual({
    atMention: DEFAULT_HARD_REPLY_AT_MENTION,
    replyToSelf: DEFAULT_HARD_REPLY_ON_REPLY_TO_SELF,
    roleNamePrefix: DEFAULT_HARD_REPLY_ROLE_NAME_PREFIX,
    roleNameContains: DEFAULT_HARD_REPLY_ROLE_NAME_CONTAINS,
  })
  expect(
    resolveHardReplyPolicy({
      feedbackToolsEnabled: false,
      wake: {
        hardReplyAtMention: false,
        hardReplyOnReplyToSelf: false,
        hardReplyRoleNamePrefix: true,
        hardReplyRoleNameContains: true,
      },
    }),
  ).toEqual({
    atMention: false,
    replyToSelf: false,
    roleNamePrefix: true,
    roleNameContains: true,
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
