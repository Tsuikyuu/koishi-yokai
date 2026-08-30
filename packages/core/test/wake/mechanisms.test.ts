import { expect, it } from '@effect/vitest'
import { MessageArchiveEvent } from '@yokai-internal/memory'
import { CapabilityScope, FocusMessage } from 'yokai-protocol'
import { DateTime, Duration, Effect, Layer, Option } from 'effect'
import { TestClock } from 'effect/testing'

import {
  ActivityGateValue,
  ActivityResponseMechanism,
  CallBudget,
  DirectResponseMechanism,
  WakeArbiter,
  WakeMessage,
  WakeProposal,
} from '../../src/index'
import { ScheduledTaskModel } from '../../src/schedule/model'

const SCOPE = CapabilityScope.make({
  instanceId: 'test',
  platform: 'test',
  guildId: 'guild',
  channelId: 'channel',
})

const scheduledTask = (
  idCharacter: string,
  occurrence: number,
  dueAt = 10_000,
): ScheduledTaskModel.Task =>
  ScheduledTaskModel.Task.make({
    instanceId: MessageArchiveEvent.InstanceId.make('test'),
    platform: MessageArchiveEvent.PlatformId.make('test'),
    guildId: MessageArchiveEvent.GuildId.make('guild'),
    channelId: MessageArchiveEvent.ChannelId.make('channel'),
    scheduleId: ScheduledTaskModel.ScheduleId.make(`schedule_${idCharacter.repeat(32)}`),
    dedupeKey: ScheduledTaskModel.DedupeKey.make(`dedupe-${idCharacter}`),
    creationFingerprint: ScheduledTaskModel.CreationFingerprint.make(idCharacter.repeat(64)),
    createdMessageId: MessageArchiveEvent.MessageId.make(`message-${idCharacter}`),
    creatorId: MessageArchiveEvent.ActorId.make('user'),
    selfId: MessageArchiveEvent.ActorId.make('bot'),
    reason: ScheduledTaskModel.Reason.make('Attend class'),
    dueAt: ScheduledTaskModel.EpochMilliseconds.make(dueAt),
    repeatEveryMs: Option.none(),
    timeZone: ScheduledTaskModel.TimeZoneId.make('Asia/Shanghai'),
    status: 'triggered',
    occurrence: ScheduledTaskModel.Occurrence.make(occurrence),
    revision: ScheduledTaskModel.Revision.make(occurrence + 1),
    createdAt: ScheduledTaskModel.EpochMilliseconds.make(0),
    updatedAt: ScheduledTaskModel.EpochMilliseconds.make(dueAt),
    lastTriggeredAt: Option.some(ScheduledTaskModel.EpochMilliseconds.make(dueAt)),
  })

