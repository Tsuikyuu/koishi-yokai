import { expect, it } from '@effect/vitest'
import { Notebook, NotebookModel } from '@yokai-internal/memory'
import { RoleStateModel, SceneUnderstanding, ThreadScene } from '@yokai-internal/mind'
import {
  CapabilityScope,
  FocusMessage,
  PresetId,
  PresetSourceId,
  type PresetCandidate,
} from 'yokai-protocol'
import { Context, DateTime, Effect, Layer, Option, Queue, Ref } from 'effect'
import { TestClock } from 'effect/testing'

import {
  CallBudget,
  ActivityGateValue,
  CapabilitySelection,
  HostConfiguration,
  InitiativeDelivery,
  InitiativeResponseMechanism,
  PresetRegistry,
  RoleState,
  WakeArbiter,
  WakeMessage,
  WakeProposal,
} from '../../../src/index'

const SCOPE = CapabilityScope.make({
  instanceId: 'initiative-test',
  platform: 'test',
  guildId: 'guild',
  channelId: 'channel',
})
const PRESET_ID = PresetId.make('initiative.role')
const ALICE = RoleStateModel.MemberId.make('alice')

const OPTIONS = InitiativeResponseMechanism.Options.make({
  enabled: true,
  quietPeriodMs: InitiativeResponseMechanism.PositiveDurationMilliseconds.make(1_000),
  channelCooldownMs: WakeProposal.DurationMilliseconds.make(0),
  intrinsicIntervalMs: InitiativeResponseMechanism.PositiveDurationMilliseconds.make(5_000),
  recentWindowMs: InitiativeResponseMechanism.PositiveDurationMilliseconds.make(5_000),
  recentRelevanceThreshold: ActivityGateValue.Score.make(0.75),
  relationshipThreshold: RoleStateModel.Level.make(0.1),
  minSocialEnergy: RoleStateModel.Level.make(0.6),
  maxRecentParticipation: RoleStateModel.Level.make(0.35),
  debounceMs: WakeProposal.DurationMilliseconds.make(0),
  proposalTtlMs: InitiativeResponseMechanism.PositiveDurationMilliseconds.make(2_000),
})

const presetCandidate = (): PresetCandidate => ({
  id: PRESET_ID,
  persona: {
    name: 'Koharu',
    selfConcept: 'A curious long-time member of the group.',
    background: 'Grew up around a small neighborhood library.',
    values: ['honesty'],
    interests: ['folklore'],
    opinions: ['Small practical help is worthwhile.'],
    speakingStyle: 'Warm and concise.',
    socialBoundaries: ['Do not pressure people.'],
    knowledgeBoundaries: ['Admit uncertainty.'],
  },
})

const relationship = (familiarity: number): RoleStateModel.Relationship =>
  RoleStateModel.Relationship.make({
    ...RoleStateModel.emptyRelationship(ALICE, 0),
    familiarity: RoleStateModel.Level.make(familiarity),
  })

const roleSnapshot = (
  familiarity = 0.1,
  unfinishedItems: ReadonlyArray<RoleStateModel.UnfinishedItem> = [],
): RoleStateModel.Snapshot => {
  const empty = RoleStateModel.empty(0)
  return RoleStateModel.Snapshot.make({
    ...empty,
    roleState: RoleStateModel.RoleState.make({ ...empty.roleState, unfinishedItems }),
    relationships: [relationship(familiarity)],
  })
}

const observation = (
  messageId: string,
  options: { readonly direct?: boolean; readonly content?: string } = {},
): InitiativeResponseMechanism.Observation => {
  const content = options.content === undefined ? 'ordinary group chatter' : options.content
  const scene = SceneUnderstanding.observe(
    ThreadScene.empty(),
    ThreadScene.Message.make({
      messageId: ThreadScene.MessageId.make(messageId),
      authorId: ALICE,
      timestamp: ThreadScene.EpochMilliseconds.make(0),
      content,
      replyToMessageId: Option.none(),
      isSelf: false,
      directedToYokai: false,
    }),
    0,
  ).scene
  return InitiativeResponseMechanism.Observation.make({
    message: WakeMessage.Message.make({
      scope: SCOPE,
      focus: FocusMessage.make({ messageId, authorId: ALICE, timestamp: 0, content }),
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
      localState: WakeMessage.emptyLocalStateSignals(),
    }),
    scene,
    selfId: InitiativeResponseMechanism.SelfId.make('bot'),
    isDirect: options.direct === true,
  })
}

