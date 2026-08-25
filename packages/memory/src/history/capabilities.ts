import { HistoryContextProvider } from './context-provider'
import { HistorySearchFeedbackTool } from './feedback-tool'

export const makeContextProvider = HistoryContextProvider.make
export const makeFeedbackTool = HistorySearchFeedbackTool.make

export * as HistoryCapabilities from './capabilities'
