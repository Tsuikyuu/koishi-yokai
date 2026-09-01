import { RoleResponseEnvelope } from '@yokai-internal/mind'
import {
  ActionToolId,
  FeedbackToolId,
  McpServerId,
  SkillId,
  type ActionTool,
  type CapabilityEventKind,
  type CapabilityScope,
  type ContextProvider,
  type FeedbackTool,
  type FocusMessage,
  type PresetSnapshot,
  type ResponseMechanismId,
  type Skill,
} from 'yokai-protocol'
import { Option, Schema } from 'effect'

export const MAX_CONFIGURED_CAPABILITIES_PER_DOMAIN = 64
export const MAX_SELECTED_SKILLS = 4
export const MAX_SELECTED_ACTION_TOOLS = RoleResponseEnvelope.MAX_VISIBLE_ACTION_TOOLS
export const MAX_SELECTED_FEEDBACK_TOOLS = 16
export const MAX_SKILL_SYSTEM_INSTRUCTION_BYTES = 16_384

const SkillVisibility = Schema.Array(SkillId).check(
  Schema.isMaxLength(MAX_CONFIGURED_CAPABILITIES_PER_DOMAIN),
  Schema.isUnique(),
)

const ActionToolVisibility = Schema.Array(ActionToolId).check(
  Schema.isMaxLength(MAX_CONFIGURED_CAPABILITIES_PER_DOMAIN),
  Schema.isUnique(),
)

const FeedbackToolVisibility = Schema.Array(FeedbackToolId).check(
  Schema.isMaxLength(MAX_CONFIGURED_CAPABILITIES_PER_DOMAIN),
  Schema.isUnique(),
)

const McpServerVisibility = Schema.Array(McpServerId).check(
  Schema.isMaxLength(MAX_CONFIGURED_CAPABILITIES_PER_DOMAIN),
  Schema.isUnique(),
)

export const Visibility = Schema.Struct({
  skills: SkillVisibility,
  actionTools: ActionToolVisibility,
  feedbackTools: FeedbackToolVisibility,
  mcpServers: McpServerVisibility,
})

export interface Visibility extends Schema.Schema.Type<typeof Visibility> {}

export interface McpProjectionSource {
  readonly serverId: McpServerId
  readonly actionToolIds: ReadonlyArray<ActionToolId>
  readonly feedbackToolIds: ReadonlyArray<FeedbackToolId>
}

export interface CapabilitySnapshot {
  readonly contextProviders: ReadonlyArray<ContextProvider>
  readonly actionTools: ReadonlyArray<ActionTool>
  readonly feedbackTools: ReadonlyArray<FeedbackTool>
  readonly skills: ReadonlyArray<Skill>
  readonly mcpProjectionSources: ReadonlyArray<McpProjectionSource>
}

export interface Input {
  readonly capabilities: CapabilitySnapshot
  readonly visibility: Visibility
  readonly preset: Option.Option<PresetSnapshot>
  readonly scope: CapabilityScope
  readonly focus: FocusMessage
  readonly eventKind: CapabilityEventKind
  readonly responseMechanisms: ReadonlyArray<ResponseMechanismId>
}

export interface Selection {
  readonly skills: ReadonlyArray<Skill>
  readonly contextProviders: ReadonlyArray<ContextProvider>
  readonly actionTools: ReadonlyArray<ActionTool>
  readonly feedbackTools: ReadonlyArray<FeedbackTool>
  readonly skillSystemInstruction: string
}

const unique = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> =>
  values.filter((value, index) => values.indexOf(value) === index)

const keywordMatches = (content: string, keywords: ReadonlyArray<string>): boolean => {
  const normalized = content.toLowerCase()
  return keywords.some((keyword) => normalized.includes(keyword.toLowerCase()))
}

const responseMechanismMatches = (
  current: ReadonlyArray<ResponseMechanismId>,
  configured: ReadonlyArray<ResponseMechanismId>,
): boolean => configured.some((mechanismId) => current.includes(mechanismId))

const skillMatches = (
  skill: Skill,
  focus: FocusMessage,
  eventKind: CapabilityEventKind,
  responseMechanisms: ReadonlyArray<ResponseMechanismId>,
): boolean =>
  skill.selection._tag === 'Always' ||
  keywordMatches(focus.content, skill.selection.keywords) ||
  responseMechanismMatches(responseMechanisms, skill.selection.responseMechanisms) ||
  skill.selection.eventKinds.includes(eventKind)

const renderSkill = (skill: Skill): string =>
  [`[Trusted local Skill ${skill.id}]`, skill.prompt, `[End Skill ${skill.id}]`].join('\n')

export const renderSkills = (skills: ReadonlyArray<Skill>): string =>
  skills.length === 0
    ? ''
    : [
        '[Selected trusted local Skills.]',
        ...skills.map(renderSkill),
        '[End selected trusted local Skills.]',
      ].join('\n')

const boundedSkills = (skills: ReadonlyArray<Skill>): ReadonlyArray<Skill> =>
  skills.reduce<ReadonlyArray<Skill>>((selected, skill) => {
    if (selected.length >= MAX_SELECTED_SKILLS) return selected
    const next = [...selected, skill]
    return Buffer.byteLength(renderSkills(next), 'utf8') <= MAX_SKILL_SYSTEM_INSTRUCTION_BYTES
      ? next
      : selected
  }, [])

