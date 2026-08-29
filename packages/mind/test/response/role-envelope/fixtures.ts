import { Schema } from 'effect'
import {
  ActionTool,
  type ActionToolIsAvailable,
  type ActionToolIsInputAllowed,
} from 'yokai-protocol'

import type { RoleResponseEnvelope } from '../../../src/index'

export const CONTEXT: RoleResponseEnvelope.TurnContext = {
  scope: {
    instanceId: 'instance',
    platform: 'test',
    guildId: 'guild',
    channelId: 'channel',
  },
  quotableMessageIds: ['focus-message', 'recent-message'],
}

export const PARSE_CONTEXT: RoleResponseEnvelope.ParseContext = {
  quotableMessageIds: CONTEXT.quotableMessageIds,
}

export const REACTION_TEMPLATE =
  '<action tool="reaction.add"><emoji>XML_ESCAPED_EMOJI</emoji></action>'

export const makeReactionTool = (
  isAvailable: ActionToolIsAvailable = () => true,
  isInputAllowed: ActionToolIsInputAllowed = () => true,
) =>
  Schema.decodeUnknownEffect(ActionTool)({
    id: 'reaction.add',
    protocolVersion: { major: 1, minor: 0 },
    description: 'Add one reaction to the focused message.',
    xmlTemplate: REACTION_TEMPLATE,
    inputSchema: {
      _tag: 'Object',
      properties: [
        {
          name: 'emoji',
          required: true,
          schema: { _tag: 'String', description: 'One reaction emoji.' },
        },
      ],
    },
    executionStage: 'before-send',
    completionPolicy: 'none',
    failurePolicy: 'block-reply',
    maxDurationMs: 250,
    isAvailable,
    isInputAllowed,
  })

export const RICH_TEMPLATE = `<action tool="schedule.create">
  <query>QUERY</query>
  <count>INTEGER</count>
  <urgent>BOOLEAN</urgent>
  <mode>MODE</mode>
  <metadata><source>SOURCE</source></metadata>
  <tags><item>TAG</item></tags>
</action>`

export const makeRichTool = (
  isAvailable: ActionToolIsAvailable = () => true,
  isInputAllowed: ActionToolIsInputAllowed = () => true,
) =>
  Schema.decodeUnknownEffect(ActionTool)({
    id: 'schedule.create',
    protocolVersion: { major: 1, minor: 0 },
    description: 'Create a bounded local schedule entry.',
    xmlTemplate: RICH_TEMPLATE,
    inputSchema: {
      _tag: 'Object',
      properties: [
        {
          name: 'query',
          required: true,
          schema: { _tag: 'String', description: 'Schedule text.' },
        },
        {
          name: 'count',
          required: true,
          schema: {
            _tag: 'Integer',
            description: 'Repeat count.',
            minimum: 1,
            maximum: 3,
          },
        },
        {
          name: 'urgent',
          required: false,
          schema: { _tag: 'Boolean', description: 'Whether this is urgent.' },
        },
        {
          name: 'mode',
          required: true,
          schema: {
            _tag: 'StringEnum',
            description: 'Schedule mode.',
            values: ['once', 'repeat'],
          },
        },
        {
          name: 'metadata',
          required: true,
          schema: {
            _tag: 'Object',
            properties: [
              {
                name: 'source',
                required: true,
                schema: { _tag: 'String', description: 'Source message ID.' },
              },
            ],
          },
        },
        {
          name: 'tags',
          required: true,
          schema: {
            _tag: 'Array',
            description: 'Schedule tags.',
            items: { _tag: 'String' },
            minItems: 1,
            maxItems: 2,
          },
        },
      ],
    },
    executionStage: 'after-send',
    completionPolicy: 'none',
    failurePolicy: 'continue',
    maxDurationMs: 1_000,
    isAvailable,
    isInputAllowed,
  })

export const makeTextBundleTool = () =>
  Schema.decodeUnknownEffect(ActionTool)({
    id: 'text.bundle',
    protocolVersion: { major: 1, minor: 0 },
    description: 'Collect three bounded text values.',
    xmlTemplate:
      '<action tool="text.bundle"><one>ONE</one><two>TWO</two><three>THREE</three></action>',
    inputSchema: {
      _tag: 'Object',
      properties: [
        { name: 'one', required: true, schema: { _tag: 'String' } },
        { name: 'two', required: true, schema: { _tag: 'String' } },
        { name: 'three', required: true, schema: { _tag: 'String' } },
      ],
    },
    executionStage: 'after-send',
    completionPolicy: 'none',
    failurePolicy: 'continue',
    maxDurationMs: 1_000,
    isAvailable: () => true,
    isInputAllowed: () => true,
  })
