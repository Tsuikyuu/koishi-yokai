import { type MessageArchiveEvent } from '@yokai-internal/memory'
import { Context, Effect, HashMap, Layer, Option, Ref } from 'effect'

import { TurnSnapshot } from './snapshot'

type BufferState = HashMap.HashMap<string, ReadonlyArray<MessageArchiveEvent.ArchivedMessage>>

interface ScopeIdentity {
  readonly instanceId: string
  readonly platform: string
  readonly guildId: string
  readonly channelId: string
}

export interface Interface {
  readonly ingest: (message: MessageArchiveEvent.ArchivedMessage) => Effect.Effect<void>
  readonly snapshot: (
    request: TurnSnapshot.Request,
  ) => Effect.Effect<TurnSnapshot.Snapshot, TurnSnapshot.FocusExceedsTokenBudgetError>
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/core/ChannelMessageBuffer',
) {}

const scopeKey = (scope: ScopeIdentity): string =>
  JSON.stringify([scope.instanceId, scope.platform, scope.guildId, scope.channelId])

const compareMessages = (
  left: MessageArchiveEvent.ArchivedMessage,
  right: MessageArchiveEvent.ArchivedMessage,
): number => {
  if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp
  return left.messageId < right.messageId ? -1 : left.messageId > right.messageId ? 1 : 0
}

const upsert = (
  messages: ReadonlyArray<MessageArchiveEvent.ArchivedMessage>,
  message: MessageArchiveEvent.ArchivedMessage,
): ReadonlyArray<MessageArchiveEvent.ArchivedMessage> => {
  const current = messages.find((candidate) => candidate.messageId === message.messageId)
  if (current !== undefined && current.version > message.version) return messages
  return [...messages.filter((candidate) => candidate.messageId !== message.messageId), message]
    .sort(compareMessages)
    .slice(-TurnSnapshot.MAX_MESSAGE_COUNT)
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* Ref.make<BufferState>(HashMap.empty())
    yield* Effect.addFinalizer(() => Ref.set(state, HashMap.empty()))

    const ingest = Effect.fn('ChannelMessageBuffer.ingest')(function* (
      message: MessageArchiveEvent.ArchivedMessage,
    ) {
      const key = scopeKey(message)
      yield* Ref.update(state, (current) => {
        const messages = Option.getOrElse(HashMap.get(current, key), () => [])
        return HashMap.set(current, key, upsert(messages, message))
      })
    })

    const snapshot = Effect.fn('ChannelMessageBuffer.snapshot')(function* (
      request: TurnSnapshot.Request,
    ) {
      const current = yield* Ref.get(state)
      const messages = Option.getOrElse(HashMap.get(current, scopeKey(request.scope)), () => [])
      return yield* TurnSnapshot.create(messages, request)
    })

    return Service.of({ ingest, snapshot })
  }),
)

export * as ChannelMessageBuffer from './channel-buffer'
