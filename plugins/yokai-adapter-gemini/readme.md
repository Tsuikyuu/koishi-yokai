# koishi-plugin-yokai-adapter-gemini

Gemini model adapter for Yokai.

Each Koishi plugin instance owns one Gemini adapter and one logical Gemini
connection. The plugin does not declare a Koishi `reusable` policy. The top-level
`adapterId` defaults to `gemini`; if multiple plugin instances are registered
with the same Yokai host, they must use unique adapter IDs because the host
registry rejects a later registration with an ID already in use. An ordered
endpoint list supplies equivalent transports for one instance's connection;
endpoints are not separate model sources or selectable accounts.

Every `GoogleGenAI` client receives an instance-local fetch implementation backed
by this plugin context's `ctx.http`. Gemini requests therefore follow Koishi HTTP
configuration, context interceptors, headers, keep-alive settings, proxy hooks,
and lifecycle without replacing `globalThis.fetch` or a process-wide dispatcher.
The adapter has no separate proxy configuration. Generation is unary: Yokai calls
`generateContent`, waits for the complete response, and never requests or consumes
SSE.

`@google/genai` 2.18.0 does not yet expose this transport seam upstream. The
minimal Yarn patch used by the workspace is an accepted development-only
deviation and lives at
`patches/google-genai-2.18.0-instance-fetch.patch` and is referenced by this
workspace dependency; an unpatched SDK fails client initialization instead of
silently falling back to global fetch. The workspace remains `private` while the
patch is in use, and the public-release gate is deferred. A formal release must
instead use an exact upstream version with the seam or an auditable published
scoped fork; users will not be asked to reproduce the repository-local patch.

```yaml
adapterId: gemini
endpoints:
  - baseUrl: https://generativelanguage.googleapis.com/
    apiKey: <primary-secret>
  - baseUrl: https://gemini-proxy.example.com/
    apiKey: <standby-secret>
requestTimeoutMs: 60000
maxConcurrency: 4
discoveryRetry:
  maxAttempts: 3
  initialDelayMs: 1000
  maxDelayMs: 10000
  backoffMultiplier: 2
```

`adapterId` is optional and defaults to `gemini`; configure a distinct valid ID
for each instance that will be registered with the same Yokai host. Each
endpoint contains only `baseUrl` and `apiKey`. `apiKey` is required;
omitting `baseUrl` uses `https://generativelanguage.googleapis.com/`. The Google
SDK appends its API version and resource path to that service root.
`requestTimeoutMs`, `maxConcurrency`, and `discoveryRetry` are top-level settings
shared by every endpoint. `maxConcurrency` defaults to `4`, accepts `1..64`, and
limits complete logical `discoverModels`, `generate`, and `continue` calls for
one adapter instance. A permit covers all endpoint attempts and response decoding.
Waiting is cancellable and does not reach the SDK; background discovery releases
its permit while backing off and reacquires one for each retry. Discovery retry
settings apply only to background model discovery and are never installed as
client-wide generation retries.

The first endpoint is active initially. Every discovery or `generate` call
starts at the current active endpoint. Authentication failures
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
endpoints. A timed-out generation request may still finish remotely, so switching
to another endpoint can cause duplicate generation and billing.

The standalone plugin Layer starts one scoped background discovery. In normal
Koishi use, the adapter registers through `ctx.yokai`; the host triggers that
same single initial discovery and publishes its result into the live catalog.
Reloading the adapter after a configuration update registers a new scoped
instance for the new endpoint set. Manual refresh goes through the Yokai host;
ordinary message handling does not trigger discovery.

Startup discovery completes one bounded endpoint pass before retrying. Only a
final `429`, `500`, `502`, or `503` is retried, with exponential delays capped by
`maxDelayMs`; `maxAttempts` includes the initial pass. Authentication, protocol,
transport, timeout, cancellation, and other provider failures are not retried.

When Gemini supplies a provider method list, discovery publishes only models whose
list includes `generateContent`; a missing list keeps the model without inventing
capabilities. It strips the leading `models/` resource prefix, keeps the
provider display name and explicit token limits, preserves a unique sorted copy
of the provider method list, deduplicates by normalized model ID, and sorts the
snapshot by that ID. Models are identified only by this normalized provider
model ID. The same model exposed through several endpoints remains one model and
receives no transport-source prefix.

If every endpoint in a later discovery pass fails, the last published snapshot
is retained with every model marked `stale`. A first discovery failure publishes
no default or synthesized model. Discovery never sends generation, function
calling, capability-probe, message, persona, or memory requests.

The runtime Layer also exposes one provider-neutral `GeminiAdapter.Service`.
Its descriptor uses the configured adapter ID and declares `feedbackTools: true`
for the adapter-wide transport contract; this does not claim that every discovered
model supports function calling. Text generation validates the common request
before any provider call, maps the optional system instruction and each
user/assistant turn to Gemini content (`assistant` becomes `model`), preserves the
adapter-local model ID, and applies the requested maximum output-token limit.
Sampling and provider-only options are intentionally absent.

Each physical generation attempt calls only unary `models.generateContent` with
one requested candidate and SDK automatic function calling disabled. The adapter
waits for the complete body, returns the first candidate's non-thinking text,
maps the finish reason, and reports prompt, candidate, total, cached-input, and
reasoning token counts when Gemini supplies them. It never calls
`generateContentStream`, adds `alt=sse`, or consumes SSE. Empty candidates,
safety blocks, malformed payloads, non-2xx responses, timeouts, transport
failures, and provider-reported cancellation cross the public boundary only as
typed, sanitized adapter failures.

When FeedbackTools are selected, their portable closed input schemas are compiled
to Gemini function declarations with `AUTO` function calling while SDK automatic
execution remains disabled. A response containing one or more function calls is
returned as one ordered provider-neutral `ToolCallBatch`; temporary response text
is not exposed as sendable output, and the adapter never executes a tool itself.

The batch carries only an opaque, redacted, in-memory continuation handle. The
adapter keeps the original model content and every Part, including opaque thought
signatures, inside its scoped continuation state. One matching `continue` call
orders results by call ID, wraps arbitrary JSON success values and safe failures,
and sends the original conversation, original model parts, and function responses
to the same model with function calling set to `NONE`. Success, failure, timeout,
caller cancellation, turn-scope closure, or adapter disposal consumes the handle;
repeated, concurrent, expired, or foreign consumption fails before a provider
request. A second provider function call is a typed protocol violation, so the
adapter can never create a third logical generation step. Final XML is returned
as opaque text without parsing or normalization.

The single model selection belongs to the Yokai host plugin, not this adapter.
Endpoint failover always keeps the same provider model and never changes the
host's selected model. API keys are converted to non-encodable
redacted values before clients are constructed.

The adapter emits separate metrics for logical invocations, physical endpoint
attempts, durations, and reported token usage. Structured logs are built from a
safe field allowlist containing only adapter/model IDs, operation, status,
duration, and numeric usage. Generation failover emits a constant warning because
the abandoned request may still complete and cause duplicate generation or billing;
keys, continuation handles, prompts, replies, SDK errors, and provider messages are
never logged.
