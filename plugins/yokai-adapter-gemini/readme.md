# @yokai/koishi-plugin-yokai-adapter-gemini

Gemini model adapter for Yokai.

The plugin owns one Gemini adapter and one logical Gemini connection. An ordered
endpoint list supplies equivalent transports for that connection; endpoints are
not separate model sources or selectable accounts.

```yaml
endpoints:
  - baseUrl: https://generativelanguage.googleapis.com/
    apiKey: <primary-secret>
  - baseUrl: https://gemini-proxy.example.com/
    apiKey: <standby-secret>
requestTimeoutMs: 60000
discoveryRetry:
  maxAttempts: 3
  initialDelayMs: 1000
  maxDelayMs: 10000
  backoffMultiplier: 2
```

Each endpoint contains only `baseUrl` and `apiKey`. `apiKey` is required;
omitting `baseUrl` uses `https://generativelanguage.googleapis.com/`. The Google
SDK appends its API version and resource path to that service root.
`requestTimeoutMs` and `discoveryRetry` are top-level settings shared by every
endpoint. Discovery retry settings apply only to background model discovery and
are never installed as client-wide generation retries. An eligible discovery
retry starts a new logical discovery call only after the prior call exhausts
its endpoint list; each endpoint is still tried at most once per call.

The first endpoint is active initially. Every discovery, `generate`, or
`continue` call starts at the current active endpoint. Authentication failures
(`401`/`403`), balance or rate failures (`402`/`429`), request timeouts
(`408`/`504` or the configured timeout), transport errors, and any other `5xx`
response move the same logical call to the next configured endpoint. Ordering
wraps at the end of the list, and a call tries each endpoint at most once. Only
a fully successful logical call makes its successful endpoint sticky; among
overlapping successful calls, the one that completes last wins. Exhaustion
returns the last error.

Caller cancellation, other `4xx` responses, and protocol, capability, or
content errors do not switch endpoints. During paginated discovery, a failure
on any page does not update the active endpoint: all partial pages are
discarded, and the next endpoint restarts at page one. The active endpoint is
updated only after every page from one endpoint succeeds, and only that complete
snapshot is published. Malformed pages, repeated page tokens, more than 100
pages, or more than 10,000 models are protocol failures and do not switch
endpoints. Streaming generation may switch only before its first chunk; after
that chunk, a failure is returned directly.
A timed-out non-streaming request may still finish remotely, so switching to
another endpoint can cause duplicate billing.

Models are identified only by their normalized provider model ID. The same
model exposed through several endpoints remains one model and receives no
transport-source prefix.

Model selection, primary models, and fallbacks belong to the Yokai host plugin,
not this adapter. Endpoint failover always keeps the same provider model and is
not the host plugin's model fallback. API keys are converted to non-encodable
redacted values before clients are constructed.
