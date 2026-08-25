import type { Context, Session } from 'koishi'

export interface Handler {
  readonly handleMessageCreated: (session: Session) => Promise<void>
  readonly handleMessageUpdated: (session: Session) => Promise<void>
}

export const register = (ctx: Context, handler: Handler): void => {
  ctx.middleware((session, next) =>
    session.isDirect ? next() : handler.handleMessageCreated(session).then(() => next()),
  )

  ctx.on('message-created', (session) => {
    if (session.isDirect || session.userId !== session.selfId) return
    return handler.handleMessageCreated(session)
  })

  ctx.on('message-updated', (session) => {
    if (session.isDirect) return
    return handler.handleMessageUpdated(session)
  })
}

export * as MessageArchiveIntegration from './integration'