const limits = (background: number): CallBudget.ClassifiedLimits =>
  CallBudget.ClassifiedLimits.make({
    reserved: CallBudget.WindowLimits.make({
      minute: CallBudget.CallCount.make(8),
      day: CallBudget.CallCount.make(8),
    }),
    normal: CallBudget.WindowLimits.make({
      minute: CallBudget.CallCount.make(8),
      day: CallBudget.CallCount.make(8),
    }),
    background: CallBudget.WindowLimits.make({
      minute: CallBudget.CallCount.make(background),
      day: CallBudget.CallCount.make(background),
    }),
  })

interface TestControlInterface {
  readonly setRoleState: (snapshot: RoleStateModel.Snapshot) => Effect.Effect<void>
  readonly requestCount: () => Effect.Effect<number>
  readonly nextRequest: () => Effect.Effect<InitiativeDelivery.Request>
  readonly nextExecution: () => Effect.Effect<WakeProposal.Merged>
}

class TestControl extends Context.Service<TestControl, TestControlInterface>()(
  '@yokai/core/test/InitiativeControl',
) {}

const testDependencies = Layer.effectContext(
  Effect.gen(function* () {
    const arbiter = yield* WakeArbiter.Service
    const currentRoleState = yield* Ref.make(roleSnapshot())
    const requests = yield* Queue.unbounded<InitiativeDelivery.Request>()
    const executions = yield* Queue.unbounded<WakeProposal.Merged>()
    const requestTotal = yield* Ref.make(0)

    const roleState = RoleState.Service.of({
      observe: () => Effect.die('RoleState.observe is not used by initiative tests'),
      recordSuccessfulTurn: () =>
        Effect.die('RoleState.recordSuccessfulTurn is not used by initiative tests'),
      materialize: (snapshot) => Effect.succeed(snapshot),
      snapshot: () => Ref.get(currentRoleState),
    })
    const notebook = Notebook.Service.of({
      write: () => Effect.die('Notebook.write is not used by initiative tests'),
      recall: () => Effect.die('Notebook.recall is not used by initiative tests'),
      findRecallableEvidence: () => Effect.succeed<ReadonlyArray<NotebookModel.NoteEvidence>>([]),
    })
    const delivery = InitiativeDelivery.Service.of({
      isAvailable: () => Effect.succeed(true),
      dispatch: Effect.fn('InitiativeTest.dispatch')(function* (
        request: InitiativeDelivery.Request,
      ) {
        yield* Ref.update(requestTotal, (count) => count + 1)
        yield* Queue.offer(requests, request)
        return yield* arbiter.submitWithAdmission(
          request.proposal,
          request.admission,
          (merged, markDispatched) =>
            markDispatched().pipe(
              Effect.flatMap((committed) =>
                committed ? Queue.offer(executions, merged) : Effect.void,
              ),
              Effect.asVoid,
            ),
        )
      }),
    })
    const control = TestControl.of({
      setRoleState: (snapshot) => Ref.set(currentRoleState, snapshot),
      requestCount: () => Ref.get(requestTotal),
      nextRequest: () => Queue.take(requests),
      nextExecution: () => Queue.take(executions),
    })

    return Context.empty().pipe(
      Context.add(RoleState.Service, roleState),
      Context.add(Notebook.Service, notebook),
      Context.add(InitiativeDelivery.Service, delivery),
      Context.add(TestControl, control),
    )
  }),
)

const testLayer = (background = 8, options: InitiativeResponseMechanism.Options = OPTIONS) => {
  const budget = CallBudget.layer({
    limits: limits(background),
    timeZone: DateTime.zoneMakeNamedUnsafe('UTC'),
  })
  const arbiter = WakeArbiter.layer({
    cooldownMs: WakeProposal.DurationMilliseconds.make(0),
  }).pipe(Layer.provideMerge(budget))
  const base = Layer.mergeAll(
    arbiter,
    HostConfiguration.layer({
      instanceId: SCOPE.instanceId,
      model: Option.none(),
      presetId: Option.some(PRESET_ID),
      feedbackToolsEnabled: false,
      capabilityVisibility: CapabilitySelection.Visibility.make({
        skills: [],
        actionTools: [],
        feedbackTools: [],
        mcpServers: [],
      }),
    }),
    PresetRegistry.layer,
  )
  const dependencies = testDependencies.pipe(Layer.provideMerge(base))
  return InitiativeResponseMechanism.layer(options).pipe(Layer.provideMerge(dependencies))
}

