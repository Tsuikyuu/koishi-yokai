import {
  HISTORY_SEARCH_FEEDBACK_TOOL_ID,
  NOTEBOOK_WRITE_ACTION_TOOL_ID,
  SCHEDULE_CANCEL_ACTION_TOOL_ID,
  SCHEDULE_CREATE_ACTION_TOOL_ID,
  SCHEDULE_QUERY_FEEDBACK_TOOL_ID,
  SCHEDULE_UPDATE_ACTION_TOOL_ID,
} from 'yokai-protocol'
import { Schema } from 'koishi'

export const DEFAULT_INSTANCE_ID = 'default'
export const MAX_CONFIGURED_CAPABILITIES_PER_DOMAIN = 64
export const DEFAULT_VISIBLE_SKILLS: ReadonlyArray<string> = []
export const DEFAULT_VISIBLE_ACTION_TOOLS: ReadonlyArray<string> = [
  NOTEBOOK_WRITE_ACTION_TOOL_ID,
  SCHEDULE_CREATE_ACTION_TOOL_ID,
  SCHEDULE_UPDATE_ACTION_TOOL_ID,
  SCHEDULE_CANCEL_ACTION_TOOL_ID,
]
export const DEFAULT_VISIBLE_FEEDBACK_TOOLS: ReadonlyArray<string> = [
  HISTORY_SEARCH_FEEDBACK_TOOL_ID,
  SCHEDULE_QUERY_FEEDBACK_TOOL_ID,
]
export const DEFAULT_VISIBLE_MCP_SERVERS: ReadonlyArray<string> = []
export const DEFAULT_MESSAGE_RETENTION_DAYS = 90
export const DEFAULT_NOTEBOOK_MAX_NOTES_PER_REPLY = 4
export const DEFAULT_NOTEBOOK_RECALL_LIMIT = 8
export const DEFAULT_NOTEBOOK_EXPIRATION_DAYS = 365
export const DEFAULT_SCHEDULE_ENABLED = true
export const DEFAULT_SCHEDULE_TIME_ZONE = 'UTC'
export const DEFAULT_SCHEDULE_GRACE_PERIOD_MS = 5 * 60 * 1_000
export const DEFAULT_SCHEDULE_CONTEXT_LIMIT = 8
export const DEFAULT_PRESET_RELOAD_DEBOUNCE_MS = 250
export const DEFAULT_DIRECT_DEBOUNCE_MS = 500
export const DEFAULT_HARD_REPLY_AT_MENTION = true
export const DEFAULT_HARD_REPLY_ON_REPLY_TO_SELF = true
export const DEFAULT_HARD_REPLY_ROLE_NAME_PREFIX = false
export const DEFAULT_HARD_REPLY_ROLE_NAME_CONTAINS = false
export const DEFAULT_ENGAGEMENT_ENABLED = true
export const DEFAULT_ENGAGEMENT_IDLE_TTL_MS = 90_000
export const DEFAULT_ENGAGEMENT_MAX_DURATION_MS = 300_000
export const DEFAULT_ENGAGEMENT_MAX_ROUNDS = 8
export const DEFAULT_ACTIVITY_DEBOUNCE_MS = 3_000
export const DEFAULT_ACTIVITY_COOLDOWN_MS = 45_000
export const DEFAULT_ACTIVITY_HALF_LIFE_MS = 120_000
export const DEFAULT_ACTIVITY_THRESHOLD = 7
export const DEFAULT_RELEVANCE_THRESHOLD = 2
export const DEFAULT_BUDGET_TIME_ZONE = 'UTC'
export const DEFAULT_RESERVED_MINUTE_CALLS = 6
export const DEFAULT_RESERVED_DAY_CALLS = 200
export const DEFAULT_NORMAL_MINUTE_CALLS = 2
export const DEFAULT_NORMAL_DAY_CALLS = 100
export const DEFAULT_BACKGROUND_MINUTE_CALLS = 1
export const DEFAULT_BACKGROUND_DAY_CALLS = 20
export const DEFAULT_STATE_MAX_INTERACTION_DELTA = 0.2
export const DEFAULT_STATE_MOOD_HALF_LIFE_MS = 4 * 60 * 60 * 1_000
export const DEFAULT_STATE_PARTICIPATION_HALF_LIFE_MS = 30 * 60 * 1_000
export const DEFAULT_STATE_ENERGY_RECOVERY_HALF_LIFE_MS = 2 * 60 * 60 * 1_000
export const MAX_STATE_HALF_LIFE_MS = 365 * 24 * 60 * 60 * 1_000

