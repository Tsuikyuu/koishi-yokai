import { ThreadScene } from '@yokai-internal/mind'
import { expect, it } from '@effect/vitest'
import { CapabilityScope, FocusMessage } from 'yokai-protocol'
import { Duration, Effect, Option } from 'effect'
import { TestClock } from 'effect/testing'

import { EngagementLease, WakeMessage, WakeProposal } from '../../../src/index'

const SCOPE = CapabilityScope.make({
  instanceId: 'engagement-test',
  platform: 'test',
  guildId: 'guild',
  channelId: 'channel',
})

const OTHER_SCOPE = CapabilityScope.make({ ...SCOPE, channelId: 'other-channel' })

const options = (
  idleTtlMs = 1_000,
  maxDurationMs = 5_000,
  maxRounds = 3,
  enabled = true,
): EngagementLease.Options =>
  EngagementLease.Options.make({
    enabled,
    idleTtlMs: EngagementLease.PositiveDurationMilliseconds.make(idleTtlMs),
    maxDurationMs: EngagementLease.PositiveDurationMilliseconds.make(maxDurationMs),
    maxRounds: EngagementLease.RoundCount.make(maxRounds),
    debounceMs: WakeProposal.DurationMilliseconds.make(500),
    proposalTtlMs: EngagementLease.PositiveDurationMilliseconds.make(10_000),
  })

