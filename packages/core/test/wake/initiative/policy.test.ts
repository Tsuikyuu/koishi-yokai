import { expect, it } from '@effect/vitest'
import { MessageArchiveEvent, NotebookModel } from '@yokai-internal/memory'
import { RoleStateModel, ThreadScene } from '@yokai-internal/mind'
import {
  CapabilityScope,
  FocusMessage,
  Persona,
  PresetContentHash,
  PresetId,
  PresetLoadedAt,
  PresetSnapshot,
  PresetSourceId,
  PresetVersion,
} from 'yokai-protocol'
import { Option } from 'effect'

import {
  ActivityGateValue,
  InitiativePolicy,
  InitiativeResponseMechanism,
  WakeMessage,
  WakeProposal,
} from '../../../src/index'

const NOW = 10_000
const UPDATED_AT = RoleStateModel.EpochMilliseconds.make(9_000)
const FOCUS_CONTENT = 'private focus body that must not enter policy audit data'
const PERSONA_INTEREST = 'folklore'
const ALICE = ThreadScene.ParticipantId.make('alice')
const BOB = ThreadScene.ParticipantId.make('bob')
const THREAD_ID = ThreadScene.ThreadId.make('thread-1')
const SCOPE = CapabilityScope.make({
  instanceId: 'initiative-policy-test',
  platform: 'test',
  guildId: 'guild',
  channelId: 'channel',
})

const OPTIONS = InitiativeResponseMechanism.Options.make({
  enabled: true,
  quietPeriodMs: InitiativeResponseMechanism.PositiveDurationMilliseconds.make(1_000),
  channelCooldownMs: WakeProposal.DurationMilliseconds.make(0),
  intrinsicIntervalMs: InitiativeResponseMechanism.PositiveDurationMilliseconds.make(10_000),
  recentWindowMs: InitiativeResponseMechanism.PositiveDurationMilliseconds.make(5_000),
  recentRelevanceThreshold: ActivityGateValue.Score.make(0.75),
  relationshipThreshold: RoleStateModel.Level.make(0.5),
  minSocialEnergy: RoleStateModel.Level.make(0.6),
  maxRecentParticipation: RoleStateModel.Level.make(0.4),
  debounceMs: WakeProposal.DurationMilliseconds.make(0),
  proposalTtlMs: InitiativeResponseMechanism.PositiveDurationMilliseconds.make(2_000),
})

const PRESET = PresetSnapshot.make({
  id: PresetId.make('initiative.policy'),
  version: PresetVersion.make(3),
  contentHash: PresetContentHash.make('a'.repeat(64)),
  persona: Persona.make({
    name: 'Koharu',
    selfConcept: 'A curious group member.',
    background: 'A deterministic policy fixture.',
    values: ['honesty'],
    interests: [PERSONA_INTEREST],
    opinions: ['Initiative should remain auditable.'],
    speakingStyle: 'Warm and concise.',
    socialBoundaries: ['Respect conversation boundaries.'],
    knowledgeBoundaries: ['Admit uncertainty.'],
  }),
  skills: [],
  actionTools: [],
  feedbackTools: [],
  compiledPrompt: 'Policy test prompt.',
  loadedAt: PresetLoadedAt.make(1),
  sourceId: PresetSourceId.make('initiative.policy.test'),
  sourceAvailable: true,
})

const NO_PERSONA_INTEREST_PRESET: PresetSnapshot = {
  ...PRESET,
  persona: { ...PRESET.persona, interests: [] },
}

const SELF_EVIDENCE = NotebookModel.NoteEvidence.make({
  noteId: NotebookModel.NoteId.make(`note_${'1'.repeat(32)}`),
  kind: 'self',
  createdAt: MessageArchiveEvent.Timestamp.make(8_000),
})

interface ObservationOptions {
  readonly lastActiveAt?: number
  readonly relevance?: number
  readonly participants?: ReadonlyArray<ThreadScene.ParticipantId>
  readonly keywords?: ReadonlyArray<ThreadScene.Keyword>
}

const observation = (options: ObservationOptions = {}): InitiativeResponseMechanism.Observation => {
  const lastActiveAt = options.lastActiveAt === undefined ? 0 : options.lastActiveAt
  const relevance = options.relevance === undefined ? 0 : options.relevance
  const participants = options.participants === undefined ? [ALICE] : options.participants
  const keywords =
    options.keywords === undefined ? [ThreadScene.Keyword.make('gardening')] : options.keywords
  return InitiativeResponseMechanism.Observation.make({
    message: WakeMessage.Message.make({
      scope: SCOPE,
      focus: FocusMessage.make({
        messageId: 'focus-1',
        authorId: ALICE,
        timestamp: NOW,
        content: FOCUS_CONTENT,
      }),
      isDuplicate: false,
      isOtherBot: false,
      isSelf: false,
      isEffective: true,
      explicitMention: false,
      replyToSelf: false,
      presetNameMatch: 'none',
      hardReplyKind: 'none',
      isQuestionOrHelp: false,
      hasQuote: false,
      hasMedia: false,
      localState: WakeMessage.LocalStateSignals.make({
        ...WakeMessage.emptyLocalStateSignals(),
        threadOrInterestEvidence: ActivityGateValue.Score.make(relevance),
      }),
    }),
    scene: ThreadScene.Scene.make({
      thread: ThreadScene.ThreadState.make({
        id: THREAD_ID,
        summary: ThreadScene.TopicSummary.make('A deliberately private thread summary.'),
        participants,
        mode: 'chat',
        activity: ThreadScene.Activity.make(0.5),
        lastActiveAt: ThreadScene.EpochMilliseconds.make(lastActiveAt),
        messageCount: 1,
        recentMessages: [],
        keywords,
        openQuestion: Option.none(),
        sufficientResponse: false,
      }),
      activeThreadCount: 1,
      direction: ThreadScene.Direction.make({
        kind: 'group',
        targetParticipantId: Option.none(),
      }),
      interruptsOthers: false,
      sufficientResponse: false,
    }),
    selfId: InitiativeResponseMechanism.SelfId.make('bot'),
    isDirect: false,
  })
}