export interface WakeConfig {
  directDebounceMs?: number
  hardReplyAtMention?: boolean
  hardReplyOnReplyToSelf?: boolean
  hardReplyRoleNamePrefix?: boolean
  hardReplyRoleNameContains?: boolean
  activityDebounceMs?: number
  cooldownMs?: number
  activityHalfLifeMs?: number
  activityThreshold?: number
  relevanceThreshold?: number
}

export interface HardReplyPolicy {
  readonly atMention: boolean
  readonly replyToSelf: boolean
  readonly roleNamePrefix: boolean
  readonly roleNameContains: boolean
}

export interface EngagementConfig {
  enabled?: boolean
  idleTtlMs?: number
  maxDurationMs?: number
  maxRounds?: number
}

export interface BudgetClassConfig {
  minute?: number
  day?: number
}

export interface CallBudgetConfig {
  timeZone?: string
  reserved?: BudgetClassConfig
  normal?: BudgetClassConfig
  background?: BudgetClassConfig
}

export interface StateConfig {
  maxInteractionDelta?: number
  moodHalfLifeMs?: number
  participationHalfLifeMs?: number
  energyRecoveryHalfLifeMs?: number
}

export interface NotebookConfig {
  maxNotesPerReply?: number
  recallLimit?: number
  defaultExpirationDays?: number
}

export interface ScheduleConfig {
  enabled?: boolean
  timeZone?: string
  gracePeriodMs?: number
  contextLimit?: number
}

export interface CapabilityVisibilityConfig {
  skills?: string[]
  actionTools?: string[]
  feedbackTools?: string[]
  mcpServers?: string[]
}

export interface Config {
  instanceId?: string
  presetId?: string
  presetDirectory?: string
  presetReloadDebounceMs?: number
  model?: string
  feedbackToolsEnabled: boolean
  capabilities?: CapabilityVisibilityConfig
  messageRetentionDays?: number
  notebook?: NotebookConfig
  schedule?: ScheduleConfig
  state?: StateConfig
  wake?: WakeConfig
  engagement?: EngagementConfig
  callBudget?: CallBudgetConfig
}

export const resolveHardReplyPolicy = (config: Config): HardReplyPolicy => {
  const wake = config.wake
  return {
    atMention:
      wake === undefined || wake.hardReplyAtMention === undefined
        ? DEFAULT_HARD_REPLY_AT_MENTION
        : wake.hardReplyAtMention,
    replyToSelf:
      wake === undefined || wake.hardReplyOnReplyToSelf === undefined
        ? DEFAULT_HARD_REPLY_ON_REPLY_TO_SELF
        : wake.hardReplyOnReplyToSelf,
    roleNamePrefix:
      wake === undefined || wake.hardReplyRoleNamePrefix === undefined
        ? DEFAULT_HARD_REPLY_ROLE_NAME_PREFIX
        : wake.hardReplyRoleNamePrefix,
    roleNameContains:
      wake === undefined || wake.hardReplyRoleNameContains === undefined
        ? DEFAULT_HARD_REPLY_ROLE_NAME_CONTAINS
        : wake.hardReplyRoleNameContains,
  }
}

