import { WakeMessage } from '@yokai-internal/core'
import { type MessageArchiveEvent } from '@yokai-internal/memory'
import { CapabilityScope, FocusMessage } from 'yokai-protocol'
import type { Session } from 'koishi'

const isReplyToSelf = (session: Session): boolean => {
  const quote = session.quote
  if (quote === undefined) return false
  const quotedUser = quote.user
  return quotedUser !== undefined && quotedUser.id === session.selfId
}

const hasMedia = (session: Session): boolean => {
  const elements = session.elements
  return (
    elements !== undefined &&
    elements.some(
      (element) => element.type !== 'text' && element.type !== 'at' && element.type !== 'quote',
    )
  )
}

const questionOrHelp = (content: string): boolean =>
  /[?？]|(?:帮忙|帮我|求助|请问|怎么|如何|为什么)/u.test(content)

export const fromSession = (
  session: Session,
  message: MessageArchiveEvent.ArchivedMessage,
  isDuplicate: boolean,
): WakeMessage.Message => {
  const stripped = session.stripped
  const explicitMention = stripped.atSelf
  const replyToSelf = isReplyToSelf(session)
  const nameHit = stripped.appel && !explicitMention
  const hardTrigger = explicitMention || replyToSelf || nameHit
  const rawContent = session.content === undefined ? '' : session.content
  const content = (hardTrigger ? stripped.content : rawContent).trim()

  return WakeMessage.Message.make({
    scope: CapabilityScope.make({
      instanceId: message.instanceId,
      platform: message.platform,
      guildId: message.guildId,
      channelId: message.channelId,
    }),
    focus: FocusMessage.make({
      messageId: message.messageId,
      authorId: message.authorId,
      timestamp: message.timestamp,
      content,
    }),
    isDuplicate,
    isOtherBot: session.author.isBot === true && session.userId !== session.selfId,
    isSelf: message.isSelf,
    isEffective: content.length > 0,
    explicitMention,
    replyToSelf,
    nameHit,
    isQuestionOrHelp: questionOrHelp(content),
    hasQuote: session.quote !== undefined,
    hasMedia: hasMedia(session),
  })
}

export * as KoishiWakeObservation from './observation'
