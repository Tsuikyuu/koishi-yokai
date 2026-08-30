import { SceneUnderstanding, ThreadScene } from '@yokai-internal/mind'
import { type MessageArchiveEvent } from '@yokai-internal/memory'
import type { CapabilityScope } from 'yokai-protocol'
import { Clock, Context, Effect, HashMap, Layer, Option, SynchronizedRef } from 'effect'

interface ChannelState {
  readonly threads: ThreadScene.State
  readonly scenes: HashMap.HashMap<string, ThreadScene.Scene>
}

type State = HashMap.HashMap<string, ChannelState>

export interface Interface {
  readonly observe: (
    message: MessageArchiveEvent.ArchivedMessage,
    directedToYokai: boolean,
  ) => Effect.Effect<ThreadScene.Scene>
  readonly scene: (
    scope: CapabilityScope,
    messageId: string,
  ) => Effect.Effect<Option.Option<ThreadScene.Scene>>
  readonly snapshot: (scope: CapabilityScope) => Effect.Effect<ThreadScene.State>
}

export class Service extends Context.Service<Service, Interface>()('@yokai/core/ThreadTracker') {}

const scopeKey = (scope: CapabilityScope | MessageArchiveEvent.ChannelScope): string =>
  JSON.stringify([scope.instanceId, scope.platform, scope.guildId, scope.channelId])

const EMPTY_CHANNEL: ChannelState = {
  threads: ThreadScene.empty(),
  scenes: HashMap.empty(),
}

const sceneMessage = (
  message: MessageArchiveEvent.ArchivedMessage,
  directedToYokai: boolean,
): ThreadScene.Message =>
  ThreadScene.Message.make({
    messageId: ThreadScene.MessageId.make(message.messageId),
    authorId: ThreadScene.ParticipantId.make(message.authorId),
    timestamp: ThreadScene.EpochMilliseconds.make(message.timestamp),
    content: message.content,
    replyToMessageId: Option.map(message.replyToMessageId, ThreadScene.MessageId.make),
    isSelf: message.isSelf,
    directedToYokai,
  })

const activeMessageIds = (state: ThreadScene.State): ReadonlyArray<string> =>
  state.activeThreads.flatMap((thread) => thread.recentMessages.map((message) => message.messageId))

const retainActiveScenes = (
  scenes: HashMap.HashMap<string, ThreadScene.Scene>,
  state: ThreadScene.State,
): HashMap.HashMap<string, ThreadScene.Scene> => {
  const messageIds = activeMessageIds(state)
  return HashMap.filter(scenes, (_scene, messageId) => messageIds.includes(messageId))
}

const refreshedScene = (
  scene: ThreadScene.Scene,
  threads: ThreadScene.State,
): Option.Option<ThreadScene.Scene> => {
  const thread = threads.activeThreads.find((candidate) => candidate.id === scene.thread.id)
  return thread === undefined
    ? Option.none()
    : Option.some(
        ThreadScene.Scene.make({
          thread,
          activeThreadCount: threads.activeThreads.length,
          direction: scene.direction,
          interruptsOthers: threads.activeThreads.length > 1 && scene.direction.kind !== 'yokai',
          sufficientResponse: thread.sufficientResponse,
        }),
      )
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* SynchronizedRef.make<State>(HashMap.empty())
    yield* Effect.addFinalizer(() => SynchronizedRef.set(state, HashMap.empty()))

    const observe = Effect.fn('ThreadTracker.observe')(function* (
      message: MessageArchiveEvent.ArchivedMessage,
      directedToYokai: boolean,
    ) {
      const now = yield* Clock.currentTimeMillis
      return yield* SynchronizedRef.modify(state, (current) => {
        const key = scopeKey(message)
        const channel = Option.getOrElse(HashMap.get(current, key), () => EMPTY_CHANNEL)
        const observation = SceneUnderstanding.observe(
          channel.threads,
          sceneMessage(message, directedToYokai),
          now,
        )
        const scenes = HashMap.set(
          retainActiveScenes(channel.scenes, observation.state),
          message.messageId,
          observation.scene,
        )
        const next = HashMap.set(current, key, { threads: observation.state, scenes })
        return [observation.scene, next]
      })
    })

    const scene = Effect.fn('ThreadTracker.scene')(function* (
      scope: CapabilityScope,
      messageId: string,
    ) {
      const now = yield* Clock.currentTimeMillis
      return yield* SynchronizedRef.modify(state, (current) => {
        const key = scopeKey(scope)
        const channel = HashMap.get(current, key)
        if (Option.isNone(channel)) return [Option.none<ThreadScene.Scene>(), current]
        const threads = SceneUnderstanding.expire(channel.value.threads, now)
        const scenes = retainActiveScenes(channel.value.scenes, threads)
        const stored = HashMap.get(scenes, messageId)
        const selected = Option.flatMap(stored, (value) => refreshedScene(value, threads))
        return [selected, HashMap.set(current, key, { threads, scenes })]
      })
    })

    const snapshot = Effect.fn('ThreadTracker.snapshot')(function* (scope: CapabilityScope) {
      const now = yield* Clock.currentTimeMillis
      return yield* SynchronizedRef.modify(state, (current) => {
        const key = scopeKey(scope)
        const channel = HashMap.get(current, key)
        if (Option.isNone(channel)) return [ThreadScene.empty(), current]
        const threads = SceneUnderstanding.expire(channel.value.threads, now)
        const scenes = retainActiveScenes(channel.value.scenes, threads)
        return [threads, HashMap.set(current, key, { threads, scenes })]
      })
    })

    return Service.of({ observe, scene, snapshot })
  }),
)

export * as ThreadTracker from './thread-tracker'
