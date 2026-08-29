import { Effect, Option, Schema } from 'effect'
import type { ActionTool } from 'yokai-protocol'

import { decodeActionInput } from './portable-input'
import {
  MAX_ACTIONS,
  MAX_MESSAGES,
  ParseError,
  ResponseMessage,
  type Envelope,
  type ParsedAction,
  type ResponseMessage as ResponseMessageType,
  type ResponseMessages as ResponseMessagesType,
  type TurnContext,
} from './schema'
import {
  attributeValue,
  hasOnlyAttributes,
  parseError,
  readDocument,
  structuralChildren,
  textContent,
  type XmlElement,
} from './xml'

const decodeMessage = (input: object): Effect.Effect<ResponseMessageType, ParseError> =>
  Schema.decodeUnknownEffect(ResponseMessage)(input).pipe(
    Effect.mapError(() => parseError('invalid-message')),
  )

const parseMessage = Effect.fn('RoleResponseEnvelope.parseMessage')(function* (
  element: XmlElement,
  context: TurnContext,
) {
  if (
    element.name !== 'message' ||
    element.attributes.length > 1 ||
    !hasOnlyAttributes(element, ['quote'])
  ) {
    return yield* Effect.fail(parseError('invalid-message'))
  }
  const content = textContent(element)
  if (content === undefined) {
    return yield* Effect.fail(parseError('invalid-message'))
  }
  const quote = attributeValue(element, 'quote')
  const message = yield* decodeMessage({ content, quote: quote === undefined ? null : quote })
  const quoteAllowed = Option.match(message.quote, {
    onNone: () => true,
    onSome: (messageId) => context.quotableMessageIds.includes(messageId),
  })
  if (!quoteAllowed) {
    return yield* Effect.fail(parseError('quote-scope-denied'))
  }
  return message
})

const parseMessages = Effect.fn('RoleResponseEnvelope.parseMessages')(function* (
  elements: ReadonlyArray<XmlElement>,
  context: TurnContext,
) {
  if (elements.length > MAX_MESSAGES) {
    return yield* Effect.fail(parseError('too-many-messages'))
  }
  return yield* Effect.forEach(elements, (element) => parseMessage(element, context))
})

const parseAction = Effect.fn('RoleResponseEnvelope.parseAction')(function* (
  element: XmlElement,
  context: TurnContext,
  tools: ReadonlyArray<ActionTool>,
) {
  if (
    element.name !== 'action' ||
    element.attributes.length !== 1 ||
    !hasOnlyAttributes(element, ['tool'])
  ) {
    return yield* Effect.fail(parseError('invalid-action'))
  }
  const toolId = attributeValue(element, 'tool')
  if (toolId === undefined) return yield* Effect.fail(parseError('invalid-action'))
  const tool = tools.find((candidate) => candidate.id === toolId)
  if (tool === undefined) return yield* Effect.fail(parseError('unknown-action-tool'))
  const input = yield* decodeActionInput(element, tool.inputSchema)
  const inputAllowed = yield* Effect.try({
    try: () => tool.isInputAllowed(context.scope, input),
    catch: () => parseError('action-scope-denied'),
  })
  if (inputAllowed !== true) {
    return yield* Effect.fail(parseError('action-scope-denied'))
  }
  return { tool, input } satisfies ParsedAction
})

const parseActions = Effect.fn('RoleResponseEnvelope.parseActions')(function* (
  container: XmlElement,
  context: TurnContext,
  tools: ReadonlyArray<ActionTool>,
) {
  if (container.name !== 'actions' || container.attributes.length !== 0) {
    return yield* Effect.fail(parseError('invalid-action'))
  }
  const children = structuralChildren(container)
  if (children === undefined || children.some((child) => child.name !== 'action')) {
    return yield* Effect.fail(parseError('invalid-action'))
  }
  if (children.length === 0) {
    return yield* Effect.fail(parseError('invalid-action'))
  }
  if (children.length > MAX_ACTIONS) {
    return yield* Effect.fail(parseError('too-many-actions'))
  }
  return yield* Effect.forEach(children, (child) => parseAction(child, context, tools))
})

interface EnvelopeSections {
  readonly messages: ReadonlyArray<XmlElement>
  readonly actions: XmlElement | undefined
}

const extractSections = (root: XmlElement): Effect.Effect<EnvelopeSections, ParseError> => {
  if (root.name !== 'output' || root.attributes.length !== 0) {
    return Effect.fail(parseError('invalid-envelope'))
  }
  const children = structuralChildren(root)
  if (children === undefined) {
    return Effect.fail(parseError('invalid-envelope'))
  }
  const firstSection = children.findIndex((child) => child.name !== 'message')
  const messageCount = firstSection < 0 ? children.length : firstSection
  if (messageCount > MAX_MESSAGES) {
    return Effect.fail(parseError('too-many-messages'))
  }
  const messages = children.slice(0, messageCount)
  const sections = children.slice(messageCount)

  const first = sections[0]
  if (first === undefined) {
    return Effect.succeed({ messages, actions: undefined })
  }
  if (first.name === 'actions' && sections.length === 1) {
    return Effect.succeed({ messages, actions: first })
  }
  return Effect.fail(parseError('invalid-envelope'))
}

export const parseCompiled = Effect.fn('RoleResponseEnvelope.parseCompiled')(function* (
  source: string,
  context: TurnContext,
  tools: ReadonlyArray<ActionTool>,
) {
  const root = yield* readDocument(source)
  const sections = yield* extractSections(root)
  const messages: ResponseMessagesType = yield* parseMessages(sections.messages, context)
  const actions =
    sections.actions === undefined ? [] : yield* parseActions(sections.actions, context, tools)
  return { messages, actions } satisfies Envelope
})
