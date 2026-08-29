import { Effect, Option, Schema } from 'effect'
import type { ActionTool } from 'yokai-protocol'

import { decodeActionInput } from './portable-input'
import {
  Decision,
  EngagementDirective,
  MAX_ACTIONS,
  ParseError,
  type Decision as DecisionType,
  type EngagementDirective as EngagementDirectiveType,
  type Envelope,
  type ParsedAction,
  type TurnContext,
} from './schema'
import {
  attributeValue,
  hasOnlyAttributes,
  parseError,
  plainText,
  readDocument,
  structuralChildren,
  type XmlElement,
} from './xml'

const decodeDecision = (input: object): Effect.Effect<DecisionType, ParseError> =>
  Schema.decodeUnknownEffect(Decision)(input).pipe(
    Effect.mapError(() => parseError('invalid-decision')),
  )

const messageText = (decision: XmlElement): Effect.Effect<string, ParseError> => {
  const children = structuralChildren(decision)
  if (children === undefined || children.length !== 1) {
    return Effect.fail(parseError('invalid-decision'))
  }
  const message = children[0]
  if (message === undefined || message.name !== 'message') {
    return Effect.fail(parseError('invalid-decision'))
  }
  const value = plainText(message)
  return value === undefined ? Effect.fail(parseError('invalid-decision')) : Effect.succeed(value)
}

const parseDecision = Effect.fn('RoleResponseEnvelope.parseDecision')(function* (
  element: XmlElement,
  context: TurnContext,
) {
  if (element.name !== 'decision') {
    return yield* Effect.fail(parseError('invalid-decision'))
  }
  const action = attributeValue(element, 'action')
  if (action === undefined) return yield* Effect.fail(parseError('invalid-decision'))

  switch (action) {
    case 'silence': {
      if (element.attributes.length !== 1 || !hasOnlyAttributes(element, ['action'])) {
        return yield* Effect.fail(parseError('invalid-decision'))
      }
      const children = structuralChildren(element)
      if (children === undefined || children.length !== 0) {
        return yield* Effect.fail(parseError('invalid-decision'))
      }
      return yield* decodeDecision({ _tag: 'Silence' })
    }
    case 'react': {
      if (element.attributes.length !== 1 || !hasOnlyAttributes(element, ['action'])) {
        return yield* Effect.fail(parseError('invalid-decision'))
      }
      return yield* decodeDecision({ _tag: 'React', message: yield* messageText(element) })
    }
    case 'reply': {
      if (
        element.attributes.length < 1 ||
        element.attributes.length > 2 ||
        !hasOnlyAttributes(element, ['action', 'reply-to'])
      ) {
        return yield* Effect.fail(parseError('invalid-decision'))
      }
      const replyTo = attributeValue(element, 'reply-to')
      if (replyTo !== undefined && !context.replyToMessageIds.includes(replyTo)) {
        return yield* Effect.fail(parseError('reply-scope-denied'))
      }
      return yield* decodeDecision({
        _tag: 'Reply',
        message: yield* messageText(element),
        replyTo: replyTo === undefined ? null : replyTo,
      })
    }
    case 'follow-up': {
      if (element.attributes.length !== 1 || !hasOnlyAttributes(element, ['action'])) {
        return yield* Effect.fail(parseError('invalid-decision'))
      }
      return yield* decodeDecision({ _tag: 'FollowUp', message: yield* messageText(element) })
    }
    case 'initiate': {
      if (element.attributes.length !== 1 || !hasOnlyAttributes(element, ['action'])) {
        return yield* Effect.fail(parseError('invalid-decision'))
      }
      return yield* decodeDecision({ _tag: 'Initiate', message: yield* messageText(element) })
    }
    default:
      return yield* Effect.fail(parseError('invalid-decision'))
  }
})

const parseDirectives = Effect.fn('RoleResponseEnvelope.parseDirectives')(function* (
  container: XmlElement,
) {
  if (container.name !== 'directives' || container.attributes.length !== 0) {
    return yield* Effect.fail(parseError('invalid-directive'))
  }
  const children = structuralChildren(container)
  if (children === undefined || children.length !== 1) {
    return yield* Effect.fail(parseError('invalid-directive'))
  }
  const engagement = children[0]
  if (
    engagement === undefined ||
    engagement.name !== 'engagement' ||
    engagement.attributes.length !== 1 ||
    !hasOnlyAttributes(engagement, ['action'])
  ) {
    return yield* Effect.fail(parseError('invalid-directive'))
  }
  const engagementChildren = structuralChildren(engagement)
  if (engagementChildren === undefined || engagementChildren.length !== 0) {
    return yield* Effect.fail(parseError('invalid-directive'))
  }
  const action = attributeValue(engagement, 'action')
  return yield* Schema.decodeUnknownEffect(EngagementDirective)(action).pipe(
    Effect.mapError(() => parseError('invalid-directive')),
  )
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
  readonly decision: XmlElement
  readonly directives: XmlElement | undefined
  readonly actions: XmlElement | undefined
}

const extractSections = (root: XmlElement): Effect.Effect<EnvelopeSections, ParseError> => {
  if (
    root.name !== 'yokai-response' ||
    root.attributes.length !== 1 ||
    !hasOnlyAttributes(root, ['version']) ||
    attributeValue(root, 'version') !== '1'
  ) {
    return Effect.fail(parseError('invalid-envelope'))
  }
  const children = structuralChildren(root)
  if (children === undefined || children.length < 1 || children.length > 3) {
    return Effect.fail(parseError('invalid-envelope'))
  }
  const decision = children[0]
  if (decision === undefined || decision.name !== 'decision') {
    return Effect.fail(parseError('invalid-envelope'))
  }

  const second = children[1]
  const third = children[2]
  if (second === undefined) {
    return Effect.succeed({ decision, directives: undefined, actions: undefined })
  }
  if (second.name === 'directives') {
    if (third !== undefined && third.name !== 'actions') {
      return Effect.fail(parseError('invalid-envelope'))
    }
    return Effect.succeed({ decision, directives: second, actions: third })
  }
  if (second.name === 'actions' && third === undefined) {
    return Effect.succeed({ decision, directives: undefined, actions: second })
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
  const decision = yield* parseDecision(sections.decision, context)
  const engagement: Option.Option<EngagementDirectiveType> =
    sections.directives === undefined
      ? Option.none()
      : Option.some(yield* parseDirectives(sections.directives))
  const actions =
    sections.actions === undefined ? [] : yield* parseActions(sections.actions, context, tools)
  return { decision, engagement, actions } satisfies Envelope
})