const publishPreset = Effect.fn('InitiativeTest.publishPreset')(function* () {
  const presets = yield* PresetRegistry.Service
  const source = yield* presets.registerSource(PresetSourceId.make('initiative.test'))
  yield* source.publish(presetCandidate(), { skills: [], actionTools: [], feedbackTools: [] })
})

it.effect('creates an intrinsic proposal with the single remaining background call', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    yield* publishPreset()
    const initiative = yield* InitiativeResponseMechanism.Service
    const control = yield* TestControl

    yield* initiative.observe(observation('intrinsic'))
    expect(yield* control.requestCount()).toBe(0)
    yield* TestClock.adjust(1_000)

    const request = yield* control.nextRequest()
    const executed = yield* control.nextExecution()
    expect(request.proposal).toMatchObject({
      kind: 'initiative',
      mergeKey: WakeProposal.INITIATIVE_MERGE_KEY,
      budgetCategory: 'background',
      cooldownPolicy: 'enforce',
      focus: { messageId: 'intrinsic', content: 'ordinary group chatter' },
      reason: {
        mechanismId: WakeProposal.INITIATIVE_MECHANISM_ID,
        code: WakeProposal.INITIATIVE_INTRINSIC_REASON_CODE,
        initiativeAudit: {
          _tag: 'IntrinsicOpportunity',
          sources: ['persona-interest'],
          selfNoteIds: [],
        },
      },
    })
    expect(executed.primaryReason.code).toBe(WakeProposal.INITIATIVE_INTRINSIC_REASON_CODE)
    const snapshot = yield* initiative.snapshot(WakeProposal.scopeIdOf(SCOPE))
    expect(Option.isSome(snapshot)).toBe(true)
    if (Option.isSome(snapshot)) {
      expect(snapshot.value.acceptedRevision).toEqual(Option.some(snapshot.value.revision))
      expect(snapshot.value.lastIntrinsicAt).toEqual(Option.some(1_000))
    }
  }).pipe(Effect.provide(testLayer(1))),
)

it.effect('replaces a same-channel quiet worker with the latest real focus', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    yield* publishPreset()
    const initiative = yield* InitiativeResponseMechanism.Service
    const control = yield* TestControl

    yield* initiative.observe(observation('first'))
    yield* TestClock.adjust(500)
    yield* initiative.observe(observation('second'))
    yield* TestClock.adjust(999)
    expect(yield* control.requestCount()).toBe(0)
    yield* TestClock.adjust(1)
    expect((yield* control.nextRequest()).proposal.focus.messageId).toBe('second')
    expect((yield* control.nextExecution()).focus.messageId).toBe('second')
    expect(yield* control.requestCount()).toBe(1)
  }).pipe(Effect.provide(testLayer())),
)

it.effect('retains the exact unfinished thread as content-free proposal audit evidence', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    yield* publishPreset()
    const initiative = yield* InitiativeResponseMechanism.Service
    const control = yield* TestControl
    const unfinishedThreadId = ThreadScene.ThreadId.make('older-unfinished-thread')
    yield* control.setRoleState(
      roleSnapshot(0.1, [
        RoleStateModel.UnfinishedItem.make({
          threadId: unfinishedThreadId,
          summary: ThreadScene.TopicSummary.make('An older topic to revisit.'),
        }),
      ]),
    )

    yield* initiative.observe(observation('newer-focus'))
    yield* TestClock.adjust(1_000)

    const request = yield* control.nextRequest()
    expect(request.proposal.reason).toMatchObject({
      code: WakeProposal.INITIATIVE_UNFINISHED_REASON_CODE,
      initiativeAudit: {
        _tag: 'UnfinishedTopic',
        threadId: unfinishedThreadId,
      },
    })
    yield* control.nextExecution()
  }).pipe(Effect.provide(testLayer())),
)

