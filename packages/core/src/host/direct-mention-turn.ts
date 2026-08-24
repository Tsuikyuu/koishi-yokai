import { MinimalResponseEnvelope } from '@yokai-internal/mind'
import { GenerateRequest, TokenLimit, UserMessage } from 'yokai-protocol'
import { Effect, Option, Schema } from 'effect'

import { HostModelSelection } from './model-selection'
import { HostSession } from './session'

const MAX_OUTPUT_TOKENS = TokenLimit.make(1024)

export class MissingMessageError extends Schema.TaggedError<MissingMessageError>(
  '@yokai/core/DirectMentionTurn.MissingMessageError',
)('DirectMentionTurnMissingMessageError', {}) {}

export class UnexpectedGenerationResultError extends Schema.TaggedError<UnexpectedGenerationResultError>(
  '@yokai/core/DirectMentionTurn.UnexpectedGenerationResultError',
)('DirectMentionTurnUnexpectedGenerationResultError', {}) {}

const freezeMessages = Effect.fn('DirectMentionTurn.freezeMessages')(function* () {
  const session = yield* HostSession.Service
  const content = yield* Option.match(session.content, {
    onNone: () => Effect.fail(new MissingMessageError({})),
    onSome: (value) => {
      const trimmed = value.trim()
      return trimmed.length === 0
        ? Effect.fail(new MissingMessageError({}))
        : Effect.succeed(trimmed)
    },
  })
  return [UserMessage.make({ role: 'user', content })] as const
})

export const run = Effect.fn('DirectMentionTurn.run')(function* () {
  const session = yield* HostSession.Service
  const messages = yield* freezeMessages()
  const selected = yield* HostModelSelection.resolve()
  const request = GenerateRequest.make({
    modelId: selected.reference.modelId,
    systemInstruction: MinimalResponseEnvelope.SYSTEM_INSTRUCTION,
    messages,
    limits: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    feedbackTools: [],
  })
  const result = yield* selected.adapter.generate(request)
  if (result._tag !== 'Text') {
    return yield* Effect.fail(new UnexpectedGenerationResultError({}))
  }

  const decision = yield* MinimalResponseEnvelope.parse(result.text)
  if (decision._tag === 'Silence') return
  yield* session.sendText(decision.message).pipe(Effect.asVoid)
})

export * as DirectMentionTurn from './direct-mention-turn'