const message = (
  messageId: string,
  overrides: Partial<WakeMessage.Message> = {},
): WakeMessage.Message =>
  WakeMessage.Message.make({
    scope: SCOPE,
    focus: FocusMessage.make({
      messageId,
      authorId: 'user',
      timestamp: 0,
      content: messageId,
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
    localState: WakeMessage.emptyLocalStateSignals(),
    ...overrides,
  })

const mechanismLayer = Layer.merge(
  DirectResponseMechanism.layer(),
  ActivityResponseMechanism.layer().pipe(
    Layer.provide(
      WakeArbiter.layer().pipe(
        Layer.provide(
          CallBudget.layer({
            limits: CallBudget.ClassifiedLimits.make({
              reserved: CallBudget.WindowLimits.make({
                minute: CallBudget.CallCount.make(100),
                day: CallBudget.CallCount.make(100),
              }),
              normal: CallBudget.WindowLimits.make({
                minute: CallBudget.CallCount.make(100),
                day: CallBudget.CallCount.make(100),
              }),
              background: CallBudget.WindowLimits.make({
                minute: CallBudget.CallCount.make(100),
                day: CallBudget.CallCount.make(100),
              }),
            }),
            timeZone: DateTime.zoneMakeNamedUnsafe('UTC'),
          }),
        ),
      ),
    ),
  ),
)

it.effect('uses the direct window for all hard reply kinds and following supplements', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const direct = yield* DirectResponseMechanism.Service

    const mention = yield* direct.observe(
      message('mention', { explicitMention: true, hardReplyKind: 'explicit-mention' }),
    )
    expect(Option.isSome(mention)).toBe(true)
    if (Option.isNone(mention)) return yield* Effect.die('Expected direct mention proposal')
    expect(mention.value.reason.code).toBe('explicit-mention')
    expect(mention.value.budgetCategory).toBe('reserved')
    expect(mention.value.cooldownPolicy).toBe('bypass')

    const reply = yield* direct.observe(
      message('reply', { replyToSelf: true, hardReplyKind: 'reply-to-self' }),
    )
    expect(Option.isSome(reply)).toBe(true)
    if (Option.isNone(reply)) return yield* Effect.die('Expected direct reply proposal')
    expect(reply.value.reason.code).toBe('reply-to-self')

    const prefix = yield* direct.observe(
      message('prefix', {
        presetNameMatch: 'prefix',
        hardReplyKind: 'role-name-prefix',
      }),
    )
    expect(Option.isSome(prefix)).toBe(true)
    if (Option.isNone(prefix)) return yield* Effect.die('Expected role-name prefix proposal')
    expect(prefix.value.reason.code).toBe('role-name-prefix')

    const contains = yield* direct.observe(
      message('contains', {
        presetNameMatch: 'contains',
        hardReplyKind: 'role-name-contains',
      }),
    )
    expect(Option.isSome(contains)).toBe(true)
    if (Option.isNone(contains)) return yield* Effect.die('Expected role-name contains proposal')
    expect(contains.value.reason.code).toBe('role-name-contains')

    const supplement = yield* direct.observe(message('supplement'))
    expect(Option.isSome(supplement)).toBe(true)
    if (Option.isNone(supplement)) return yield* Effect.die('Expected supplement proposal')
    expect(supplement.value.mergeKey).toBe(mention.value.mergeKey)
    expect(supplement.value.reason.priority).toBeLessThan(mention.value.reason.priority)

    const otherAuthor = yield* direct.observe(
      message('other', {
        focus: FocusMessage.make({
          messageId: 'other',
          authorId: 'other-user',
          timestamp: 0,
          content: 'other',
        }),
      }),
    )
    expect(Option.isNone(otherAuthor)).toBe(true)

    yield* TestClock.adjust(Duration.millis(501))
    expect(Option.isNone(yield* direct.observe(message('late-supplement')))).toBe(true)
    const softNameMatch = message('role-name', { presetNameMatch: 'prefix' })
    expect(WakeMessage.isHardTrigger(softNameMatch)).toBe(false)
    expect(Option.isNone(yield* direct.observe(softNameMatch))).toBe(true)

    const softReply = message('soft-reply', { replyToSelf: true })
    expect(WakeMessage.isDirectedToSelf(softReply)).toBe(true)
    expect(WakeMessage.isHardTrigger(softReply)).toBe(false)
    expect(WakeMessage.isLeaseAnchorTrigger(softReply)).toBe(false)
    expect(Option.isNone(yield* direct.observe(softReply))).toBe(true)
  }).pipe(Effect.provide(DirectResponseMechanism.layer())),
)

it('creates reserved scheduled proposals that are unique per task occurrence', () => {
  const atGraceBoundary = scheduledTask('a', 0, 9_000)
  const nextOccurrence = scheduledTask('a', 1, 12_000)
  const otherTask = scheduledTask('b', 0, 9_000)
  const gracePeriodMs = WakeProposal.DurationMilliseconds.make(1_000)
  const first = WakeProposal.scheduledTask(atGraceBoundary, 10_000, gracePeriodMs)
  const second = WakeProposal.scheduledTask(nextOccurrence, 12_000, gracePeriodMs)
  const other = WakeProposal.scheduledTask(otherTask, 10_000, gracePeriodMs)

  expect(first).toMatchObject({
    kind: 'schedule',
    submittedAt: 10_000,
    debounceMs: 0,
    budgetCategory: 'reserved',
    cooldownPolicy: 'bypass',
    reason: {
      mechanismId: WakeProposal.SCHEDULE_MECHANISM_ID,
      code: WakeProposal.SCHEDULE_REASON_CODE,
      priority: WakeProposal.SCHEDULE_PRIORITY,
    },
    focus: {
      messageId: atGraceBoundary.createdMessageId,
      authorId: atGraceBoundary.creatorId,
      timestamp: atGraceBoundary.dueAt,
    },
  })
  expect(first.expiresAt).toBeGreaterThan(10_000)
  expect(first.scopeId).toBe(WakeProposal.scopeIdOf(SCOPE))
  expect(first.mergeKey).not.toBe(second.mergeKey)
  expect(first.mergeKey).not.toBe(other.mergeKey)
  expect(WakeProposal.identityOf(first)).not.toBe(WakeProposal.identityOf(second))
  expect(WakeProposal.identityOf(first)).not.toBe(WakeProposal.identityOf(other))
})

