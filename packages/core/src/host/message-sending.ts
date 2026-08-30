import type { RoleResponseEnvelope } from '@yokai-internal/mind'
import { Duration, Effect } from 'effect'

import { WakeProposal } from '../wake/index'
import { HostSession } from './session'
import { MessagePacing } from './message-pacing'

export interface Input {
  readonly kind: WakeProposal.Kind
  readonly messages: ReadonlyArray<RoleResponseEnvelope.ResponseMessage>
  readonly sendText: HostSession.SendText
}

export interface Report {
  readonly sentSegments: number
  readonly artificialWaitMs: WakeProposal.DurationMilliseconds
}

const wait = (duration: WakeProposal.DurationMilliseconds): Effect.Effect<void> =>
  duration === 0 ? Effect.void : Effect.sleep(Duration.millis(duration))

/** Send validated segments one at a time; a failed send prevents every later segment. */
export const send = Effect.fn('MessageSending.send')(function* (input: Input) {
  const pacing = MessagePacing.plan(input.kind, input.messages)
  if (input.messages.length === 0) {
    return {
      sentSegments: 0,
      artificialWaitMs: WakeProposal.DurationMilliseconds.make(0),
    } satisfies Report
  }

  for (let index = 0; index < input.messages.length; index += 1) {
    const message = input.messages[index]
    if (message === undefined) continue
    const delay = index === 0 ? pacing.firstDelayMs : pacing.betweenDelayMs[index - 1]
    if (delay !== undefined) {
      yield* wait(delay)
    }
    yield* input.sendText(message.content, message.quote).pipe(Effect.asVoid)
  }

  return {
    sentSegments: input.messages.length,
    artificialWaitMs: pacing.totalDelayMs,
  } satisfies Report
})

export * as MessageSending from './message-sending'
