import { MAX_ADAPTER_ID_LENGTH } from '@yokai/protocol'
import { Schema } from 'koishi'

export const DEFAULT_ADAPTER_ID = 'gemini'
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

const EndpointConfig = Schema.object({
  apiKey: Schema.string().min(1).role('secret').required().description(' API key。'),
  baseUrl: Schema.string().role('link').default(DEFAULT_GEMINI_BASE_URL).description('Base URL'),
})

export const Config = Schema.object({
  adapterId: Schema.string()
    .min(1)
    .max(MAX_ADAPTER_ID_LENGTH)
    .pattern(/^[A-Za-z][A-Za-z0-9._-]*$/)
    .default(DEFAULT_ADAPTER_ID)
    .description('此 Gemini adapter 实例的稳定 ID；须保证唯一性。'),
  endpoints: Schema.array(EndpointConfig)
    .role('table')
    .default([])
    .description('按优先级排列的 URL/key 端点；至少需要一组。'),
  requestTimeoutMs: Schema.natural()
    .min(1_000)
    .max(600_000)
    .role('ms')
    .default(DEFAULT_REQUEST_TIMEOUT_MS)
    .description('单次 HTTP 请求超时。'),
  discoveryRetry: DiscoveryRetryConfig.description('仅用于模型发现的有界重试策略。'),
})

export type Config = ReturnType<typeof Config>