const selectSkills = (
  capabilities: ReadonlyArray<Skill>,
  visibility: ReadonlyArray<SkillId>,
  preset: Option.Option<PresetSnapshot>,
  focus: FocusMessage,
  eventKind: CapabilityEventKind,
  responseMechanisms: ReadonlyArray<ResponseMechanismId>,
): ReadonlyArray<Skill> => {
  const roleSkillIds = Option.match(preset, {
    onNone: () => visibility,
    onSome: (snapshot) => snapshot.skills,
  })
  const candidates = visibility.flatMap((skillId) => {
    if (!roleSkillIds.includes(skillId)) return []
    const skill = capabilities.find((candidate) => candidate.id === skillId)
    return skill === undefined ? [] : [skill]
  })
  return boundedSkills(
    candidates.filter((skill) => skillMatches(skill, focus, eventKind, responseMechanisms)),
  )
}

const providerMatches = (
  provider: ContextProvider,
  selectedSkillIds: ReadonlyArray<SkillId>,
  selectedSkillProviderIds: ReadonlyArray<ContextProvider['id']>,
  focus: FocusMessage,
  responseMechanisms: ReadonlyArray<ResponseMechanismId>,
): boolean =>
  provider.selection._tag === 'Always' ||
  selectedSkillProviderIds.includes(provider.id) ||
  keywordMatches(focus.content, provider.selection.keywords) ||
  responseMechanismMatches(responseMechanisms, provider.selection.responseMechanisms) ||
  provider.selection.skills.some((skillId) => selectedSkillIds.includes(skillId))

const mcpServerForActionTool = (
  sources: ReadonlyArray<McpProjectionSource>,
  toolId: ActionToolId,
): McpServerId | undefined => {
  const source = sources.find((candidate) => candidate.actionToolIds.includes(toolId))
  return source === undefined ? undefined : source.serverId
}

const mcpServerForFeedbackTool = (
  sources: ReadonlyArray<McpProjectionSource>,
  toolId: FeedbackToolId,
): McpServerId | undefined => {
  const source = sources.find((candidate) => candidate.feedbackToolIds.includes(toolId))
  return source === undefined ? undefined : source.serverId
}

const mcpServerVisible = (
  serverId: McpServerId | undefined,
  visibility: ReadonlyArray<McpServerId>,
): boolean => serverId === undefined || visibility.includes(serverId)

const requestedActionToolIds = (
  visibility: ReadonlyArray<ActionToolId>,
  preset: Option.Option<PresetSnapshot>,
  skills: ReadonlyArray<Skill>,
): ReadonlyArray<ActionToolId> =>
  Option.match(preset, {
    onNone: () => visibility,
    onSome: (snapshot) =>
      unique([...snapshot.actionTools, ...skills.flatMap((skill) => skill.actionTools)]),
  })

const requestedFeedbackToolIds = (
  visibility: ReadonlyArray<FeedbackToolId>,
  preset: Option.Option<PresetSnapshot>,
  skills: ReadonlyArray<Skill>,
): ReadonlyArray<FeedbackToolId> =>
  Option.match(preset, {
    onNone: () => visibility,
    onSome: (snapshot) =>
      unique([...snapshot.feedbackTools, ...skills.flatMap((skill) => skill.feedbackTools)]),
  })

export const select = (input: Input): Selection => {
  const skills = selectSkills(
    input.capabilities.skills,
    input.visibility.skills,
    input.preset,
    input.focus,
    input.eventKind,
    input.responseMechanisms,
  )
  const selectedSkillIds = skills.map((skill) => skill.id)
  const selectedSkillProviderIds = unique(skills.flatMap((skill) => skill.contextProviders))
  const contextProviders = input.capabilities.contextProviders.filter((provider) =>
    providerMatches(
      provider,
      selectedSkillIds,
      selectedSkillProviderIds,
      input.focus,
      input.responseMechanisms,
    ),
  )
  const requestedActions = requestedActionToolIds(
    input.visibility.actionTools,
    input.preset,
    skills,
  )
  const actionTools = input.visibility.actionTools.flatMap((toolId) => {
    if (!requestedActions.includes(toolId)) return []
    const tool = input.capabilities.actionTools.find((candidate) => candidate.id === toolId)
    if (tool === undefined) return []
    const serverId = mcpServerForActionTool(input.capabilities.mcpProjectionSources, tool.id)
    return mcpServerVisible(serverId, input.visibility.mcpServers) ? [tool] : []
  })
  const requestedFeedback = requestedFeedbackToolIds(
    input.visibility.feedbackTools,
    input.preset,
    skills,
  )
  const feedbackTools = input.visibility.feedbackTools.flatMap((toolId) => {
    if (!requestedFeedback.includes(toolId)) return []
    const tool = input.capabilities.feedbackTools.find((candidate) => candidate.id === toolId)
    if (tool === undefined) return []
    const serverId = mcpServerForFeedbackTool(input.capabilities.mcpProjectionSources, tool.id)
    return mcpServerVisible(serverId, input.visibility.mcpServers) ? [tool] : []
  })

  return {
    skills,
    contextProviders,
    actionTools,
    feedbackTools,
    skillSystemInstruction: renderSkills(skills),
  }
}

export * as CapabilitySelection from './selection'
