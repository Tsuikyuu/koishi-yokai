import { MinimalResponseEnvelope } from '@yokai-internal/mind'
import {
  ContextProviderRequest,
  GenerateRequest,
  HISTORY_CONTEXT_PROVIDER_ID,
  HISTORY_SEARCH_FEEDBACK_TOOL_ID,
  TokenLimit,
  UserMessage,
  type CapabilityScope,
  type ContextFragment,
  type ContextProvider,
  type FeedbackTool,
  type FocusMessage,
} from 'yokai-protocol'
import { Effect, Option, Schema } from 'effect'

import { CapabilityRegistry } from '../capability-registry/index'
import { ChannelMessageBuffer, TurnSnapshot } from '../turn-context/index'
import type { WakeArbiter } from '../wake/index'
import { FeedbackGeneration } from './feedback-generation'
import { HostConfiguration } from './configuration'
import { HostModelSelection } from './model-selection'
import { HostSession } from './session'

const MAX_OUTPUT_TOKENS = TokenLimit.make(1024)
const HISTORY_CONTEXT_TOKENS = TokenLimit.make(2_048)
const MAX_FEEDBACK_CALLS = 4
const MAX_FEEDBACK_RESULT_TOKENS = 8_192

export class UnexpectedGenerationResultError extends Schema.TaggedError<UnexpectedGenerationResultError>(
  '@yokai/core/WakeTurn.UnexpectedGenerationResultError',
)('WakeTurnUnexpectedGenerationResultError', {}) {}

export interface Input {
  readonly scope: CapabilityScope
  readonly focus: FocusMessage
  readonly markDispatched: WakeArbiter.MarkDispatched
  readonly sendText: (
    content: string,
  ) => Effect.Effect<ReadonlyArray<string>, HostSession.SendError>
}

const historyContext = Effect.fn('WakeTurn.historyContext')(function* (
  provider: ContextProvider | undefined,
  input: Input,
) {
  if (provider === undefined) return Option.none<ContextFragment>()
  return yield* provider
    .provide(
      ContextProviderRequest.make({
        scope: input.scope,
        focus: input.focus,
        tokenBudget: HISTORY_CONTEXT_TOKENS,
      }),
    )
    .pipe(Effect.catch(() => Effect.succeed(Option.none<ContextFragment>())))
})

const requestMessages = (
  snapshot: TurnSnapshot.Snapshot,
  context: Option.Option<ContextFragment>,
): readonly [UserMessage, ...UserMessage[]] => {
  const history = Option.match(context, {
    onNone: () => [] as const,
    onSome: (fragment) => [UserMessage.make({ role: 'user', content: fragment.content })] as const,
  })
  const recent = Option.match(TurnSnapshot.renderRecentMessages(snapshot), {
    onNone: () => [] as const,
    onSome: (content) => [UserMessage.make({ role: 'user', content })] as const,
  })
  const contextMessages: ReadonlyArray<UserMessage> = [...history, ...recent]
  const focus = UserMessage.make({ role: 'user', content: snapshot.focus.content })
  const first = contextMessages[0]
  return first === undefined ? [focus] : [first, ...contextMessages.slice(1), focus]
}

const removeFullyBufferedHistory = (
  context: Option.Option<ContextFragment>,
  snapshot: TurnSnapshot.Snapshot,
): Option.Option<ContextFragment> => {
  const recentIds = snapshot.recentMessages.map((message) => message.messageId)
  return Option.filter(
    context,
    (fragment) =>
      fragment.sourceRefs.length === 0 ||
      fragment.sourceRefs.some((sourceRef) => !recentIds.includes(sourceRef)),
  )
}

const selectedFeedbackTools = (
  enabled: boolean,
  adapterSupportsTools: boolean,
  tools: ReadonlyArray<FeedbackTool>,
): ReadonlyArray<FeedbackTool> =>
  enabled && adapterSupportsTools
    ? tools.filter((tool) => tool.id === HISTORY_SEARCH_FEEDBACK_TOOL_ID)
    : []

export const run = Effect.fn('WakeTurn.run')(function* (input: Input) {
  const configuration = yield* HostConfiguration.Service
  const registry = yield* CapabilityRegistry.Service
  const channelBuffer = yield* ChannelMessageBuffer.Service
  const turnSnapshot = yield* channelBuffer.snapshot(
    TurnSnapshot.Request.make({
      scope: input.scope,
      focus: input.focus,
      messageCount: TurnSnapshot.defaultMessageCount(),
      tokenBudget: TurnSnapshot.DEFAULT_TOKEN_BUDGET,
    }),
  )
  const capabilitySnapshot = yield* registry.snapshot()
  const provider = capabilitySnapshot.contextProviders.find(
    (candidate) => candidate.id === HISTORY_CONTEXT_PROVIDER_ID,
  )
  const context = removeFullyBufferedHistory(yield* historyContext(provider, input), turnSnapshot)
  const messages = requestMessages(turnSnapshot, context)
  const selected = yield* HostModelSelection.resolve()
  const feedbackTools = selectedFeedbackTools(
    configuration.feedbackToolsEnabled,
    selected.adapter.descriptor.capabilities.feedbackTools,
    capabilitySnapshot.feedbackTools,
  )
  const request = GenerateRequest.make({
    modelId: selected.reference.modelId,
    systemInstruction: MinimalResponseEnvelope.SYSTEM_INSTRUCTION,
    messages,
    limits: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    feedbackTools: feedbackTools.map((tool) => ({
      id: tool.id,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  })

  yield* input.markDispatched()
  const result =
    feedbackTools.length === 0
      ? yield* selected.adapter
          .generate(request)
          .pipe(
            Effect.flatMap((initial) =>
              initial._tag === 'Text'
                ? Effect.succeed(initial)
                : Effect.fail(new UnexpectedGenerationResultError({})),
            ),
          )
      : yield* FeedbackGeneration.run({
          adapter: selected.adapter,
          request,
          scope: input.scope,
          tools: feedbackTools,
          budget: {
            maxCalls: MAX_FEEDBACK_CALLS,
            maxResultTokens: MAX_FEEDBACK_RESULT_TOKENS,
          },
        })

  const decision = yield* MinimalResponseEnvelope.parse(result.text)
  if (decision._tag === 'Silence') return
  yield* input.sendText(decision.message).pipe(Effect.asVoid)
})

export * as WakeTurn from './wake-turn'
