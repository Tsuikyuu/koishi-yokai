import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'

import {
  FeedbackTool,
  MAX_FEEDBACK_TOOL_DESCRIPTION_LENGTH,
  MAX_MCP_TOOL_NAME_LENGTH,
  MAX_PORTABLE_ARRAY_ITEMS,
  MAX_PORTABLE_DESCRIPTION_LENGTH,
  MAX_PORTABLE_ENUM_VALUE_LENGTH,
  MAX_PORTABLE_ENUM_VALUES,
  MAX_PORTABLE_PROPERTY_NAME_LENGTH,
  MAX_PORTABLE_SCHEMA_PROPERTIES,
  McpServer,
  McpToolName,
  capabilityModelExposureBytesV1,
  canonicalFeedbackToolDescriptor,
  canonicalMcpToolProjectionDescriptor,
  encodedCapabilityDescriptorBytesV1,
  maxEncodedDeclarationBytes,
} from '../../../src/index'

const padded = (prefix: string, length: number): string =>
  prefix + '\u0000'.repeat(length - prefix.length)

const maximumPortableSchema = () => {
  const values = Array.from({ length: MAX_PORTABLE_ENUM_VALUES }, (_, index) =>
    padded(`v${String(index)}:`, MAX_PORTABLE_ENUM_VALUE_LENGTH),
  )
  const description = '\u0000'.repeat(MAX_PORTABLE_DESCRIPTION_LENGTH)
  const leaf = {
    _tag: 'StringEnum',
    description,
    values,
  }
  const array = (items: object) => ({
    _tag: 'Array',
    description,
    items,
    minItems: 0,
    maxItems: MAX_PORTABLE_ARRAY_ITEMS,
  })

  return {
    _tag: 'Object',
    description,
    properties: Array.from({ length: MAX_PORTABLE_SCHEMA_PROPERTIES }, (_, index) => ({
      name: padded(`p${String(index)}:`, MAX_PORTABLE_PROPERTY_NAME_LENGTH),
      required: true,
      schema: array(array(array(leaf))),
    })),
  }
}

it.effect(
  'keeps the maximal Feedback descriptor and MCP projection within published hard caps',
  () =>
    Effect.gen(function* () {
      const portableSchema = maximumPortableSchema()
      const projectionName = 't'.repeat(MAX_MCP_TOOL_NAME_LENGTH - 2)
      const tool = yield* Schema.decodeUnknownEffect(FeedbackTool)({
        id: `s.${projectionName}`,
        protocolVersion: { major: Number.MAX_SAFE_INTEGER, minor: Number.MAX_SAFE_INTEGER },
        description: '\u0000'.repeat(MAX_FEEDBACK_TOOL_DESCRIPTION_LENGTH),
        inputSchema: portableSchema,
        outputSchema: portableSchema,
        maxResultTokens: Number.MAX_SAFE_INTEGER,
        maxDurationMs: Number.MAX_SAFE_INTEGER,
        isAvailable: () => true,
        prepare: () => Effect.succeed({ execute: () => Effect.succeed('result') }),
      })
      const server = yield* Schema.decodeUnknownEffect(McpServer)({
        id: 's',
        protocolVersion: { major: Number.MAX_SAFE_INTEGER, minor: Number.MAX_SAFE_INTEGER },
      })
      const descriptor = canonicalFeedbackToolDescriptor(tool)
      const projection = canonicalMcpToolProjectionDescriptor(server, {
        _tag: 'Feedback',
        name: McpToolName.make(projectionName),
        tool,
      })
      const descriptorBytes = yield* Effect.fromResult(
        encodedCapabilityDescriptorBytesV1(descriptor),
      )
      const projectionBytes = yield* Effect.fromResult(
        encodedCapabilityDescriptorBytesV1(projection),
      )
      const exposureBytes = yield* Effect.fromResult(capabilityModelExposureBytesV1(descriptor))

      expect(exposureBytes).toBeGreaterThan(65_536)
      expect(descriptorBytes).toBeLessThanOrEqual(
        maxEncodedDeclarationBytes(tool.protocolVersion, 'feedback-tool'),
      )
      expect(projectionBytes).toBeLessThanOrEqual(
        maxEncodedDeclarationBytes(tool.protocolVersion, 'mcp-projection'),
      )
    }),
)