const message = (
  messageId: string,
  authorId = 'alice',
  overrides: Partial<WakeMessage.Message> = {},
): WakeMessage.Message =>
  WakeMessage.Message.make({
    scope: SCOPE,
    focus: FocusMessage.make({
      messageId,
      authorId,
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

const scene = (
  threadId = 'thread:topic',
  direction: ThreadScene.DirectionKind = 'group',
): ThreadScene.Scene =>
  ThreadScene.Scene.make({
    thread: ThreadScene.ThreadState.make({
      id: ThreadScene.ThreadId.make(threadId),
      summary: ThreadScene.TopicSummary.make('topic'),
      participants: [ThreadScene.ParticipantId.make('alice')],
      mode: 'chat',
      activity: ThreadScene.Activity.make(1),
      lastActiveAt: ThreadScene.EpochMilliseconds.make(0),
      messageCount: 1,
      recentMessages: [],
      keywords: [],
      openQuestion: Option.none(),
      sufficientResponse: false,
    }),
    activeThreadCount: 1,
    direction: ThreadScene.Direction.make({
      kind: direction,
      targetParticipantId:
        direction === 'participant'
          ? Option.some(ThreadScene.ParticipantId.make('bob'))
          : Option.none(),
    }),
    interruptsOthers: false,
    sufficientResponse: false,
  })

const requireCandidate = <A>(candidate: Option.Option<A>): Effect.Effect<A> =>
  Option.match(candidate, {
    onNone: () => Effect.die('Expected an engagement candidate'),
    onSome: Effect.succeed,
  })

const requireSnapshot = <A>(snapshot: Option.Option<A>): Effect.Effect<A> =>
  Option.match(snapshot, {
    onNone: () => Effect.die('Expected an engagement lease snapshot'),
    onSome: Effect.succeed,
  })

it.effect(
  'opens only for effective human mentions and replies without extending a matching lease',
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const leases = yield* EngagementLease.Service
      const scopeId = WakeProposal.scopeIdOf(SCOPE)

      const invalidDirectMessages = [
        message('duplicate', 'alice', {
          explicitMention: true,
          hardReplyKind: 'explicit-mention',
          isDuplicate: true,
        }),
        message('other-bot', 'alice', {
          explicitMention: true,
          hardReplyKind: 'explicit-mention',
          isOtherBot: true,
        }),
        message('self', 'alice', {
          explicitMention: true,
          hardReplyKind: 'explicit-mention',
          isSelf: true,
        }),
        message('empty', 'alice', {
          explicitMention: true,
          hardReplyKind: 'explicit-mention',
          isEffective: false,
        }),
      ]
      for (const invalid of invalidDirectMessages) {
        expect(Option.isNone(yield* leases.observe(invalid, scene()))).toBe(true)
      }
      expect(
        Option.isNone(
          yield* leases.observe(message('name', 'alice', { presetNameMatch: 'prefix' }), scene()),
        ),
      ).toBe(true)
      expect(
        Option.isNone(
          yield* leases.observe(message('soft-reply', 'alice', { replyToSelf: true }), scene()),
        ),
      ).toBe(true)
      expect(
        Option.isNone(
          yield* leases.observe(
            message('hard-name', 'alice', {
              presetNameMatch: 'prefix',
              hardReplyKind: 'role-name-prefix',
            }),
            scene(),
          ),
        ),
      ).toBe(true)
      expect(Option.isNone(yield* leases.snapshot(scopeId))).toBe(true)

      expect(
        Option.isNone(
          yield* leases.observe(
            message('mention', 'alice', {
              explicitMention: true,
              hardReplyKind: 'explicit-mention',
            }),
            scene(),
          ),
        ),
      ).toBe(true)
      const opened = yield* requireSnapshot(yield* leases.snapshot(scopeId))
      expect(opened).toMatchObject({
        anchorMessageId: 'mention',
        participants: ['alice'],
        startedAt: 0,
        idleExpiresAt: 1_000,
        absoluteExpiresAt: 5_000,
        remainingRounds: 3,
      })

      yield* TestClock.adjust(Duration.millis(400))
      yield* leases.observe(
        message('reply', 'alice', { replyToSelf: true, hardReplyKind: 'reply-to-self' }),
        scene(),
      )
      yield* leases.observe(
        message('bob-reply', 'bob', { replyToSelf: true, hardReplyKind: 'reply-to-self' }),
        scene(),
      )
      const unchanged = yield* requireSnapshot(yield* leases.snapshot(scopeId))
      expect(unchanged).toMatchObject({
        id: opened.id,
        anchorMessageId: 'mention',
        participants: ['alice', 'bob'],
        startedAt: 0,
        idleExpiresAt: 1_000,
        absoluteExpiresAt: 5_000,
        remainingRounds: 3,
      })
    }).pipe(Effect.provide(EngagementLease.layer(options()))),
)

it.effect('emits a local engagement proposal and renews only when its admission succeeds', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const leases = yield* EngagementLease.Service
    const scopeId = WakeProposal.scopeIdOf(SCOPE)
    yield* leases.observe(
      message('anchor', 'alice', {
        explicitMention: true,
        hardReplyKind: 'explicit-mention',
      }),
      scene(),
    )

    yield* TestClock.adjust(Duration.millis(400))
    expect(
      Option.isNone(
        yield* leases.observe(
          message('hard-name', 'alice', {
            presetNameMatch: 'prefix',
            hardReplyKind: 'role-name-prefix',
          }),
          scene(),
        ),
      ),
    ).toBe(true)
    expect(yield* requireSnapshot(yield* leases.snapshot(scopeId))).toMatchObject({
      remainingRounds: 3,
      idleExpiresAt: 1_000,
    })
    expect(
      Option.isSome(
        yield* leases.observe(
          message('soft-name', 'alice', { presetNameMatch: 'prefix' }),
          scene(),
        ),
      ),
    ).toBe(true)
    const candidate = yield* requireCandidate(
      yield* leases.observe(message('soft-reply', 'alice', { replyToSelf: true }), scene()),
    )
    expect(candidate.proposal).toMatchObject({
      scopeId,
      mergeKey: WakeProposal.CHANNEL_CONVERSATION_MERGE_KEY,
      kind: 'engagement',
      reason: {
        mechanismId: WakeProposal.ENGAGEMENT_MECHANISM_ID,
        code: EngagementLease.ENGAGEMENT_REASON_CODE,
        priority: 80,
      },
      submittedAt: 400,
      expiresAt: 1_000,
      debounceMs: 500,
      budgetCategory: 'reserved',
      cooldownPolicy: 'bypass',
    })

    const beforeAdmission = yield* requireSnapshot(yield* leases.snapshot(scopeId))
    expect(beforeAdmission).toMatchObject({ remainingRounds: 3, idleExpiresAt: 1_000 })
    expect(yield* candidate.admission()).toBe(true)
    const accepted = yield* requireSnapshot(yield* leases.snapshot(scopeId))
    expect(accepted).toMatchObject({
      remainingRounds: 2,
      idleExpiresAt: 1_400,
      absoluteExpiresAt: 5_000,
    })

    expect(yield* candidate.admission()).toBe(false)
    expect(yield* leases.snapshot(scopeId)).toEqual(Option.some(accepted))
  }).pipe(Effect.provide(EngagementLease.layer(options()))),
)