const WakeConfigSchema = Schema.object({
  directDebounceMs: Schema.natural()
    .min(100)
    .max(5_000)
    .role('ms')
    .default(DEFAULT_DIRECT_DEBOUNCE_MS)
    .description('配置硬回复和补充消息使用的短合并窗口。'),
  hardReplyAtMention: Schema.boolean()
    .default(DEFAULT_HARD_REPLY_AT_MENTION)
    .description('角色被平台明确 @ 时启用硬回复。'),
  hardReplyOnReplyToSelf: Schema.boolean()
    .default(DEFAULT_HARD_REPLY_ON_REPLY_TO_SELF)
    .description('回复当前机器人发送的消息时启用硬回复。'),
  hardReplyRoleNamePrefix: Schema.boolean()
    .default(DEFAULT_HARD_REPLY_ROLE_NAME_PREFIX)
    .description('消息以当前 preset 的完整角色名开头时启用硬回复。'),
  hardReplyRoleNameContains: Schema.boolean()
    .default(DEFAULT_HARD_REPLY_ROLE_NAME_CONTAINS)
    .description('消息任意位置包含当前 preset 的角色名时启用硬回复。'),
  activityDebounceMs: Schema.natural()
    .min(500)
    .max(30_000)
    .role('ms')
    .default(DEFAULT_ACTIVITY_DEBOUNCE_MS)
    .description('社会触发等待自然消息簇结束的合并窗口。'),
  cooldownMs: Schema.natural()
    .min(0)
    .max(3_600_000)
    .role('ms')
    .default(DEFAULT_ACTIVITY_COOLDOWN_MS)
    .description('社会触发成功后的频道冷却时间。'),
  activityHalfLifeMs: Schema.natural()
    .min(1_000)
    .max(3_600_000)
    .role('ms')
    .default(DEFAULT_ACTIVITY_HALF_LIFE_MS)
    .description('频道活跃度的半衰期。'),
  activityThreshold: Schema.number()
    .min(0)
    .max(1_000)
    .default(DEFAULT_ACTIVITY_THRESHOLD)
    .description('社会触发的基础活跃度阈值。'),
  relevanceThreshold: Schema.number()
    .min(0)
    .max(1_000)
    .default(DEFAULT_RELEVANCE_THRESHOLD)
    .description('社会触发的基础相关度阈值。'),
}).default({
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
})

const EngagementConfigSchema = Schema.object({
  enabled: Schema.boolean()
    .default(DEFAULT_ENGAGEMENT_ENABLED)
    .description('允许已启用的明确 @ 或回复机器人消息规则建立短期持续讨论租约。'),
  idleTtlMs: Schema.natural()
    .min(1)
    .role('ms')
    .default(DEFAULT_ENGAGEMENT_IDLE_TTL_MS)
    .description('租约在没有被接受的持续讨论回合时保持有效的空闲时间。'),
  maxDurationMs: Schema.natural()
    .min(1)
    .role('ms')
    .default(DEFAULT_ENGAGEMENT_MAX_DURATION_MS)
    .description('单次讨论租约从建立起不可延长的最长持续时间。'),
  maxRounds: Schema.natural()
    .min(1)
    .default(DEFAULT_ENGAGEMENT_MAX_ROUNDS)
    .description('单次讨论租约最多接受的持续讨论角色回合数。'),
}).default({
  enabled: DEFAULT_ENGAGEMENT_ENABLED,
  idleTtlMs: DEFAULT_ENGAGEMENT_IDLE_TTL_MS,
  maxDurationMs: DEFAULT_ENGAGEMENT_MAX_DURATION_MS,
  maxRounds: DEFAULT_ENGAGEMENT_MAX_ROUNDS,
})

const budgetClass = (minute: number, day: number) =>
  Schema.object({
    minute: Schema.natural().max(10_000).default(minute).description('每分钟逻辑调用上限。'),
    day: Schema.natural().max(1_000_000).default(day).description('每日逻辑调用上限。'),
  }).default({ minute, day })

const CallBudgetConfigSchema = Schema.object({
  timeZone: Schema.string()
    .default(DEFAULT_BUDGET_TIME_ZONE)
    .description('每日预算翻转使用的 IANA 时区。'),
  reserved: budgetClass(DEFAULT_RESERVED_MINUTE_CALLS, DEFAULT_RESERVED_DAY_CALLS).description(
    '直接对话与到期事项的保留额度。',
  ),
  normal: budgetClass(DEFAULT_NORMAL_MINUTE_CALLS, DEFAULT_NORMAL_DAY_CALLS).description(
    '社会触发的普通额度。',
  ),
  background: budgetClass(
    DEFAULT_BACKGROUND_MINUTE_CALLS,
    DEFAULT_BACKGROUND_DAY_CALLS,
  ).description('主动行为的后台额度。'),
}).default({
  timeZone: DEFAULT_BUDGET_TIME_ZONE,
  reserved: { minute: DEFAULT_RESERVED_MINUTE_CALLS, day: DEFAULT_RESERVED_DAY_CALLS },
  normal: { minute: DEFAULT_NORMAL_MINUTE_CALLS, day: DEFAULT_NORMAL_DAY_CALLS },
  background: {
    minute: DEFAULT_BACKGROUND_MINUTE_CALLS,
    day: DEFAULT_BACKGROUND_DAY_CALLS,
  },
})

