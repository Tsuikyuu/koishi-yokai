import { RoleStateModel } from '@yokai-internal/mind'
import { expect, it } from '@effect/vitest'
import {
  BackgroundTasks,
  CallBudget,
  CapabilityRegistry,
  CapabilitySelection,
  ChannelMessageBuffer,
  HostConfiguration,
  InitiativeDelivery,
  InitiativeResponseMechanism,
  PresetRegistry,
  RoleState,
  ThreadTracker,
  WakeArbiter,
  WakeProposal,
} from '@yokai-internal/core'
import {
  AdapterDescriptor,
  AdapterId,
  AdapterModelId,
  AdapterModelSnapshot,
  CapabilityScope,
  CURRENT_ADAPTER_PROTOCOL_VERSION,
  FinalTextResult,
  FocusMessage,
  GenerationUsage,
  ModelReference,
  PresetId,
  PresetVersion,
  ResponseMechanismId,
  type YokaiAdapter,
} from 'yokai-protocol'
import { DateTime, Effect, Layer, Option, Queue, Ref, Schema } from 'effect'
import { Bot, Context, h, type Fragment, Universal } from 'koishi'
import { vi } from 'vitest'

vi.mock('koishi', () => import('@koishijs/core'))

import { KoishiInitiativeDelivery } from '../../src/response/initiative-delivery'

const ADAPTER_ID = AdapterId.make('initiative-delivery')
const MODEL_ID = AdapterModelId.make('model')
const MODEL_REFERENCE = ModelReference.make({ adapterId: ADAPTER_ID, modelId: MODEL_ID })
const SCOPE = CapabilityScope.make({
  instanceId: 'test',
  platform: 'test',
  guildId: 'guild',
  channelId: 'channel',
})
const TARGET = InitiativeResponseMechanism.Target.make({
  scope: SCOPE,
  selfId: InitiativeResponseMechanism.SelfId.make('bot'),
})
const MODEL_SNAPSHOT = Schema.decodeUnknownSync(AdapterModelSnapshot)({
  discoveredAt: '2026-09-01T00:00:00.000Z',
  models: [
    {
      id: MODEL_ID,
      displayName: 'Initiative delivery model',
      availability: 'available',
      discoveryFreshness: 'fresh',
    },
  ],
})

interface SentMessage {
  readonly channelId: string
  readonly content: string
  readonly guildId: string | undefined
}

class TestBot extends Bot<Context, {}> {
  constructor(
    ctx: Context,
    private readonly sentMessages: Queue.Queue<SentMessage>,
    selfId = 'bot',
  ) {
    super(ctx, {}, 'test')
    this.user = { id: selfId }
  }

  override sendMessage(channelId: string, content: Fragment, guildId?: string): Promise<string[]> {
    return Effect.runPromise(
      Queue.offer(this.sentMessages, {
        channelId,
        content: h.normalize(content).join(''),
        guildId,
      }).pipe(Effect.as(['sent'])),
    )
  }

  override dispose(): Promise<void> {
    return Promise.resolve()
  }
}

const limits = CallBudget.ClassifiedLimits.make({
  reserved: CallBudget.WindowLimits.make({
    minute: CallBudget.CallCount.make(8),
    day: CallBudget.CallCount.make(8),
  }),
  normal: CallBudget.WindowLimits.make({
    minute: CallBudget.CallCount.make(8),
    day: CallBudget.CallCount.make(8),
  }),
  background: CallBudget.WindowLimits.make({
    minute: CallBudget.CallCount.make(8),
    day: CallBudget.CallCount.make(8),
  }),
})

const configurationLayer = (presetId: Option.Option<PresetId>) =>
  HostConfiguration.layer({
    instanceId: 'test',
    model: Option.some(MODEL_REFERENCE),
    presetId,
    feedbackToolsEnabled: false,
    capabilityVisibility: CapabilitySelection.Visibility.make({
      skills: [],
      actionTools: [],
      feedbackTools: [],
      mcpServers: [],
    }),
  })

