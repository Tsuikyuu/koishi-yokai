import {
  ActionToolExecutionError,
  CapabilityDurationMilliseconds,
  CapabilityProtocolVersion,
  type ActionToolId,
  type CapabilityScope,
} from 'yokai-protocol'
import { Effect, Option, Schema } from 'effect'

import { MessageArchiveEvent } from '@yokai-internal/memory'
import { RepeatEveryMilliseconds, type RepeatEveryMinutes } from '../model'

export const VERSION = CapabilityProtocolVersion.make({ major: 0, minor: 1 })
export const MAX_DURATION_MS = CapabilityDurationMilliseconds.make(1_000)

export const decodeScope = Schema.decodeUnknownEffect(MessageArchiveEvent.ChannelScope)

export const executionError = (toolId: ActionToolId) =>
  new ActionToolExecutionError({ toolId, reason: 'execution-failed' })

export const repeatMilliseconds = (
  minutes: RepeatEveryMinutes | undefined,
): Option.Option<RepeatEveryMilliseconds> =>
  minutes === undefined
    ? Option.none()
    : Option.some(RepeatEveryMilliseconds.make(minutes * 60_000))

export const strictScope = (instanceId: string, requestedInstanceId: string): boolean =>
  instanceId === requestedInstanceId

export const decodeActionScope = (scope: CapabilityScope, toolId: ActionToolId) =>
  decodeScope(scope).pipe(Effect.mapError(() => executionError(toolId)))
