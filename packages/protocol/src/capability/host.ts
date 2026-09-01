import type { AdapterId, AdapterModelSnapshot, YokaiAdapter } from '../llm-adapter/index'
import type {
  ActionTool,
  ContextProvider,
  FeedbackTool,
  McpServer,
  McpServerSnapshot,
  PresetSource,
  ResponseMechanism,
  Skill,
} from './capability'
import type { ModelCatalogSnapshot } from './model-catalog'
import type { PresetCandidate, PresetId, PresetSnapshot } from './preset'

/** A registration remains explicitly disposable even though its owner is auto-unregistered. */
export interface CapabilityRegistration {
  readonly unregister: () => Promise<boolean>
}

export interface AdapterRegistration extends CapabilityRegistration {
  /** Returns false after this adapter registration has been unregistered. */
  readonly publishModels: (snapshot: AdapterModelSnapshot) => Promise<boolean>
}

export interface McpServerRegistration extends CapabilityRegistration {
  /** Returns false when this registration or snapshot revision is stale. */
  readonly publishSnapshot: (snapshot: McpServerSnapshot) => Promise<boolean>
}

export interface PresetRegistration extends CapabilityRegistration {
  /** Returns false when the content hash is unchanged or this registration is stale. */
  readonly publish: (candidate: PresetCandidate) => Promise<boolean>
}

/** Provider-neutral public surface exposed by the host as `ctx.yokai`. */
export interface YokaiCapabilityHost {
  readonly registerAdapter: (adapter: YokaiAdapter) => Promise<AdapterRegistration>
  readonly registerContextProvider: (capability: ContextProvider) => Promise<CapabilityRegistration>
  readonly registerActionTool: (capability: ActionTool) => Promise<CapabilityRegistration>
  readonly registerFeedbackTool: (capability: FeedbackTool) => Promise<CapabilityRegistration>
  readonly registerSkill: (capability: Skill) => Promise<CapabilityRegistration>
  readonly registerMcpServer: (capability: McpServer) => Promise<McpServerRegistration>
  readonly registerPresetSource: (capability: PresetSource) => Promise<PresetRegistration>
  readonly registerResponseMechanism: (
    capability: ResponseMechanism,
  ) => Promise<CapabilityRegistration>
  readonly getModelCatalog: () => Promise<ModelCatalogSnapshot>
  readonly getPresetSnapshot: (presetId: PresetId) => Promise<PresetSnapshot | undefined>
  readonly refreshModels: (adapterId?: AdapterId) => Promise<number>
}
