import { expect, it } from '@effect/vitest'
import { HostSession } from '@yokai-internal/core'
import { Effect, Option } from 'effect'
import { vi } from 'vitest'

vi.mock('koishi', () => import('@koishijs/core'))

import { KoishiSession, type SessionBoundary } from '../../src/runtime/session'

const SESSION: SessionBoundary = {
  type: 'message',
  platform: 'test',
  selfId: 'bot',
  timestamp: 1_777_000_000_000,
  userId: 'user',
  channelId: 'channel',
  guildId: undefined,
  messageId: 'message',
  content: 'hello',
  isDirect: false,
  send: (content, replyToMessageId) =>
    Promise.resolve([
      replyToMessageId === undefined ? 'sent:' + content : `sent:${replyToMessageId}:${content}`,
    ]),
}

it.effect('freezes a Koishi-independent Session input and delegates text sending', () =>
  Effect.gen(function* () {
    const session = yield* HostSession.Service

    expect(session.eventType).toBe('message')
    expect(session.platform).toBe('test')
    expect(session.selfId).toBe('bot')
    expect(session.timestamp).toBe(1_777_000_000_000)
    expect(Option.getOrNull(session.userId)).toBe('user')
    expect(Option.getOrNull(session.channelId)).toBe('channel')
    expect(Option.isNone(session.guildId)).toBe(true)
    expect(Option.getOrNull(session.messageId)).toBe('message')
    expect(Option.getOrNull(session.content)).toBe('hello')
    expect(session.isDirect).toBe(false)
    expect(yield* session.sendText('world', Option.none())).toEqual(['sent:world'])
    expect(yield* session.sendText('world', Option.some('source-message'))).toEqual([
      'sent:source-message:world',
    ])
  }).pipe(Effect.provide(KoishiSession.makeLayer(SESSION))),
)

it.effect('translates Session send rejection into a typed host error', () => {
  const canary = new Error('send failed')
  const failing: SessionBoundary = {
    ...SESSION,
    send: () => Promise.reject(canary),
  }

  return Effect.gen(function* () {
    const session = yield* HostSession.Service
    const failure = yield* session.sendText('world', Option.none()).pipe(Effect.flip)

    expect(failure._tag).toBe('HostSessionSendError')
    expect(failure.cause).toBe(canary)
  }).pipe(Effect.provide(KoishiSession.makeLayer(failing)))
})
