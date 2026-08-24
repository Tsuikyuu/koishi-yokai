import { HostSession } from '@yokai/core'
import { Effect, Layer, Option } from 'effect'
import { h, type Session } from 'koishi'

export interface SessionBoundary {
  readonly type: string
  readonly platform: string
  readonly selfId: string
  readonly timestamp: number
  readonly userId: string | undefined
  readonly channelId: string | undefined
  readonly guildId: string | undefined
  readonly messageId: string | undefined
  readonly content: string | undefined
  readonly isDirect: boolean
  readonly send: (content: string) => Promise<string[]>
}

const makeBoundary = (session: Session, content: string | undefined): SessionBoundary => ({
  type: session.type,
  platform: session.platform,
  selfId: session.selfId,
  timestamp: session.timestamp,
  userId: session.userId,
  channelId: session.channelId,
  guildId: session.guildId,
  messageId: session.messageId,
  content,
  isDirect: session.isDirect,
  send: (content) => session.send(h.text(content)),
})

export const fromSession = (session: Session): SessionBoundary =>
  makeBoundary(session, session.content)

/** Freezes the mention-stripped user text before generation starts. */
export const fromDirectMentionSession = (session: Session): SessionBoundary =>
  makeBoundary(session, session.stripped.content)

const optional = <A>(value: A | undefined): Option.Option<A> =>
  value === undefined ? Option.none<A>() : Option.some(value)

export const makeLayer = (session: SessionBoundary) => {
  const sendText = Effect.fn('KoishiSession.sendText')(function* (content: string) {
    return yield* Effect.tryPromise({
      try: () => session.send(content),
      catch: (cause) => new HostSession.SendError({ cause }),
    })
  })

  return Layer.succeed(
    HostSession.Service,
    HostSession.Service.of({
      eventType: session.type,
      platform: session.platform,
      selfId: session.selfId,
      timestamp: session.timestamp,
      userId: optional(session.userId),
      channelId: optional(session.channelId),
      guildId: optional(session.guildId),
      messageId: optional(session.messageId),
      content: optional(session.content),
      isDirect: session.isDirect,
      sendText,
    }),
  )
}

export * as KoishiSession from './session'