const relationship = (
  memberId: ThreadScene.ParticipantId,
  familiarity: number,
): RoleStateModel.Relationship =>
  RoleStateModel.Relationship.make({
    ...RoleStateModel.emptyRelationship(memberId, UPDATED_AT),
    familiarity: RoleStateModel.Level.make(familiarity),
  })

interface SnapshotOptions {
  readonly familiarity?: number
  readonly socialEnergy?: number
  readonly recentParticipation?: number
  readonly currentInterests?: ReadonlyArray<RoleStateModel.Interest>
  readonly unfinishedItems?: ReadonlyArray<RoleStateModel.UnfinishedItem>
  readonly relationships?: ReadonlyArray<RoleStateModel.Relationship>
}

const roleSnapshot = (options: SnapshotOptions = {}): RoleStateModel.Snapshot => {
  const empty = RoleStateModel.empty(UPDATED_AT)
  const familiarity = options.familiarity === undefined ? 0.5 : options.familiarity
  return RoleStateModel.Snapshot.make({
    ...empty,
    roleState: RoleStateModel.RoleState.make({
      ...empty.roleState,
      socialEnergy: RoleStateModel.Level.make(
        options.socialEnergy === undefined ? 0.6 : options.socialEnergy,
      ),
      currentInterests: options.currentInterests === undefined ? [] : options.currentInterests,
      unfinishedItems: options.unfinishedItems === undefined ? [] : options.unfinishedItems,
      recentParticipation: RoleStateModel.Level.make(
        options.recentParticipation === undefined ? 0.4 : options.recentParticipation,
      ),
    }),
    relationships:
      options.relationships === undefined
        ? [relationship(ALICE, familiarity)]
        : options.relationships,
    updatedAt: UPDATED_AT,
  })
}

interface InputOptions {
  readonly observation?: InitiativeResponseMechanism.Observation
  readonly roleState?: RoleStateModel.Snapshot
  readonly preset?: PresetSnapshot
  readonly selfMemory?: ReadonlyArray<NotebookModel.NoteEvidence>
}

const input = (options: InputOptions = {}): InitiativePolicy.Input => ({
  observation: options.observation === undefined ? observation() : options.observation,
  roleState: options.roleState === undefined ? roleSnapshot() : options.roleState,
  preset: options.preset === undefined ? PRESET : options.preset,
  selfMemory: options.selfMemory === undefined ? [] : options.selfMemory,
  now: NOW,
})

const tagOf = (decision: Option.Option<InitiativePolicy.Motivation>) =>
  Option.match(decision, { onNone: () => 'none', onSome: (motivation) => motivation._tag })

it('orders unfinished, relevant recent, and intrinsic motivations by precedence', () => {
  const expressiveState = roleSnapshot({
    currentInterests: [RoleStateModel.Interest.make('gardening')],
    unfinishedItems: [
      RoleStateModel.UnfinishedItem.make({
        threadId: THREAD_ID,
        summary: ThreadScene.TopicSummary.make('Finish the open point.'),
      }),
    ],
  })
  const allEvidence = input({
    observation: observation({ lastActiveAt: NOW, relevance: 1 }),
    roleState: expressiveState,
    selfMemory: [SELF_EVIDENCE],
  })

  expect(InitiativePolicy.decide(allEvidence, OPTIONS)).toEqual(
    Option.some(
      InitiativePolicy.Motivation.UnfinishedTopic({
        threadId: THREAD_ID,
        stateUpdatedAt: UPDATED_AT,
      }),
    ),
  )

  const withoutUnfinished = input({
    ...allEvidence,
    roleState: roleSnapshot({
      currentInterests: [RoleStateModel.Interest.make('gardening')],
    }),
  })
  expect(InitiativePolicy.decide(withoutUnfinished, OPTIONS)).toEqual(
    Option.some(
      InitiativePolicy.Motivation.RelevantRecentContent({
        sourceMessageId: 'focus-1',
        score: ActivityGateValue.Score.make(1),
      }),
    ),
  )

  const intrinsic = InitiativePolicy.decide(
    input({ ...withoutUnfinished, observation: observation({ lastActiveAt: 0, relevance: 1 }) }),
    OPTIONS,
  )
  expect(intrinsic).toEqual(
    Option.some(
      InitiativePolicy.Motivation.IntrinsicOpportunity({
        sources: ['persona-interest', 'current-state', 'self-memory'],
        presetVersion: PRESET.version,
        stateUpdatedAt: UPDATED_AT,
        selfNoteIds: [SELF_EVIDENCE.noteId],
      }),
    ),
  )
  expect(JSON.stringify(intrinsic)).not.toContain(FOCUS_CONTENT)
  expect(JSON.stringify(intrinsic)).not.toContain(PERSONA_INTEREST)
  expect(JSON.stringify(intrinsic)).not.toContain('private thread summary')
})