const StateConfigSchema = Schema.object({
  maxInteractionDelta: Schema.number()
    .min(0.001)
    .max(0.5)
    .default(DEFAULT_STATE_MAX_INTERACTION_DELTA)
    .description('一次互动对任一角色状态或关系数值维度造成的最大变化。'),
  moodHalfLifeMs: Schema.natural()
    .min(1)
    .max(MAX_STATE_HALF_LIFE_MS)
    .role('ms')
    .default(DEFAULT_STATE_MOOD_HALF_LIFE_MS)
    .description('短期心境偏移回归中性的半衰期。'),
  participationHalfLifeMs: Schema.natural()
    .min(1)
    .max(MAX_STATE_HALF_LIFE_MS)
    .role('ms')
    .default(DEFAULT_STATE_PARTICIPATION_HALF_LIFE_MS)
    .description('近期参与压力的半衰期。'),
  energyRecoveryHalfLifeMs: Schema.natural()
    .min(1)
    .max(MAX_STATE_HALF_LIFE_MS)
    .role('ms')
    .default(DEFAULT_STATE_ENERGY_RECOVERY_HALF_LIFE_MS)
    .description('社交精力向休息状态恢复的半衰期。'),
}).default({
  maxInteractionDelta: DEFAULT_STATE_MAX_INTERACTION_DELTA,
  moodHalfLifeMs: DEFAULT_STATE_MOOD_HALF_LIFE_MS,
  participationHalfLifeMs: DEFAULT_STATE_PARTICIPATION_HALF_LIFE_MS,
  energyRecoveryHalfLifeMs: DEFAULT_STATE_ENERGY_RECOVERY_HALF_LIFE_MS,
})

const NotebookConfigSchema = Schema.object({
  maxNotesPerReply: Schema.natural()
    .min(1)
    .max(8)
    .default(DEFAULT_NOTEBOOK_MAX_NOTES_PER_REPLY)
    .description('单次成功回复最多允许 notebook.write 提出的长期笔记数。'),
  recallLimit: Schema.natural()
    .min(1)
    .max(32)
    .default(DEFAULT_NOTEBOOK_RECALL_LIMIT)
    .description('每次上下文召回的长期笔记上限。'),
  defaultExpirationDays: Schema.natural()
    .min(1)
    .max(3_650)
    .default(DEFAULT_NOTEBOOK_EXPIRATION_DAYS)
    .description('未显式指定 expiresAt 时长期笔记的默认过期天数。'),
}).default({
  maxNotesPerReply: DEFAULT_NOTEBOOK_MAX_NOTES_PER_REPLY,
  recallLimit: DEFAULT_NOTEBOOK_RECALL_LIMIT,
  defaultExpirationDays: DEFAULT_NOTEBOOK_EXPIRATION_DAYS,
})

const ScheduleConfigSchema = Schema.object({
  enabled: Schema.boolean()
    .default(DEFAULT_SCHEDULE_ENABLED)
    .description('启用持久化定时任务能力与到期唤醒。'),
  timeZone: Schema.string()
    .default(DEFAULT_SCHEDULE_TIME_ZONE)
    .description('解析定时任务日期和时间使用的 IANA 时区。'),
  gracePeriodMs: Schema.natural()
    .min(0)
    .max(30 * 24 * 60 * 60 * 1_000)
    .role('ms')
    .default(DEFAULT_SCHEDULE_GRACE_PERIOD_MS)
    .description('重启后允许错过任务立即触发的宽限时间。'),
  contextLimit: Schema.natural()
    .min(1)
    .max(32)
    .default(DEFAULT_SCHEDULE_CONTEXT_LIMIT)
    .description('生成前注入的近期待办数量上限。'),
}).default({
  enabled: DEFAULT_SCHEDULE_ENABLED,
  timeZone: DEFAULT_SCHEDULE_TIME_ZONE,
  gracePeriodMs: DEFAULT_SCHEDULE_GRACE_PERIOD_MS,
  contextLimit: DEFAULT_SCHEDULE_CONTEXT_LIMIT,
})

