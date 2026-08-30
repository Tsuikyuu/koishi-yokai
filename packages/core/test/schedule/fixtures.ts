import { Context, Effect, Layer, Option, Ref } from 'effect'

import { MessageArchive, MessageArchiveEvent } from '@yokai-internal/memory'
import { ScheduledTask, ScheduledTaskModel, ScheduledTaskStorage } from '../../src/index'

export const INSTANCE_ID = MessageArchiveEvent.InstanceId.make('schedule-test')
export const OTHER_INSTANCE_ID = MessageArchiveEvent.InstanceId.make('schedule-other')

export const SCOPE = MessageArchiveEvent.ChannelScope.make({
  instanceId: INSTANCE_ID,
  platform: MessageArchiveEvent.PlatformId.make('test'),
  guildId: MessageArchiveEvent.GuildId.make('guild'),
  channelId: MessageArchiveEvent.ChannelId.make('channel'),
})

export const OTHER_SCOPE = MessageArchiveEvent.ChannelScope.make({
  ...SCOPE,
  channelId: MessageArchiveEvent.ChannelId.make('other-channel'),
})

export const OTHER_INSTANCE_SCOPE = MessageArchiveEvent.ChannelScope.make({
  ...SCOPE,
  instanceId: OTHER_INSTANCE_ID,
})

export const SOURCE_ID = MessageArchiveEvent.MessageId.make('schedule-source')
export const MISSING_SOURCE_ID = MessageArchiveEvent.MessageId.make('missing-source')
export const CREATOR_ID = MessageArchiveEvent.ActorId.make('alice')
export const SELF_ID = MessageArchiveEvent.ActorId.make('yokai')

const sameScope = (
  left: MessageArchiveEvent.ChannelScope,
  right: MessageArchiveEvent.ChannelScope,
): boolean =>
  left.instanceId === right.instanceId &&
  left.platform === right.platform &&
  left.guildId === right.guildId &&
  left.channelId === right.channelId

const archived = (
  scope: MessageArchiveEvent.ChannelScope,
  messageId: MessageArchiveEvent.MessageId,
): MessageArchiveEvent.ArchivedMessage =>
  MessageArchiveEvent.ArchivedMessage.make({
    ...scope,
    messageId,
    version: MessageArchiveEvent.MessageVersion.make(1),
    sourceVersion: Option.none(),
    previousVersion: Option.none(),
    kind: 'created',
    authorId: CREATOR_ID,
    selfId: SELF_ID,
    replyToMessageId: Option.none(),
    timestamp: MessageArchiveEvent.Timestamp.make(0),
    eventTimestamp: MessageArchiveEvent.Timestamp.make(0),
    recordedAt: MessageArchiveEvent.Timestamp.make(0),
    content: 'schedule source',
    isSelf: false,
  })

export const archiveLayer = Layer.succeed(
  MessageArchive.Service,
  MessageArchive.Service.of({
    record: () => Effect.die('MessageArchive.record is not used by schedule tests'),
    latest: (scope, messageId) =>
      Effect.succeed(
        messageId === SOURCE_ID
          ? Option.some(archived(scope, messageId))
          : Option.none<MessageArchiveEvent.ArchivedMessage>(),
      ),
    versions: () => Effect.succeed([]),
  }),
)

interface TestStorageInterface extends ScheduledTaskStorage.Interface {
  readonly all: () => Effect.Effect<ReadonlyArray<ScheduledTaskModel.Task>>
  readonly seed: (task: ScheduledTaskModel.Task) => Effect.Effect<void>
}

export class TestStorage extends Context.Service<TestStorage, TestStorageInterface>()(
  '@yokai/core/ScheduledTaskStorage/Test',
) {}

const taskKeyEqual = (left: ScheduledTaskModel.Task, right: ScheduledTaskModel.Task): boolean =>
  sameScope(ScheduledTaskModel.scopeOf(left), right) && left.scheduleId === right.scheduleId

const compareTask = (left: ScheduledTaskModel.Task, right: ScheduledTaskModel.Task): number => {
  if (left.dueAt < right.dueAt) return -1
  if (left.dueAt > right.dueAt) return 1
  if (left.scheduleId < right.scheduleId) return -1
  if (left.scheduleId > right.scheduleId) return 1
  return 0
}

