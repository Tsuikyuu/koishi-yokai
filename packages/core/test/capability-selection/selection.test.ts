import { expect, it } from '@effect/vitest'
import {
  ActionTool,
  ActionToolDurationMilliseconds,
  ActionToolId,
  ActionToolXmlTemplate,
  CapabilityDurationMilliseconds,
  CapabilityProtocolVersion,
  CapabilityScope,
  ContextProvider,
  ContextProviderId,
  FeedbackTool,
  FeedbackToolId,
  FocusMessage,
  LocalSelectionKeyword,
  McpServerId,
  Persona,
  PresetContentHash,
  PresetId,
  PresetLoadedAt,
  PresetSnapshot,
  PresetSourceId,
  PresetVersion,
  ResponseMechanismId,
  Skill,
  SkillId,
  TokenLimit,
} from 'yokai-protocol'
import { Effect, Option } from 'effect'

import { CapabilitySelection } from '../../src/index'

const VERSION = CapabilityProtocolVersion.make({ major: 0, minor: 1 })
const SCOPE = CapabilityScope.make({
  instanceId: 'capability-selection-test',
  platform: 'test',
  guildId: 'guild',
  channelId: 'channel',
})
const FOCUS = FocusMessage.make({
  messageId: 'focus',
  authorId: 'author',
  timestamp: 1,
  content: 'Please check my CALENDAR before replying.',
})
const DIRECT = ResponseMechanismId.make('direct')

interface SkillOptions {
  readonly id: string
  readonly prompt?: string
  readonly selection?: Skill['selection']
  readonly contextProviders?: ReadonlyArray<ContextProviderId>
  readonly actionTools?: ReadonlyArray<ActionToolId>
  readonly feedbackTools?: ReadonlyArray<FeedbackToolId>
}

const makeSkill = (options: SkillOptions): Skill =>
  Skill.make({
    id: SkillId.make(options.id),
    protocolVersion: VERSION,
    description: `Use ${options.id} capabilities.`,
    prompt: options.prompt === undefined ? `Follow ${options.id}.` : options.prompt,
    selection: options.selection === undefined ? { _tag: 'Always' } : options.selection,
    contextProviders: options.contextProviders === undefined ? [] : options.contextProviders,
    actionTools: options.actionTools === undefined ? [] : options.actionTools,
    feedbackTools: options.feedbackTools === undefined ? [] : options.feedbackTools,
  })

interface ProviderOptions {
  readonly id: string
  readonly selection?: ContextProvider['selection']
}

const makeProvider = (options: ProviderOptions): ContextProvider =>
  ContextProvider.make({
    id: ContextProviderId.make(options.id),
    protocolVersion: VERSION,
    description: `Provide ${options.id} context.`,
    maxTokens: TokenLimit.make(64),
    maxDurationMs: CapabilityDurationMilliseconds.make(100),
    selection: options.selection === undefined ? { _tag: 'Always' } : options.selection,
    isAvailable: () => true,
    provide: () => Effect.succeed(Option.none()),
  })

const makeActionTool = (id: string): ActionTool =>
  ActionTool.make({
    id: ActionToolId.make(id),
    protocolVersion: VERSION,
    description: `Run ${id}.`,
    xmlTemplate: ActionToolXmlTemplate.make(
      `<action tool="${id}"><value>XML_ESCAPED_VALUE</value></action>`,
    ),
    inputSchema: {
      _tag: 'Object',
      properties: [{ name: 'value', required: true, schema: { _tag: 'String' } }],
    },
    executionStage: 'after-send',
    completionPolicy: 'none',
    failurePolicy: 'continue',
    maxDurationMs: ActionToolDurationMilliseconds.make(100),
    isAvailable: () => true,
    isInputAllowed: () => true,
    execute: () => Effect.void,
  })

const makeFeedbackTool = (id: string): FeedbackTool =>
  FeedbackTool.make({
    id: FeedbackToolId.make(id),
    protocolVersion: VERSION,
    description: `Read ${id}.`,
    inputSchema: { _tag: 'Object', properties: [] },
    outputSchema: { _tag: 'String' },
    maxResultTokens: TokenLimit.make(64),
    maxDurationMs: CapabilityDurationMilliseconds.make(100),
    isAvailable: () => true,
    prepare: () => Effect.succeed({ execute: () => Effect.succeed('result') }),
  })

const makePreset = (
  skills: ReadonlyArray<SkillId>,
  actionTools: ReadonlyArray<ActionToolId>,
  feedbackTools: ReadonlyArray<FeedbackToolId>,
): PresetSnapshot =>
  PresetSnapshot.make({
    id: PresetId.make('test.role'),
    version: PresetVersion.make(1),
    contentHash: PresetContentHash.make('a'.repeat(64)),
    persona: Persona.make({
      name: 'Test Role',
      selfConcept: 'A test role.',
      background: 'Created for deterministic tests.',
      values: ['clarity'],
      interests: ['testing'],
      opinions: ['Local selection should be deterministic.'],
      speakingStyle: 'Concise.',
      socialBoundaries: ['Respect scope boundaries.'],
      knowledgeBoundaries: ['Admit uncertainty.'],
    }),
    skills,
    actionTools,
    feedbackTools,
    compiledPrompt: 'Test role instruction.',
    loadedAt: PresetLoadedAt.make(1),
    sourceId: PresetSourceId.make('test.source'),
    sourceAvailable: true,
  })