const roleStateSnapshot = RoleStateModel.empty(0)
const roleStateLayer = (
  onSuccessfulTurn: (turn: RoleState.SuccessfulTurn) => Effect.Effect<void> = () => Effect.void,
) =>
  Layer.succeed(
    RoleState.Service,
    RoleState.Service.of({
      observe: () => Effect.succeed(roleStateSnapshot),
      recordSuccessfulTurn: (turn) => onSuccessfulTurn(turn).pipe(Effect.as(roleStateSnapshot)),
      materialize: (snapshot) => Effect.succeed(snapshot),
      snapshot: () => Effect.succeed(roleStateSnapshot),
    }),
  )

const arbiterLayer = WakeArbiter.layer({
  cooldownMs: WakeProposal.DurationMilliseconds.make(0),
}).pipe(
  Layer.provide(
    CallBudget.layer({
      limits,
      timeZone: DateTime.zoneMakeNamedUnsafe('UTC'),
    }),
  ),
)

const testLayer = (
  ctx: Context,
  presetId = Option.none<PresetId>(),
  onSuccessfulTurn?: (turn: RoleState.SuccessfulTurn) => Effect.Effect<void>,
) => {
  const turnServices = Layer.mergeAll(
    BackgroundTasks.layer,
    CapabilityRegistry.layer,
    ChannelMessageBuffer.layer,
    configurationLayer(presetId),
    PresetRegistry.layer,
    roleStateLayer(onSuccessfulTurn),
    ThreadTracker.layer,
    arbiterLayer,
  )
  return KoishiInitiativeDelivery.layer(ctx).pipe(Layer.provideMerge(turnServices))
}

const adapter: YokaiAdapter = {
  descriptor: AdapterDescriptor.make({
    id: ADAPTER_ID,
    protocolVersion: CURRENT_ADAPTER_PROTOCOL_VERSION,
    capabilities: { feedbackTools: false },
  }),
  discoverModels: () => Effect.never,
  generate: () =>
    Effect.succeed(
      FinalTextResult.make({
        text: '<output><message quote="focus-message">initiative reply</message></output>',
        finishReason: 'stop',
        usage: GenerationUsage.cases.Unavailable.make({}),
      }),
    ),
  continue: () => Effect.die('not called'),
}

const proposal = (
  now: number,
  initiativeAudit?: WakeProposal.InitiativeAudit,
): WakeProposal.Proposal =>
  WakeProposal.Proposal.make({
    scopeId: WakeProposal.scopeIdOf(SCOPE),
    scope: SCOPE,
    mergeKey: WakeProposal.MergeKey.make('initiative-delivery'),
    kind: 'initiative',
    reason: WakeProposal.Reason.make({
      mechanismId: ResponseMechanismId.make('initiative'),
      code: WakeProposal.ReasonCode.make('eligible'),
      priority: WakeProposal.Priority.make(1),
      ...(initiativeAudit === undefined ? {} : { initiativeAudit }),
    }),
    focus: FocusMessage.make({
      messageId: 'focus-message',
      authorId: 'member',
      timestamp: now,
      content: 'A discussion worth joining.',
    }),
    submittedAt: WakeProposal.EpochMilliseconds.make(now),
    expiresAt: WakeProposal.EpochMilliseconds.make(now + 10_000),
    debounceMs: WakeProposal.DurationMilliseconds.make(0),
    budgetCategory: 'background',
    cooldownPolicy: 'enforce',
  })