it.effect('closes a shifted lease before suppressing a role-name hard reply', () =>
  Effect.gen(function* () {
    const leases = yield* EngagementLease.Service
    const scopeId = WakeProposal.scopeIdOf(SCOPE)
    yield* leases.observe(
      message('anchor', 'alice', {
        explicitMention: true,
        hardReplyKind: 'explicit-mention',
      }),
      scene(),
    )
    const pending = yield* requireCandidate(
      yield* leases.observe(message('pending', 'alice'), scene()),
    )

    expect(
      Option.isNone(
        yield* leases.observe(
          message('new-topic-hard-name', 'alice', {
            presetNameMatch: 'prefix',
            hardReplyKind: 'role-name-prefix',
          }),
          scene('thread:other'),
        ),
      ),
    ).toBe(true)
    expect(Option.isNone(yield* leases.snapshot(scopeId))).toBe(true)
    expect(yield* pending.admission()).toBe(false)
  }).pipe(Effect.provide(EngagementLease.layer(options()))),
)

it.effect('caps renewal at the absolute deadline and expires on exact time boundaries', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const leases = yield* EngagementLease.Service
    const scopeId = WakeProposal.scopeIdOf(SCOPE)
    yield* leases.observe(
      message('anchor', 'alice', {
        explicitMention: true,
        hardReplyKind: 'explicit-mention',
      }),
      scene(),
    )

    yield* TestClock.adjust(Duration.millis(900))
    const first = yield* requireCandidate(yield* leases.observe(message('first'), scene()))
    expect(yield* first.admission()).toBe(true)
    expect(yield* requireSnapshot(yield* leases.snapshot(scopeId))).toMatchObject({
      idleExpiresAt: 1_900,
      absoluteExpiresAt: 2_500,
    })

    yield* TestClock.adjust(Duration.millis(900))
    const second = yield* requireCandidate(yield* leases.observe(message('second'), scene()))
    expect(yield* second.admission()).toBe(true)
    expect(yield* requireSnapshot(yield* leases.snapshot(scopeId))).toMatchObject({
      idleExpiresAt: 2_500,
      absoluteExpiresAt: 2_500,
    })

    yield* TestClock.adjust(Duration.millis(700))
    expect(Option.isNone(yield* leases.snapshot(scopeId))).toBe(true)
    expect(yield* second.admission()).toBe(false)
  }).pipe(Effect.provide(EngagementLease.layer(options(1_000, 2_500, 3)))),
)

it.effect('rejects a pending claim at the exact idle boundary', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const leases = yield* EngagementLease.Service
    const scopeId = WakeProposal.scopeIdOf(SCOPE)
    yield* leases.observe(
      message('anchor', 'alice', {
        explicitMention: true,
        hardReplyKind: 'explicit-mention',
      }),
      scene(),
    )
    yield* TestClock.adjust(Duration.millis(900))
    const pending = yield* requireCandidate(yield* leases.observe(message('pending'), scene()))

    yield* TestClock.adjust(Duration.millis(100))
    expect(yield* pending.admission()).toBe(false)
    expect(Option.isNone(yield* leases.snapshot(scopeId))).toBe(true)
  }).pipe(Effect.provide(EngagementLease.layer(options()))),
)

it.effect('removes only shifting participants and ignores non-participants', () =>
  Effect.gen(function* () {
    const leases = yield* EngagementLease.Service
    const scopeId = WakeProposal.scopeIdOf(SCOPE)
    yield* leases.observe(
      message('anchor', 'alice', {
        explicitMention: true,
        hardReplyKind: 'explicit-mention',
      }),
      scene(),
    )
    yield* leases.observe(
      message('bob-anchor', 'bob', {
        explicitMention: true,
        hardReplyKind: 'explicit-mention',
      }),
      scene(),
    )

    expect(
      Option.isNone(yield* leases.observe(message('outsider', 'carol'), scene('thread:other'))),
    ).toBe(true)
    expect(yield* requireSnapshot(yield* leases.snapshot(scopeId))).toMatchObject({
      participants: ['alice', 'bob'],
    })

    expect(
      Option.isNone(
        yield* leases.observe(message('alice-to-bob'), scene('thread:topic', 'participant')),
      ),
    ).toBe(true)
    expect(yield* requireSnapshot(yield* leases.snapshot(scopeId))).toMatchObject({
      participants: ['bob'],
    })
    expect(Option.isNone(yield* leases.observe(message('alice-later'), scene()))).toBe(true)

    expect(
      Option.isNone(
        yield* leases.observe(
          message('bob-new-topic', 'bob', { replyToSelf: true }),
          scene('thread:other'),
        ),
      ),
    ).toBe(true)
    expect(Option.isNone(yield* leases.snapshot(scopeId))).toBe(true)
  }).pipe(Effect.provide(EngagementLease.layer(options()))),
)

