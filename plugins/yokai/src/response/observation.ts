import { WakeMessage } from '@yokai-internal/core'
import { type MessageArchiveEvent } from '@yokai-internal/memory'
import { CapabilityScope, FocusMessage } from 'yokai-protocol'
import { Option } from 'effect'
import type { Session } from 'koishi'

import type { HardReplyPolicy } from '../config'
import { HardReplyDecision } from './hard-reply'

const isReplyToSelf = (session: Session): boolean => {
  const quote = session.quote
  if (quote === undefined) return false
  const quotedUser = quote.user
  return quotedUser !== undefined && quotedUser.id === session.selfId
}

const isSelfMention = (session: Session): boolean => {
  const elements = session.elements
  return (
    elements !== undefined &&
    elements.some((element) => element.type === 'at' && element.attrs.id === session.selfId)
  )
}

const stripSelfMentions = (session: Session): string => {
  const elements = session.elements
  return elements === undefined
    ? session.stripped.content
    : elements
        .filter((element) => element.type !== 'at' || element.attrs.id !== session.selfId)
        .join('')
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

interface PresetNameObservation {
  readonly match: WakeMessage.PresetNameMatch
  readonly focusContent: string
}

const stripRoleNameSeparator = (content: string): string =>
  content.replace(/^([,，:：、]\s*|\s+)/u, '')

const hasRoleNamePrefix = (content: string, name: string): boolean => {
  if (!content.startsWith(name)) return false
  const suffix = content.slice(name.length)
  return suffix.length === 0 || /^[\p{P}\p{S}\s]/u.test(suffix)
}

const observePresetName = (
  matchContent: string,
  focusContent: string,
  roleName: Option.Option<string>,
): PresetNameObservation =>
  Option.match(roleName, {
    onNone: () => ({
      match: WakeMessage.PresetNameMatch.make('none'),
      focusContent,
    }),
    onSome: (name) => {
      if (hasRoleNamePrefix(matchContent, name)) {
        return {
          match: WakeMessage.PresetNameMatch.make('prefix'),
          focusContent: focusContent.startsWith(name)
            ? stripRoleNameSeparator(focusContent.slice(name.length))
            : focusContent,
        }
      }
      return {
        match: WakeMessage.PresetNameMatch.make(matchContent.includes(name) ? 'contains' : 'none'),
        focusContent,
      }
    },
  })

const textContent = (session: Session): string => {
  const elements = session.elements
  return elements === undefined
    ? session.content === undefined
      ? ''
      : session.content
    : elements.filter((element) => element.type === 'text').join('')
}

export const fromSession = (
  session: Session,
  message: MessageArchiveEvent.ArchivedMessage,
  isDuplicate: boolean,
  roleName: Option.Option<string>,
  hardReplyPolicy: HardReplyPolicy,
): WakeMessage.Message => {
  const explicitMention = isSelfMention(session)
  const replyToSelf = isReplyToSelf(session)
  const rawContent = (session.content === undefined ? '' : session.content).trim()
  const focusContent = explicitMention ? stripSelfMentions(session).trim() : rawContent
  const presetName = observePresetName(textContent(session).trim(), focusContent, roleName)
  const content = presetName.focusContent.trim()
  const hardReplyKind = HardReplyDecision.classify(
    { explicitMention, replyToSelf, presetNameMatch: presetName.match },
    hardReplyPolicy,
  )

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
    presetNameMatch: presetName.match,
    hardReplyKind,
    isQuestionOrHelp: questionOrHelp(content),
    hasQuote: session.quote !== undefined,
    hasMedia: hasMedia(session),
    localState: WakeMessage.emptyLocalStateSignals(),
  })
}

export * as KoishiWakeObservation from './observation'