const matchesQuery = (
  task: ScheduledTaskModel.Task,
  request: ScheduledTaskModel.QueryRequest,
): boolean =>
  sameScope(ScheduledTaskModel.scopeOf(task), request.scope) &&
  request.statuses.includes(task.status) &&
  (Option.isNone(request.creatorId) || task.creatorId === request.creatorId.value) &&
  (Option.isNone(request.dueFrom) || task.dueAt >= request.dueFrom.value) &&
  (Option.isNone(request.dueUntil) || task.dueAt <= request.dueUntil.value)

const expectedEqual = (
  current: ScheduledTaskModel.Task,
  expected: ScheduledTaskModel.Task,
): boolean =>
  taskKeyEqual(current, expected) &&
  current.revision === expected.revision &&
  current.status === expected.status &&
  current.dueAt === expected.dueAt &&
  current.occurrence === expected.occurrence

export const storageLayer = Layer.effectContext(
  Effect.gen(function* () {
    const tasks = yield* Ref.make<ReadonlyArray<ScheduledTaskModel.Task>>([])
    const service = TestStorage.of({
      create: Effect.fn('ScheduledTaskTestStorage.create')(function* (incoming) {
        return yield* Ref.modify(
          tasks,
          (
            current,
          ): readonly [
            ScheduledTaskStorage.CreateResult,
            ReadonlyArray<ScheduledTaskModel.Task>,
          ] => {
            const existing = current.find((task) => taskKeyEqual(task, incoming))
            if (existing === undefined) {
              return [
                ScheduledTaskStorage.CreateResult.Stored({ task: incoming }),
                [...current, incoming],
              ]
            }
            return existing.creationFingerprint === incoming.creationFingerprint
              ? [ScheduledTaskStorage.CreateResult.Replay({ task: existing }), current]
              : [ScheduledTaskStorage.CreateResult.Conflict({ task: existing }), current]
          },
        )
      }),
      get: Effect.fn('ScheduledTaskTestStorage.get')(function* (scope, scheduleId) {
        return Option.fromUndefinedOr(
          (yield* Ref.get(tasks)).find(
            (task) =>
              sameScope(ScheduledTaskModel.scopeOf(task), scope) && task.scheduleId === scheduleId,
          ),
        )
      }),
      query: Effect.fn('ScheduledTaskTestStorage.query')(function* (request) {
        return (yield* Ref.get(tasks))
          .filter((task) => matchesQuery(task, request))
          .sort(compareTask)
          .slice(0, request.limit)
      }),
      next: Effect.fn('ScheduledTaskTestStorage.next')(function* (
        instanceId,
        excludedScheduleIds = [],
      ) {
        const pending = (yield* Ref.get(tasks))
          .filter((task) => task.instanceId === instanceId && task.status === 'pending')
          .sort(compareTask)
          .filter((task) => !excludedScheduleIds.includes(task.scheduleId))
        return Option.fromUndefinedOr(pending[0])
      }),
      compareAndSet: Effect.fn('ScheduledTaskTestStorage.compareAndSet')(
        function* (expected, replacement) {
          return yield* Ref.modify(tasks, (current) => {
            const index = current.findIndex((task) => expectedEqual(task, expected))
            if (index < 0) return [false, current]
            return [
              true,
              current.map((task, taskIndex) => (taskIndex === index ? replacement : task)),
            ]
          })
        },
      ),
      all: () => Ref.get(tasks),
      seed: (task) => Ref.update(tasks, (current) => [...current, task]),
    })
    return Context.empty().pipe(
      Context.add(ScheduledTaskStorage.Service, service),
      Context.add(TestStorage, service),
    )
  }),
)

export const domainLayer = (timeZone = 'UTC') =>
  ScheduledTask.layer({
    instanceId: INSTANCE_ID,
    timeZone: ScheduledTaskModel.TimeZoneId.make(timeZone),
    contextLimit: ScheduledTaskModel.QueryLimit.make(8),
  })

export const serviceLayer = (timeZone = 'UTC') =>
  domainLayer(timeZone).pipe(Layer.provideMerge(Layer.merge(storageLayer, archiveLayer)))

export const createRequest = (
  time: string,
  dedupeKey = 'schedule-dedupe',
  reason = 'Follow up',
  repeatEveryMs: Option.Option<ScheduledTaskModel.RepeatEveryMilliseconds> = Option.none(),
): ScheduledTaskModel.CreateRequest =>
  ScheduledTaskModel.CreateRequest.make({
    scope: SCOPE,
    sourceMessageId: SOURCE_ID,
    time: ScheduledTaskModel.TimeExpression.make(time),
    reason: ScheduledTaskModel.Reason.make(reason),
    dedupeKey: ScheduledTaskModel.DedupeKey.make(dedupeKey),
    repeatEveryMs,
  })
