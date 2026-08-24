import { Schema } from 'koishi'

export interface Config {
  model?: string
  feedbackToolsEnabled: boolean
}

export const Config: Schema<Config> = Schema.object({
  model: Schema.dynamic('yokai-model').description('生成模型。未配置时仅运行本地路径。'),
  feedbackToolsEnabled: Schema.boolean()
    .default(false)
    .description('允许模型使用一次有界 FeedbackTool 反馈。'),
})
