import type { RoleResponseEnvelope } from '@yokai-internal/mind'

import { WakeProposal } from '../wake/index'

const FIRST_BASE_MILLISECONDS: Readonly<Record<WakeProposal.Kind, number>> = {
  direct: 40,
  activity: 120,
  engagement: 80,
  schedule: 60,
  initiative: 160,
}

const countCharacters = (content: string): number => Array.from(content).length

const firstDelay = (kind: WakeProposal.Kind, content: string): WakeProposal.DurationMilliseconds =>
  WakeProposal.DurationMilliseconds.make(
    FIRST_BASE_MILLISECONDS[kind] + Math.min(240, countCharacters(content) * 3),
  )

const betweenDelay = (
  previous: RoleResponseEnvelope.ResponseMessage,
  next: RoleResponseEnvelope.ResponseMessage,
): WakeProposal.DurationMilliseconds =>
  WakeProposal.DurationMilliseconds.make(
    70 + Math.min(260, countCharacters(previous.content) * 2 + countCharacters(next.content)),
  )

export interface Plan {
  readonly firstDelayMs: WakeProposal.DurationMilliseconds
  readonly betweenDelayMs: ReadonlyArray<WakeProposal.DurationMilliseconds>
  readonly totalDelayMs: WakeProposal.DurationMilliseconds
}

export const plan = (
  kind: WakeProposal.Kind,
  messages: ReadonlyArray<RoleResponseEnvelope.ResponseMessage>,
): Plan => {
  const first = messages[0]
  if (first === undefined) {
    return {
      firstDelayMs: WakeProposal.DurationMilliseconds.make(0),
      betweenDelayMs: [],
      totalDelayMs: WakeProposal.DurationMilliseconds.make(0),
    }
  }

  const firstDelayMs = firstDelay(kind, first.content)
  const betweenDelayMs = messages.slice(1).map((message, index) => {
    const previous = messages[index]
    return previous === undefined
      ? WakeProposal.DurationMilliseconds.make(0)
      : betweenDelay(previous, message)
  })
  return {
    firstDelayMs,
    betweenDelayMs,
    totalDelayMs: WakeProposal.DurationMilliseconds.make(
      firstDelayMs + betweenDelayMs.reduce((total, delay) => total + delay, 0),
    ),
  }
}

export * as MessagePacing from './message-pacing'