const CapabilityIdSchema = Schema.string()
  .pattern(/^[A-Za-z_][A-Za-z0-9._-]*$/)
  .max(128)

const capabilityAllowlist = (defaults: ReadonlyArray<string>) =>
  Schema.transform(
    Schema.array(CapabilityIdSchema).max(MAX_CONFIGURED_CAPABILITIES_PER_DOMAIN),
    (ids, options) => {
      if (new Set(ids).size !== ids.length) {
        throw new Schema.ValidationError('expected unique capability IDs', options)
      }
      return ids
    },
    true,
  ).default([...defaults])

const CapabilityVisibilityConfigSchema = Schema.object({
  skills: capabilityAllowlist(DEFAULT_VISIBLE_SKILLS).description(
    '允许本地选择的 Skill ID。第三方 Skill 默认不可见。',
  ),
  actionTools: capabilityAllowlist(DEFAULT_VISIBLE_ACTION_TOOLS).description(
    '允许进入回合选择的 ActionTool ID。',
  ),
  feedbackTools: capabilityAllowlist(DEFAULT_VISIBLE_FEEDBACK_TOOLS).description(
    '允许进入回合选择的 FeedbackTool ID；仍受 feedbackToolsEnabled 总开关限制。',
  ),
  mcpServers: capabilityAllowlist(DEFAULT_VISIBLE_MCP_SERVERS).description(
    '允许投影能力进入回合选择的 MCP Server ID。第三方服务默认不可见。',
  ),
}).default({
  skills: [...DEFAULT_VISIBLE_SKILLS],
  actionTools: [...DEFAULT_VISIBLE_ACTION_TOOLS],
  feedbackTools: [...DEFAULT_VISIBLE_FEEDBACK_TOOLS],
  mcpServers: [...DEFAULT_VISIBLE_MCP_SERVERS],
})

export const Config: Schema<Config> = Schema.object({
  instanceId: Schema.string()
    .pattern(/^[A-Za-z][A-Za-z0-9._-]*$/)
    .max(128)
    .default(DEFAULT_INSTANCE_ID)
    .description('Yokai 实例 ID，用于隔离本地历史和状态；每个活跃写入实例必须唯一。'),
  presetId: Schema.string()
    .pattern(/^[A-Za-z_][A-Za-z0-9._-]*$/)
    .max(128)
    .description('当前人格预设 ID；配置后仅在该预设存在时创建模型回合。'),
  presetDirectory: Schema.path({ filters: ['directory'], allowCreate: true }).description(
    '可选的 YAML/JSON 人格预设目录；文件修改会原子热更新后续回合。',
  ),
  presetReloadDebounceMs: Schema.natural()
    .min(50)
    .max(10_000)
    .role('ms')
    .default(DEFAULT_PRESET_RELOAD_DEBOUNCE_MS)
    .description('预设目录变更后的安静期。'),
  model: Schema.dynamic('yokai-model').description('生成模型。未配置时仅运行本地路径。'),
  feedbackToolsEnabled: Schema.boolean()
    .default(false)
    .description('允许模型使用一次有界 FeedbackTool 反馈。'),
  capabilities: CapabilityVisibilityConfigSchema.description(
    'Skill、ActionTool、FeedbackTool 和 MCP Server 的实例级可见上界。',
  ),
  messageRetentionDays: Schema.natural()
    .min(1)
    .max(3_650)
    .default(DEFAULT_MESSAGE_RETENTION_DAYS)
    .description('原始群聊消息的本地保留天数。'),
  notebook: NotebookConfigSchema.description('长期记事本的写入、召回和默认过期参数。'),
  schedule: ScheduleConfigSchema.description('持久化定时任务的开关、时区、错过宽限和上下文上限。'),
  state: StateConfigSchema.description('角色心境、社交精力、近期参与和成员关系的本地状态参数。'),
  wake: WakeConfigSchema.description('硬回复开关、本地活跃度门控、合并窗口和冷却设置。'),
  engagement: EngagementConfigSchema.description('持续讨论租约的空闲期、绝对期限和轮数边界。'),
  callBudget: CallBudgetConfigSchema.description('分类逻辑调用预算。'),
})
