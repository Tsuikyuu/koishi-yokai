# @yokai/koishi-plugin-yokai-adapter-gemini

Gemini model adapter for Yokai.

The plugin owns one Gemini adapter with one or more independent connections. Each
connection has its own SDK client, request lifetime, and stable `connectionId`.

```yaml
connections:
  - connectionId: personal
    displayName: Personal Gemini
    apiKey: <secret>
    baseUrl: https://generativelanguage.googleapis.com/
    requestTimeoutMs: 60000
    discoveryRetry:
      maxAttempts: 3
      initialDelayMs: 1000
      maxDelayMs: 10000
      backoffMultiplier: 2
```

`baseUrl` is the service root; the Google SDK appends its API version and
resource path. Discovery retry settings apply only to background model discovery
and are never installed as client-wide generation retries.

Model selection, primary models, and fallbacks belong to the Yokai host plugin,
not this adapter. API keys are converted to non-encodable redacted values before
clients are constructed.
