import type { RoleResponseEnvelope } from '@yokai-internal/mind'
import { ActionToolRequest, type CapabilityScope } from 'yokai-protocol'
import { Cause, Duration, Effect } from 'effect'

import { BackgroundTasks } from './background-tasks'

export const BEFORE_SEND_TOTAL_DEADLINE_MS = 750

interface Outcome {
  readonly action: RoleResponseEnvelope.ParsedAction
  readonly succeeded: boolean
}

export interface BeforeSendReport {
  readonly attempted: number
  readonly failed: number
  readonly blockReply: boolean
}

const actionFailure = (action: RoleResponseEnvelope.ParsedAction): Effect.Effect<boolean> =>
  Effect.logWarning('ActionExecution.action_failed').pipe(
    Effect.annotateLogs({
      toolId: action.tool.id,
      executionStage: action.tool.executionStage,
    }),
    Effect.as(false),
  )

const execute = Effect.fn('ActionExecution.execute')(function* (
  action: RoleResponseEnvelope.ParsedAction,
  scope: CapabilityScope,
  timeoutMs: number,
) {
  return yield* Effect.suspend(() =>
    action.tool.execute(ActionToolRequest.make({ scope, input: action.input })),
  ).pipe(
    Effect.timeout(Duration.millis(timeoutMs)),
    Effect.as(true),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) ? Effect.interrupt : actionFailure(action),
    ),
  )
})

const executeBackground = (
  action: RoleResponseEnvelope.ParsedAction,
  scope: CapabilityScope,
): Effect.Effect<boolean> => execute(action, scope, action.tool.maxDurationMs)

export const runBeforeSend = Effect.fn('ActionExecution.runBeforeSend')(function* (
  actions: ReadonlyArray<RoleResponseEnvelope.ParsedAction>,
  scope: CapabilityScope,
) {
  const selected = actions.filter((action) => action.tool.executionStage === 'before-send')
  const outcomes = yield* Effect.forEach(
    selected,
    (action) =>
      execute(
        action,
        scope,
        Math.min(action.tool.maxDurationMs, BEFORE_SEND_TOTAL_DEADLINE_MS),
      ).pipe(Effect.map((succeeded) => ({ action, succeeded }) satisfies Outcome)),
    { concurrency: 'unbounded' },
  )
  const failures = outcomes.filter((outcome) => !outcome.succeeded)
  return {
    attempted: outcomes.length,
    failed: failures.length,
    blockReply: failures.some((outcome) => outcome.action.tool.failurePolicy === 'block-reply'),
  } satisfies BeforeSendReport
})

export const scheduleAfterSend = Effect.fn('ActionExecution.scheduleAfterSend')(function* (
  actions: ReadonlyArray<RoleResponseEnvelope.ParsedAction>,
  scope: CapabilityScope,
) {
  const selected = actions.filter((action) => action.tool.executionStage === 'after-send')
  if (selected.length === 0) return

  const background = yield* BackgroundTasks.Service
  yield* background.fork(
    Effect.forEach(selected, (action) => executeBackground(action, scope), {
      concurrency: 'unbounded',
      discard: true,
    }),
  )
})

export const scheduleDeferred = Effect.fn('ActionExecution.scheduleDeferred')(function* <R>(
  actions: ReadonlyArray<RoleResponseEnvelope.ParsedAction>,
  scope: CapabilityScope,
  onWake: () => Effect.Effect<void, never, R>,
) {
  const selected = actions.filter((action) => action.tool.executionStage === 'deferred')
  if (selected.length === 0) return

  const background = yield* BackgroundTasks.Service
  yield* background.fork(
    Effect.gen(function* () {
      const outcomes = yield* Effect.forEach(
        selected,
        (action) =>
          executeBackground(action, scope).pipe(
            Effect.map((succeeded) => ({ action, succeeded }) satisfies Outcome),
          ),
        { concurrency: 'unbounded' },
      )
      const shouldWake = outcomes.some(
        (outcome) => outcome.succeeded && outcome.action.tool.completionPolicy === 'wake',
      )
      if (shouldWake) yield* onWake()
    }),
  )
})

export * as ActionExecution from './action-execution'
