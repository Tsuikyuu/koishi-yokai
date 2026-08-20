import { Schema } from 'koishi'

export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/'
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
export const DEFAULT_DISCOVERY_MAX_ATTEMPTS = 3
export const DEFAULT_DISCOVERY_INITIAL_DELAY_MS = 1_000
export const DEFAULT_DISCOVERY_MAX_DELAY_MS = 10_000
export const DEFAULT_DISCOVERY_BACKOFF_MULTIPLIER = 2

const DiscoveryRetryConfig = Schema.object({
  maxAttempts: Schema.natural()
    .min(1)
    .max(5)
    .default(DEFAULT_DISCOVERY_MAX_ATTEMPTS)
    .description('包含首次请求在内的最大发现尝试次数。'),
  initialDelayMs: Schema.natural()
    .min(1)
    .max(300_000)
    .role('ms')
    .default(DEFAULT_DISCOVERY_INITIAL_DELAY_MS)
    .description('模型发现首次重试前的等待时间。'),
  maxDelayMs: Schema.natural()
    .min(1)
    .max(300_000)
    .role('ms')
    .default(DEFAULT_DISCOVERY_MAX_DELAY_MS)
    .description('模型发现重试间隔的上限。'),
  backoffMultiplier: Schema.number()
    .min(1)
    .max(10)
    .default(DEFAULT_DISCOVERY_BACKOFF_MULTIPLIER)
    .description('模型发现重试间隔的指数倍率。'),
}).default({
  maxAttempts: DEFAULT_DISCOVERY_MAX_ATTEMPTS,
  initialDelayMs: DEFAULT_DISCOVERY_INITIAL_DELAY_MS,
  maxDelayMs: DEFAULT_DISCOVERY_MAX_DELAY_MS,
  backoffMultiplier: DEFAULT_DISCOVERY_BACKOFF_MULTIPLIER,
})

const ConnectionConfig = Schema.object({
  connectionId: Schema.string()
    .min(1)
    .max(128)
    .pattern(/^[^\p{C}/]+$/u)
    .required()
    .description('稳定且唯一的连接 ID，不允许包含“/”。'),
  displayName: Schema.string()
    .min(1)
    .max(256)
    .required()
    .description('在模型列表中区分连接的显示名称。'),
  apiKey: Schema.string()
    .min(1)
    .role('secret')
    .required()
    .description('Gemini Developer API key。'),
  baseUrl: Schema.string()
    .role('link')
    .default(DEFAULT_GEMINI_BASE_URL)
    .description('服务根 URL；SDK 会在其后追加 API 版本和路径。'),
  requestTimeoutMs: Schema.natural()
    .min(1_000)
    .max(600_000)
    .role('ms')
    .default(DEFAULT_REQUEST_TIMEOUT_MS)
    .description('单次 SDK HTTP 请求的传输超时。'),
  discoveryRetry: DiscoveryRetryConfig.description('仅用于后台模型发现的有界重试策略。'),
})

export const Config = Schema.object({
  connections: Schema.array(ConnectionConfig)
    .role('table')
    .default([])
    .description('Gemini 连接列表；至少需要一组有效连接。'),
})

export type Config = ReturnType<typeof Config>
