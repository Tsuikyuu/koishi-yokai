import type { AdapterModelSnapshot, YokaiAdapter } from '../llm-adapter/index'
import type {
  ActionTool,
  ContextProvider,
  FeedbackTool,
  McpServer,
  PresetSource,
  ResponseMechanism,
  Skill,
} from './capability'

/** A registration remains explicitly disposable even though its owner is auto-unregistered. */
export interface CapabilityRegistration {
  readonly unregister: () => Promise<boolean>
}

export interface AdapterRegistration extends CapabilityRegistration {
  /** Returns false after this adapter registration has been unregistered. */
  readonly publishModels: (snapshot: AdapterModelSnapshot) => Promise<boolean>
}

/** Provider-neutral public surface exposed by the host as `ctx.yokai`. */
export interface YokaiCapabilityHost {
  readonly registerAdapter: (adapter: YokaiAdapter) => Promise<AdapterRegistration>
  readonly registerContextProvider: (capability: ContextProvider) => Promise<CapabilityRegistration>
  readonly registerActionTool: (capability: ActionTool) => Promise<CapabilityRegistration>
  readonly registerFeedbackTool: (capability: FeedbackTool) => Promise<CapabilityRegistration>
  readonly registerSkill: (capability: Skill) => Promise<CapabilityRegistration>
  readonly registerMcpServer: (capability: McpServer) => Promise<CapabilityRegistration>
  readonly registerPresetSource: (capability: PresetSource) => Promise<CapabilityRegistration>
  readonly registerResponseMechanism: (
    capability: ResponseMechanism,
  ) => Promise<CapabilityRegistration>
}
