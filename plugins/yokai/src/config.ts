import { Schema } from 'koishi'

export interface Config {
  primary?: string
  fallback: string[]
  feedbackToolsEnabled: boolean
}

export const Config: Schema<Config> = Schema.object({
  primary: Schema.dynamic('yokai-model').description('首选模型。未配置时仅运行本地路径。'),
  fallback: Schema.array(Schema.dynamic('yokai-model'))
    .default([])
    .description('按顺序尝试的备用模型。'),
  feedbackToolsEnabled: Schema.boolean()
    .default(false)
    .description('允许模型使用一次有界 FeedbackTool 反馈。'),
})
