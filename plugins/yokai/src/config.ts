import { Schema } from 'koishi'

export const DEFAULT_INSTANCE_ID = 'default'
export const DEFAULT_MESSAGE_RETENTION_DAYS = 90
export const DEFAULT_DIRECT_DEBOUNCE_MS = 500
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

export interface WakeConfig {
  directDebounceMs?: number
  activityDebounceMs?: number
  cooldownMs?: number
  activityHalfLifeMs?: number
  activityThreshold?: number
  relevanceThreshold?: number
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

export interface Config {
  instanceId?: string
  model?: string
  feedbackToolsEnabled: boolean
  messageRetentionDays?: number
  wake?: WakeConfig
  callBudget?: CallBudgetConfig
}

const WakeConfigSchema = Schema.object({
  directDebounceMs: Schema.natural()
    .min(100)
    .max(5_000)
    .role('ms')
    .default(DEFAULT_DIRECT_DEBOUNCE_MS)
    .description('直接 @、回复和补充消息使用的短合并窗口。'),
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
  activityDebounceMs: DEFAULT_ACTIVITY_DEBOUNCE_MS,
  cooldownMs: DEFAULT_ACTIVITY_COOLDOWN_MS,
  activityHalfLifeMs: DEFAULT_ACTIVITY_HALF_LIFE_MS,
  activityThreshold: DEFAULT_ACTIVITY_THRESHOLD,
  relevanceThreshold: DEFAULT_RELEVANCE_THRESHOLD,
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

export const Config: Schema<Config> = Schema.object({
  instanceId: Schema.string()
    .pattern(/^[A-Za-z][A-Za-z0-9._-]*$/)
    .max(128)
    .default(DEFAULT_INSTANCE_ID)
    .description('Yokai 实例 ID，用于隔离本地历史和状态。'),
  model: Schema.dynamic('yokai-model').description('生成模型。未配置时仅运行本地路径。'),
  feedbackToolsEnabled: Schema.boolean()
    .default(false)
    .description('允许模型使用一次有界 FeedbackTool 反馈。'),
  messageRetentionDays: Schema.natural()
    .min(1)
    .max(3_650)
    .default(DEFAULT_MESSAGE_RETENTION_DAYS)
    .description('原始群聊消息的本地保留天数。'),
  wake: WakeConfigSchema.description('本地活跃度门控、合并窗口和冷却设置。'),
  callBudget: CallBudgetConfigSchema.description('分类逻辑调用预算。'),
})
