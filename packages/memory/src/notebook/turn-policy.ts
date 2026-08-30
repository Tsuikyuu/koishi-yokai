import {
  NOTEBOOK_WRITE_ACTION_TOOL_ID,
  type ActionTool,
  type ActionToolInput,
} from 'yokai-protocol'
import { Effect, Schema } from 'effect'

import { NotebookWriteActionTool } from './action-tool'

export interface Action {
  readonly tool: ActionTool
  readonly input: ActionToolInput
}

export class ProposalLimitExceededError extends Schema.TaggedError<ProposalLimitExceededError>(
  '@yokai/memory/NotebookTurnPolicy.ProposalLimitExceededError',
)('NotebookTurnProposalLimitExceededError', {}) {}

const notebookActions = (actions: ReadonlyArray<Action>): ReadonlyArray<Action> =>
  actions.filter((action) => action.tool.id === NOTEBOOK_WRITE_ACTION_TOOL_ID)

const configuredMaximum = (actions: ReadonlyArray<Action>): number => {
  const first = actions[0]
  if (first === undefined) return 0
  const notes = first.tool.inputSchema.properties.find((property) => property.name === 'notes')
  return notes !== undefined && notes.schema._tag === 'Array' ? notes.schema.maxItems : 0
}

export const validate = (
  actions: ReadonlyArray<Action>,
): Effect.Effect<void, ProposalLimitExceededError> => {
  const selected = notebookActions(actions)
  if (selected.length === 0) return Effect.void
  const proposed = selected.reduce(
    (count, action) => count + NotebookWriteActionTool.noteCount(action.input),
    0,
  )
  return proposed <= configuredMaximum(selected)
    ? Effect.void
    : Effect.fail(new ProposalLimitExceededError({}))
}

export const afterSuccessfulSend = (
  actions: ReadonlyArray<Action>,
  sentSegments: number,
): ReadonlyArray<Action> =>
  sentSegments > 0
    ? actions
    : actions.filter((action) => action.tool.id !== NOTEBOOK_WRITE_ACTION_TOOL_ID)

export * as NotebookTurnPolicy from './turn-policy'
