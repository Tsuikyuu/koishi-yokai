import type { ActionTool, ContextProvider } from 'yokai-protocol'

import { NotebookWriteActionTool } from './action-tool'
import { NotebookContextProvider } from './context-provider'
import type { NotesPerReply } from './model'
import type { Notebook } from './notebook'

export interface Options {
  readonly instanceId: string
  readonly maxNotesPerReply: NotesPerReply
}

export const makeActionTool = (notebook: Notebook.Interface, options: Options): ActionTool =>
  NotebookWriteActionTool.make(notebook, options.instanceId, options.maxNotesPerReply)

export const makeContextProvider = (
  notebook: Notebook.Interface,
  options: Options,
): ContextProvider => NotebookContextProvider.make(notebook, options.instanceId)

export * as NotebookCapabilities from './capabilities'