it.effect('keeps activity local until both documented thresholds pass', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const activity = yield* ActivityResponseMechanism.Service

    for (let index = 1; index <= 5; index += 1) {
      expect(
        Option.isNone(
          yield* activity.observe(message(`question-${index}`, { isQuestionOrHelp: true })),
        ),
      ).toBe(true)
    }

    const triggered = yield* activity.observe(message('question-6', { isQuestionOrHelp: true }))
    expect(Option.isSome(triggered)).toBe(true)
    if (Option.isNone(triggered)) return yield* Effect.die('Expected activity proposal')
    expect(triggered.value.reason.code).toBe('social-threshold')
    expect(triggered.value.budgetCategory).toBe('normal')
    expect(triggered.value.cooldownPolicy).toBe('enforce')
    expect(triggered.value.debounceMs).toBe(3_000)

    const beforeConsume = yield* activity.snapshot(WakeProposal.scopeIdOf(SCOPE))
    expect(beforeConsume.activity).toBeGreaterThanOrEqual(7)
    yield* activity.consume(WakeProposal.scopeIdOf(SCOPE))
    expect((yield* activity.snapshot(WakeProposal.scopeIdOf(SCOPE))).activity).toBe(0)
  }).pipe(Effect.provide(mechanismLayer)),
)

it.effect('excludes duplicate, self, and other-bot messages from activity proposals', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const activity = yield* ActivityResponseMechanism.Service
    const excluded = [
      message('duplicate', { isDuplicate: true, isQuestionOrHelp: true }),
      message('self', { isSelf: true, isQuestionOrHelp: true }),
      message('other-bot', { isOtherBot: true, isQuestionOrHelp: true }),
    ]

    for (const candidate of excluded) {
      expect(Option.isNone(yield* activity.observe(candidate))).toBe(true)
    }
    expect((yield* activity.snapshot(WakeProposal.scopeIdOf(SCOPE))).activity).toBe(0)
  }).pipe(Effect.provide(mechanismLayer)),
)

it.effect('applies persisted participation pressure and unfinished-item evidence locally', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const activity = yield* ActivityResponseMechanism.Service
    const pressured = WakeMessage.LocalStateSignals.make({
      unfinishedItemEvidence: ActivityGateValue.Score.make(0),
      threadOrInterestEvidence: ActivityGateValue.Score.make(0),
      recentParticipationPressure: ActivityGateValue.Pressure.make(1),
      sufficientResponsePressure: ActivityGateValue.Pressure.make(0),
    })

    for (let index = 1; index <= 6; index += 1) {
      expect(
        Option.isNone(
          yield* activity.observe(
            message(`pressured-${index}`, {
              isQuestionOrHelp: true,
              localState: pressured,
            }),
          ),
        ),
      ).toBe(true)
    }

    const unfinished = WakeMessage.LocalStateSignals.make({
      ...pressured,
      unfinishedItemEvidence: ActivityGateValue.Score.make(3),
    })
    expect(
      Option.isSome(
        yield* activity.observe(
          message('unfinished-follow-up', {
            isQuestionOrHelp: true,
            localState: unfinished,
          }),
        ),
      ),
    ).toBe(true)
  }).pipe(Effect.provide(mechanismLayer)),
)