const emptyVisibility = (): CapabilitySelection.Visibility =>
  CapabilitySelection.Visibility.make({
    skills: [],
    actionTools: [],
    feedbackTools: [],
    mcpServers: [],
  })

it('selects Skills and ContextProviders with local data before generation', () => {
  const keywordSkill = makeSkill({
    id: 'calendar.skill',
    selection: {
      _tag: 'MatchAny',
      keywords: [LocalSelectionKeyword.make('calendar')],
      responseMechanisms: [],
      eventKinds: [],
    },
    contextProviders: [ContextProviderId.make('bundled.context')],
  })
  const mechanismSkill = makeSkill({
    id: 'direct.skill',
    selection: { _tag: 'MatchAny', keywords: [], responseMechanisms: [DIRECT], eventKinds: [] },
  })
  const eventSkill = makeSkill({
    id: 'event.skill',
    selection: {
      _tag: 'MatchAny',
      keywords: [],
      responseMechanisms: [],
      eventKinds: ['direct'],
    },
  })
  const invisibleSkill = makeSkill({ id: 'invisible.skill' })
  const providers = [
    makeProvider({ id: 'always.context' }),
    makeProvider({
      id: 'keyword.context',
      selection: {
        _tag: 'MatchAny',
        keywords: [LocalSelectionKeyword.make('calendar')],
        responseMechanisms: [],
        skills: [],
      },
    }),
    makeProvider({
      id: 'mechanism.context',
      selection: {
        _tag: 'MatchAny',
        keywords: [],
        responseMechanisms: [DIRECT],
        skills: [],
      },
    }),
    makeProvider({
      id: 'linked.context',
      selection: {
        _tag: 'MatchAny',
        keywords: [],
        responseMechanisms: [],
        skills: [keywordSkill.id],
      },
    }),
    makeProvider({
      id: 'bundled.context',
      selection: {
        _tag: 'MatchAny',
        keywords: [LocalSelectionKeyword.make('unmatched')],
        responseMechanisms: [],
        skills: [],
      },
    }),
    makeProvider({
      id: 'unmatched.context',
      selection: {
        _tag: 'MatchAny',
        keywords: [LocalSelectionKeyword.make('unmatched')],
        responseMechanisms: [],
        skills: [],
      },
    }),
  ]
  const visibility = CapabilitySelection.Visibility.make({
    ...emptyVisibility(),
    skills: [keywordSkill.id, mechanismSkill.id, eventSkill.id],
  })

  const selected = CapabilitySelection.select({
    capabilities: {
      contextProviders: providers,
      actionTools: [],
      feedbackTools: [],
      skills: [keywordSkill, mechanismSkill, eventSkill, invisibleSkill],
      mcpProjectionSources: [],
    },
    visibility,
    preset: Option.none(),
    scope: SCOPE,
    focus: FOCUS,
    eventKind: 'direct',
    responseMechanisms: [DIRECT],
  })

  expect(selected.skills.map((skill) => skill.id)).toEqual([
    keywordSkill.id,
    mechanismSkill.id,
    eventSkill.id,
  ])
  expect(selected.contextProviders.map((provider) => provider.id)).toEqual([
    'always.context',
    'keyword.context',
    'mechanism.context',
    'linked.context',
    'bundled.context',
  ])
  expect(selected.skillSystemInstruction).toContain('Follow calendar.skill.')
  expect(selected.skillSystemInstruction).toContain('Follow direct.skill.')
  expect(selected.skillSystemInstruction).toContain('Follow event.skill.')
  expect(selected.skillSystemInstruction).not.toContain('invisible.skill')
})