it.effect('replaces an active lease only for a direct trigger in a new thread', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const leases = yield* EngagementLease.Service
    const scopeId = WakeProposal.scopeIdOf(SCOPE)
    yield* leases.observe(
      message('first-anchor', 'alice', {
        explicitMention: true,
        hardReplyKind: 'explicit-mention',
      }),
      scene(),
    )
    const first = yield* requireSnapshot(yield* leases.snapshot(scopeId))

    yield* TestClock.adjust(Duration.millis(300))
    yield* leases.observe(
      message('second-anchor', 'alice', {
        replyToSelf: true,
        hardReplyKind: 'reply-to-self',
      }),
      scene('thread:second'),
    )
    const second = yield* requireSnapshot(yield* leases.snapshot(scopeId))
    expect(second.id).not.toBe(first.id)
    expect(second).toMatchObject({
      threadId: 'thread:second',
      anchorMessageId: 'second-anchor',
      participants: ['alice'],
      startedAt: 300,
      idleExpiresAt: 1_300,
      absoluteExpiresAt: 5_300,
      remainingRounds: 3,
    })
  }).pipe(Effect.provide(EngagementLease.layer(options()))),
)

it.effect('serializes concurrent admission claims and closes when rounds reach zero', () =>
  Effect.gen(function* () {
    const leases = yield* EngagementLease.Service
    const scopeId = WakeProposal.scopeIdOf(SCOPE)
    yield* leases.observe(
      message('anchor', 'alice', {
        explicitMention: true,
        hardReplyKind: 'explicit-mention',
      }),
      scene(),
    )
    const first = yield* requireCandidate(yield* leases.observe(message('first'), scene()))
    const second = yield* requireCandidate(yield* leases.observe(message('second'), scene()))

    const results = yield* Effect.all([first.admission(), second.admission()], {
      concurrency: 'unbounded',
    })
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(Option.isNone(yield* leases.snapshot(scopeId))).toBe(true)
  }).pipe(Effect.provide(EngagementLease.layer(options(1_000, 5_000, 1)))),
)

it.effect('isolates scopes, supports explicit close, and prunes expired leases', () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const leases = yield* EngagementLease.Service
    const scopeId = WakeProposal.scopeIdOf(SCOPE)
    const otherScopeId = WakeProposal.scopeIdOf(OTHER_SCOPE)
    yield* leases.observe(
      message('anchor', 'alice', {
        explicitMention: true,
        hardReplyKind: 'explicit-mention',
      }),
      scene(),
    )
    yield* leases.observe(
      message('other-anchor', 'bob', {
        scope: OTHER_SCOPE,
        explicitMention: true,
        hardReplyKind: 'explicit-mention',
      }),
      scene('thread:other'),
    )
    expect(Option.isSome(yield* leases.snapshot(scopeId))).toBe(true)
    expect(Option.isSome(yield* leases.snapshot(otherScopeId))).toBe(true)
    expect(yield* leases.close(scopeId)).toBe(true)
    expect(yield* leases.close(scopeId)).toBe(false)

    yield* TestClock.adjust(Duration.millis(1_000))
    yield* leases.observe(message('cleanup'), scene())
    expect(yield* leases.close(otherScopeId)).toBe(false)
  }).pipe(Effect.provide(EngagementLease.layer(options()))),
)

it.effect('does not create leases while disabled', () =>
  Effect.gen(function* () {
    const leases = yield* EngagementLease.Service
    const scopeId = WakeProposal.scopeIdOf(SCOPE)
    expect(
      Option.isNone(
        yield* leases.observe(
          message('anchor', 'alice', {
            explicitMention: true,
            hardReplyKind: 'explicit-mention',
          }),
          scene(),
        ),
      ),
    ).toBe(true)
    expect(Option.isNone(yield* leases.snapshot(scopeId))).toBe(true)
  }).pipe(Effect.provide(EngagementLease.layer(options(1_000, 5_000, 3, false)))),
)
