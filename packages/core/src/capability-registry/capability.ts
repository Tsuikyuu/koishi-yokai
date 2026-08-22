import { Schema } from 'effect'

import { FeedbackToolId } from '@yokai/protocol'

const capabilityIdChecks = [
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9._-]*$/),
] as const

export const ContextProviderId = Schema.String.check(...capabilityIdChecks).pipe(
  Schema.brand('@yokai/core/ContextProviderId'),
)

export type ContextProviderId = typeof ContextProviderId.Type

export const ActionToolId = Schema.String.check(...capabilityIdChecks).pipe(
  Schema.brand('@yokai/core/ActionToolId'),
)

export type ActionToolId = typeof ActionToolId.Type

export const SkillId = Schema.String.check(...capabilityIdChecks).pipe(
  Schema.brand('@yokai/core/SkillId'),
)

export type SkillId = typeof SkillId.Type

export const McpServerId = Schema.String.check(...capabilityIdChecks).pipe(
  Schema.brand('@yokai/core/McpServerId'),
)

export type McpServerId = typeof McpServerId.Type

export const PresetSourceId = Schema.String.check(...capabilityIdChecks).pipe(
  Schema.brand('@yokai/core/PresetSourceId'),
)

export type PresetSourceId = typeof PresetSourceId.Type

export const ResponseMechanismId = Schema.String.check(...capabilityIdChecks).pipe(
  Schema.brand('@yokai/core/ResponseMechanismId'),
)

export type ResponseMechanismId = typeof ResponseMechanismId.Type

export const CapabilityProtocolVersion = Schema.Struct({
  major: Schema.Natural,
  minor: Schema.Natural,
})

export interface CapabilityProtocolVersion extends Schema.Schema.Type<
  typeof CapabilityProtocolVersion
> {}

/**
 * YK-009 fixes capability identity and lifecycle. Later implementation tasks
 * add the operation contracts owned by each capability kind.
 */
export const ContextProvider = Schema.Struct({
  id: ContextProviderId,
  protocolVersion: CapabilityProtocolVersion,
})

export interface ContextProvider extends Schema.Schema.Type<typeof ContextProvider> {}

export const ActionTool = Schema.Struct({
  id: ActionToolId,
  protocolVersion: CapabilityProtocolVersion,
})

export interface ActionTool extends Schema.Schema.Type<typeof ActionTool> {}

export const FeedbackTool = Schema.Struct({
  id: FeedbackToolId,
  protocolVersion: CapabilityProtocolVersion,
})

export interface FeedbackTool extends Schema.Schema.Type<typeof FeedbackTool> {}

export const Skill = Schema.Struct({
  id: SkillId,
  protocolVersion: CapabilityProtocolVersion,
})

export interface Skill extends Schema.Schema.Type<typeof Skill> {}

export const McpServer = Schema.Struct({
  id: McpServerId,
  protocolVersion: CapabilityProtocolVersion,
})

export interface McpServer extends Schema.Schema.Type<typeof McpServer> {}

export const PresetSource = Schema.Struct({
  id: PresetSourceId,
  protocolVersion: CapabilityProtocolVersion,
})

export interface PresetSource extends Schema.Schema.Type<typeof PresetSource> {}

export const ResponseMechanism = Schema.Struct({
  id: ResponseMechanismId,
  protocolVersion: CapabilityProtocolVersion,
})

export interface ResponseMechanism extends Schema.Schema.Type<typeof ResponseMechanism> {}