it.effect('rejects private observations and insufficient relationships before dispatch', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    yield* publishPreset()
    const initiative = yield* InitiativeResponseMechanism.Service
    const control = yield* TestControl

    yield* initiative.observe(observation('private', { direct: true }))
    yield* TestClock.adjust(1_000)
    expect(yield* control.requestCount()).toBe(0)

    yield* control.setRoleState(roleSnapshot(0.099))
    yield* initiative.observe(observation('stranger'))
    yield* TestClock.adjust(1_000)
    expect(yield* control.requestCount()).toBe(0)
  }).pipe(Effect.provide(testLayer())),
)

it.effect('does not borrow normal or reserved budget when background is exhausted', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    yield* publishPreset()
    const initiative = yield* InitiativeResponseMechanism.Service
    const control = yield* TestControl

    yield* initiative.observe(observation('no-background-budget'))
    yield* TestClock.adjust(1_000)
    expect(yield* control.requestCount()).toBe(0)
  }).pipe(Effect.provide(testLayer(0))),
)

it.effect('enforces the channel cooldown after any accepted role wake', () => {
  const cooledDown = InitiativeResponseMechanism.Options.make({
    ...OPTIONS,
    channelCooldownMs: WakeProposal.DurationMilliseconds.make(5_000),
  })
  return Effect.gen(function* () {
    yield* TestClock.setTime(0)
    yield* publishPreset()
    const initiative = yield* InitiativeResponseMechanism.Service
    const control = yield* TestControl

    yield* initiative.observe(observation('initial-cooldown'))
    yield* TestClock.adjust(1_000)
    yield* control.nextRequest()
    yield* control.nextExecution()

    yield* initiative.observe(observation('inside-cooldown'))
    yield* TestClock.adjust(1_000)
    expect(yield* control.requestCount()).toBe(1)

    yield* TestClock.adjust(3_999)
    expect(yield* control.requestCount()).toBe(1)
    yield* TestClock.adjust(1)
    expect((yield* control.nextRequest()).proposal.focus.messageId).toBe('inside-cooldown')
    expect((yield* control.nextExecution()).focus.messageId).toBe('inside-cooldown')
  }).pipe(Effect.provide(testLayer(8, cooledDown)))
})

it.effect('enforces the intrinsic interval at admission boundaries', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    yield* publishPreset()
    const initiative = yield* InitiativeResponseMechanism.Service
    const control = yield* TestControl

    yield* initiative.observe(observation('initial'))
    yield* TestClock.adjust(1_000)
    yield* control.nextRequest()
    yield* control.nextExecution()

    yield* initiative.observe(observation('too-soon'))
    yield* TestClock.adjust(1_000)
    expect(yield* control.requestCount()).toBe(1)

    yield* TestClock.adjust(4_000)
    yield* initiative.observe(observation('at-boundary'))
    yield* TestClock.adjust(1_000)
    expect((yield* control.nextRequest()).proposal.focus.messageId).toBe('at-boundary')
    expect((yield* control.nextExecution()).focus.messageId).toBe('at-boundary')
    expect(yield* control.requestCount()).toBe(2)
  }).pipe(Effect.provide(testLayer())),
)

it.effect('invalidates an already submitted proposal when a newer message changes revision', () => {
  const delayed = InitiativeResponseMechanism.Options.make({
    ...OPTIONS,
    debounceMs: WakeProposal.DurationMilliseconds.make(500),
  })
  return Effect.gen(function* () {
    yield* TestClock.setTime(0)
    yield* publishPreset()
    const initiative = yield* InitiativeResponseMechanism.Service
    const control = yield* TestControl

    yield* initiative.observe(observation('stale'))
    yield* TestClock.adjust(1_000)
    expect((yield* control.nextRequest()).proposal.focus.messageId).toBe('stale')
    yield* Effect.yieldNow
    yield* initiative.observe(observation('newer'))

    yield* TestClock.adjust(500)
    expect(yield* control.requestCount()).toBe(1)

    yield* TestClock.adjust(1_000)
    expect((yield* control.nextRequest()).proposal.focus.messageId).toBe('newer')
    yield* TestClock.adjust(500)
    expect((yield* control.nextExecution()).focus.messageId).toBe('newer')
  }).pipe(Effect.provide(testLayer(8, delayed)))
})
