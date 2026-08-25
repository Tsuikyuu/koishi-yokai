import { Schema } from 'koishi'

export const DEFAULT_INSTANCE_ID = 'default'
export const DEFAULT_MESSAGE_RETENTION_DAYS = 90

export interface Config {
  instanceId?: string
  model?: string
  feedbackToolsEnabled: boolean
  messageRetentionDays?: number
}

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
})