it.live('checks runtime availability and dispatches through the admitted wake turn', () => {
  const ctx = new Context()
  const unfinishedThreadId = RoleStateModel.ThreadId.make('audited-unfinished-thread')
  const successfulTurns: Array<RoleState.SuccessfulTurn> = []

  return Effect.scoped(
    Effect.gen(function* () {
      const delivery = yield* InitiativeDelivery.Service
      const registry = yield* CapabilityRegistry.Service
      const sentMessages = yield* Queue.unbounded<SentMessage>()
      const generatedInstructions = yield* Queue.unbounded<string>()
      const admissions = yield* Ref.make(0)
      const bot = new TestBot(ctx, sentMessages)
      const wrongBot = new TestBot(ctx, sentMessages, 'other-bot')
      wrongBot.status = Universal.Status.ONLINE

      expect(yield* delivery.isAvailable(TARGET)).toBe(false)

      const registration = yield* registry.registerAdapter({
        ...adapter,
        generate: (request) =>
          Queue.offer(generatedInstructions, request.systemInstruction ?? '').pipe(
            Effect.andThen(adapter.generate(request)),
          ),
      })
      yield* registration.publishModels(MODEL_SNAPSHOT)
      expect(yield* delivery.isAvailable(TARGET)).toBe(false)

      bot.status = Universal.Status.ONLINE
      expect(yield* delivery.isAvailable(TARGET)).toBe(true)

      const now = Date.now()
      const outcome = yield* delivery.dispatch({
        target: TARGET,
        proposal: proposal(
          now,
          WakeProposal.InitiativeAudit.cases.UnfinishedTopic.make({
            threadId: unfinishedThreadId,
            stateUpdatedAt: RoleStateModel.EpochMilliseconds.make(now),
          }),
        ),
        admission: () => Ref.update(admissions, (count) => count + 1).pipe(Effect.as(true)),
      })

      expect(outcome._tag).toBe('Executed')
      expect(yield* Ref.get(admissions)).toBe(1)
      const instruction = yield* Queue.take(generatedInstructions)
      expect(instruction).toContain('You may speak naturally or return silence.')
      expect(instruction).toContain(
        `The audited motive is to follow up unfinished thread ${JSON.stringify(unfinishedThreadId)}`,
      )
      expect(yield* Queue.take(sentMessages)).toEqual({
        channelId: 'channel',
        content: '<quote id="focus-message"/>initiative reply',
        guildId: 'guild',
      })
      const unfinishedTurn = successfulTurns[0]
      if (unfinishedTurn === undefined) return yield* Effect.die('Expected unfinished turn')
      expect(unfinishedTurn.threadId).toEqual(Option.some(unfinishedThreadId))

      const intrinsicNow = Date.now()
      const intrinsicOutcome = yield* delivery.dispatch({
        target: TARGET,
        proposal: proposal(
          intrinsicNow,
          WakeProposal.InitiativeAudit.cases.IntrinsicOpportunity.make({
            sources: ['persona-interest'],
            presetVersion: PresetVersion.make(1),
            stateUpdatedAt: RoleStateModel.EpochMilliseconds.make(intrinsicNow),
            selfNoteIds: [],
          }),
        ),
        admission: () => Effect.succeed(true),
      })
      expect(intrinsicOutcome._tag).toBe('Executed')
      const intrinsicInstruction = yield* Queue.take(generatedInstructions)
      expect(intrinsicInstruction).toContain(
        'The audited motive is role-intrinsic. No topic or message text has been selected for you by the host',
      )
      const intrinsicTurn = successfulTurns[1]
      if (intrinsicTurn === undefined) return yield* Effect.die('Expected intrinsic turn')
      expect(intrinsicTurn.threadId).toEqual(Option.none())
    }).pipe(
      Effect.provide(
        testLayer(ctx, Option.none(), (turn) =>
          Effect.sync(() => {
            successfulTurns.push(turn)
          }),
        ),
      ),
    ),
  )
})

it.effect('requires a configured preset to have a current snapshot', () => {
  const ctx = new Context()

  return Effect.scoped(
    Effect.gen(function* () {
      const delivery = yield* InitiativeDelivery.Service
      const registry = yield* CapabilityRegistry.Service
      const sentMessages = yield* Queue.unbounded<SentMessage>()
      const bot = new TestBot(ctx, sentMessages)
      bot.status = Universal.Status.ONLINE

      const registration = yield* registry.registerAdapter(adapter)
      yield* registration.publishModels(MODEL_SNAPSHOT)

      expect(yield* delivery.isAvailable(TARGET)).toBe(false)
    }).pipe(Effect.provide(testLayer(ctx, Option.some(PresetId.make('missing-preset'))))),
  )
})

it.effect('fails with a typed scope error when no matching bot is online', () => {
  const ctx = new Context()
  const now = Date.now()

  return Effect.gen(function* () {
    const delivery = yield* InitiativeDelivery.Service
    const error = yield* delivery
      .dispatch({
        target: TARGET,
        proposal: proposal(now),
        admission: () => Effect.die('not called'),
      })
      .pipe(Effect.flip)

    expect(error).toMatchObject({
      _tag: 'InitiativeDeliveryDispatchError',
      scopeId: WakeProposal.scopeIdOf(SCOPE),
    })
  }).pipe(Effect.provide(testLayer(ctx)))
})