it('intersects preset references with hard tool and Skill allowlists', () => {
  const skillActionId = ActionToolId.make('skill.action')
  const mcpActionId = ActionToolId.make('calendar.execute')
  const presetActionId = ActionToolId.make('preset.action')
  const blockedActionId = ActionToolId.make('blocked.action')
  const skillFeedbackId = FeedbackToolId.make('skill.feedback')
  const mcpFeedbackId = FeedbackToolId.make('calendar.lookup')
  const presetFeedbackId = FeedbackToolId.make('preset.feedback')
  const blockedFeedbackId = FeedbackToolId.make('blocked.feedback')
  const selectedSkill = makeSkill({
    id: 'role.skill',
    actionTools: [skillActionId, mcpActionId],
    feedbackTools: [skillFeedbackId, mcpFeedbackId],
  })
  const excludedSkill = makeSkill({ id: 'other.skill' })
  const actions = [
    makeActionTool(skillActionId),
    makeActionTool(mcpActionId),
    makeActionTool(presetActionId),
    makeActionTool(blockedActionId),
  ]
  const feedback = [
    makeFeedbackTool(skillFeedbackId),
    makeFeedbackTool(mcpFeedbackId),
    makeFeedbackTool(presetFeedbackId),
    makeFeedbackTool(blockedFeedbackId),
  ]
  const preset = makePreset(
    [selectedSkill.id],
    [presetActionId, blockedActionId],
    [presetFeedbackId, blockedFeedbackId],
  )
  const visibility = CapabilitySelection.Visibility.make({
    skills: [selectedSkill.id, excludedSkill.id],
    actionTools: [presetActionId, skillActionId, mcpActionId],
    feedbackTools: [presetFeedbackId, skillFeedbackId, mcpFeedbackId],
    mcpServers: [],
  })
  const capabilities = {
    contextProviders: [],
    actionTools: actions,
    feedbackTools: feedback,
    skills: [selectedSkill, excludedSkill],
    mcpProjectionSources: [
      {
        serverId: McpServerId.make('calendar'),
        actionToolIds: [mcpActionId],
        feedbackToolIds: [mcpFeedbackId],
      },
    ],
  }

  const hiddenMcp = CapabilitySelection.select({
    capabilities,
    visibility,
    preset: Option.some(preset),
    scope: SCOPE,
    focus: FOCUS,
    eventKind: 'direct',
    responseMechanisms: [DIRECT],
  })
  expect(hiddenMcp.skills.map((skill) => skill.id)).toEqual([selectedSkill.id])
  expect(hiddenMcp.actionTools.map((tool) => tool.id)).toEqual([presetActionId, skillActionId])
  expect(hiddenMcp.feedbackTools.map((tool) => tool.id)).toEqual([
    presetFeedbackId,
    skillFeedbackId,
  ])

  const visibleMcp = CapabilitySelection.select({
    capabilities,
    visibility: CapabilitySelection.Visibility.make({
      ...visibility,
      mcpServers: [McpServerId.make('calendar')],
    }),
    preset: Option.some(preset),
    scope: SCOPE,
    focus: FOCUS,
    eventKind: 'direct',
    responseMechanisms: [DIRECT],
  })
  expect(visibleMcp.actionTools.map((tool) => tool.id)).toEqual([
    presetActionId,
    skillActionId,
    mcpActionId,
  ])
  expect(visibleMcp.feedbackTools.map((tool) => tool.id)).toEqual([
    presetFeedbackId,
    skillFeedbackId,
    mcpFeedbackId,
  ])
})

it('uses configured tool candidates directly when no preset is active', () => {
  const action = makeActionTool('configured.action')
  const feedback = makeFeedbackTool('configured.feedback')
  const visibility = CapabilitySelection.Visibility.make({
    ...emptyVisibility(),
    actionTools: [action.id],
    feedbackTools: [feedback.id],
  })
  const selected = CapabilitySelection.select({
    capabilities: {
      contextProviders: [],
      actionTools: [action],
      feedbackTools: [feedback],
      skills: [],
      mcpProjectionSources: [],
    },
    visibility,
    preset: Option.none(),
    scope: SCOPE,
    focus: FOCUS,
    eventKind: 'direct',
    responseMechanisms: [],
  })

  expect(selected.actionTools).toEqual([action])
  expect(selected.feedbackTools).toEqual([feedback])
})

it('bounds selected Skill count and trusted prompt bytes deterministically', () => {
  const skills = Array.from({ length: 5 }, (_, index) =>
    makeSkill({ id: `skill-${String(index)}` }),
  )
  const visibility = CapabilitySelection.Visibility.make({
    ...emptyVisibility(),
    skills: skills.map((skill) => skill.id),
  })
  const countBounded = CapabilitySelection.select({
    capabilities: {
      contextProviders: [],
      actionTools: [],
      feedbackTools: [],
      skills,
      mcpProjectionSources: [],
    },
    visibility,
    preset: Option.none(),
    scope: SCOPE,
    focus: FOCUS,
    eventKind: 'direct',
    responseMechanisms: [],
  })

  expect(countBounded.skills).toHaveLength(CapabilitySelection.MAX_SELECTED_SKILLS)

  const largeSkills = [
    makeSkill({ id: 'large-first', prompt: 'a'.repeat(8_192) }),
    makeSkill({ id: 'large-second', prompt: 'b'.repeat(8_192) }),
  ]
  const byteBounded = CapabilitySelection.select({
    capabilities: {
      contextProviders: [],
      actionTools: [],
      feedbackTools: [],
      skills: largeSkills,
      mcpProjectionSources: [],
    },
    visibility: CapabilitySelection.Visibility.make({
      ...emptyVisibility(),
      skills: largeSkills.map((skill) => skill.id),
    }),
    preset: Option.none(),
    scope: SCOPE,
    focus: FOCUS,
    eventKind: 'direct',
    responseMechanisms: [],
  })

  expect(byteBounded.skills).toEqual([largeSkills[0]])
  expect(Buffer.byteLength(byteBounded.skillSystemInstruction, 'utf8')).toBeLessThanOrEqual(
    CapabilitySelection.MAX_SKILL_SYSTEM_INSTRUCTION_BYTES,
  )
})
