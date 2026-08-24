import type { Context } from 'koishi'

import type { Yokai } from '../service'

export const register = (ctx: Context, service: Yokai): void => {
  ctx.middleware((session, next) =>
    session.stripped.atSelf ? service.handleDirectMention(session) : next(),
  )
}