it('attributes intrinsic opportunities to persona, current state, or self-memory evidence', () => {
  const persona = InitiativePolicy.decide(input(), OPTIONS)
  const currentState = InitiativePolicy.decide(
    input({
      preset: NO_PERSONA_INTEREST_PRESET,
      roleState: roleSnapshot({
        currentInterests: [RoleStateModel.Interest.make('gardening')],
      }),
    }),
    OPTIONS,
  )
  const selfMemory = InitiativePolicy.decide(
    input({ preset: NO_PERSONA_INTEREST_PRESET, selfMemory: [SELF_EVIDENCE] }),
    OPTIONS,
  )

  expect(persona).toEqual(
    Option.some(
      InitiativePolicy.Motivation.IntrinsicOpportunity({
        sources: ['persona-interest'],
        presetVersion: PRESET.version,
        stateUpdatedAt: UPDATED_AT,
        selfNoteIds: [],
      }),
    ),
  )
  expect(currentState).toEqual(
    Option.some(
      InitiativePolicy.Motivation.IntrinsicOpportunity({
        sources: ['current-state'],
        presetVersion: PRESET.version,
        stateUpdatedAt: UPDATED_AT,
        selfNoteIds: [],
      }),
    ),
  )
  expect(selfMemory).toEqual(
    Option.some(
      InitiativePolicy.Motivation.IntrinsicOpportunity({
        sources: ['self-memory'],
        presetVersion: PRESET.version,
        stateUpdatedAt: UPDATED_AT,
        selfNoteIds: [SELF_EVIDENCE.noteId],
      }),
    ),
  )
})

it('requires a relevant relationship at the inclusive familiarity boundary', () => {
  expect(
    tagOf(
      InitiativePolicy.decide(input({ roleState: roleSnapshot({ familiarity: 0.499 }) }), OPTIONS),
    ),
  ).toBe('none')
  expect(
    tagOf(
      InitiativePolicy.decide(input({ roleState: roleSnapshot({ familiarity: 0.5 }) }), OPTIONS),
    ),
  ).toBe('IntrinsicOpportunity')
  expect(
    tagOf(
      InitiativePolicy.decide(
        input({
          roleState: roleSnapshot({
            relationships: [relationship(ALICE, 0.499), relationship(BOB, 1)],
          }),
        }),
        OPTIONS,
      ),
    ),
  ).toBe('none')
})

it('applies inclusive social-energy and recent-participation state gates', () => {
  expect(
    tagOf(
      InitiativePolicy.decide(input({ roleState: roleSnapshot({ socialEnergy: 0.599 }) }), OPTIONS),
    ),
  ).toBe('none')
  expect(
    tagOf(
      InitiativePolicy.decide(input({ roleState: roleSnapshot({ socialEnergy: 0.6 }) }), OPTIONS),
    ),
  ).toBe('IntrinsicOpportunity')
  expect(
    tagOf(
      InitiativePolicy.decide(
        input({ roleState: roleSnapshot({ recentParticipation: 0.401 }) }),
        OPTIONS,
      ),
    ),
  ).toBe('none')
  expect(
    tagOf(
      InitiativePolicy.decide(
        input({ roleState: roleSnapshot({ recentParticipation: 0.4 }) }),
        OPTIONS,
      ),
    ),
  ).toBe('IntrinsicOpportunity')
})

it('treats recent-window and relevance thresholds as inclusive boundaries', () => {
  expect(
    tagOf(
      InitiativePolicy.decide(
        input({ observation: observation({ lastActiveAt: 5_000, relevance: 0.75 }) }),
        OPTIONS,
      ),
    ),
  ).toBe('RelevantRecentContent')
  expect(
    tagOf(
      InitiativePolicy.decide(
        input({ observation: observation({ lastActiveAt: 4_999, relevance: 0.75 }) }),
        OPTIONS,
      ),
    ),
  ).toBe('IntrinsicOpportunity')
  expect(
    tagOf(
      InitiativePolicy.decide(
        input({ observation: observation({ lastActiveAt: 5_000, relevance: 0.749 }) }),
        OPTIONS,
      ),
    ),
  ).toBe('IntrinsicOpportunity')
})

it('rejects an otherwise eligible input with no auditable motivation', () => {
  expect(InitiativePolicy.decide(input({ preset: NO_PERSONA_INTEREST_PRESET }), OPTIONS)).toEqual(
    Option.none(),
  )
})
