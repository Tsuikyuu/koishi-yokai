import { Result, Schema } from 'effect'

import {
  ActionToolCompletionPolicy,
  ActionToolExecutionStage,
  ActionToolFailurePolicy,
  ActionToolId,
  ActionToolXmlTemplate,
  CapabilityDurationMilliseconds,
  CapabilityProtocolVersion,
  ContextProviderId,
  ContextProviderSelection,
  MAX_ACTION_TOOL_DESCRIPTION_LENGTH,
  MAX_ACTION_TOOL_XML_TEMPLATE_LENGTH,
  MAX_CONTEXT_PROVIDER_DESCRIPTION_LENGTH,
  MAX_LOCAL_SELECTION_KEYWORD_LENGTH,
  MAX_LOCAL_SELECTION_KEYWORDS,
  MAX_LOCAL_SELECTION_RESPONSE_MECHANISMS,
  MAX_LOCAL_SELECTION_SKILLS,
  MAX_MCP_TOOL_NAME_LENGTH,
  MAX_SKILL_CAPABILITY_REFERENCES,
  MAX_SKILL_DESCRIPTION_LENGTH,
  McpServerId,
  McpToolName,
  type McpToolProjection,
  SkillId,
  SkillSelection,
  type ActionTool as ActionToolType,
  type ContextProvider as ContextProviderType,
  type FeedbackTool as FeedbackToolType,
  type McpServer as McpServerType,
  type Skill as SkillType,
} from '../../capability/capability'
import { MAX_FEEDBACK_TOOL_DESCRIPTION_LENGTH } from '../../llm-adapter/feedback-tool'
import { FeedbackToolId } from '../../llm-adapter/identity'
import {
  MAX_PORTABLE_DESCRIPTION_LENGTH,
  MAX_PORTABLE_ENUM_VALUE_LENGTH,
  MAX_PORTABLE_ENUM_VALUES,
  MAX_PORTABLE_PROPERTY_NAME_LENGTH,
  MAX_PORTABLE_SCHEMA_DEPTH,
  MAX_PORTABLE_SCHEMA_PROPERTIES,
  PortableToolInputSchema,
  PortableToolOutputSchema,
  type PortableObjectProperty,
  type PortableValueSchema,
} from '../../llm-adapter/portable-schema'
import { TokenLimit } from '../../llm-adapter/token'
import {
  canonicalJsonByteLength,
  canonicalJsonSha256Hex,
  sha256Hex,
  type CanonicalJsonError,
} from './canonical-json'
import {
  CAPABILITY_DESCRIPTOR_IDENTITY_VERSION,
  CAPABILITY_FINGERPRINT_VERSION,
  CapabilityDescriptorIdentityV1,
  type CapabilityFingerprintVersion,
  Sha256Digest,
} from './source-evidence'

const wellFormedUnicode = Schema.isPattern(/^[^\uD800-\uDFFF]*$/u)
const UTF8_ENCODER = new TextEncoder()

const contextProviderDescription = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_CONTEXT_PROVIDER_DESCRIPTION_LENGTH),
  wellFormedUnicode,
)

const actionToolDescription = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_ACTION_TOOL_DESCRIPTION_LENGTH),
  wellFormedUnicode,
)

const feedbackToolDescription = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_FEEDBACK_TOOL_DESCRIPTION_LENGTH),
  wellFormedUnicode,
)

const skillDescription = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_SKILL_DESCRIPTION_LENGTH),
  wellFormedUnicode,
)

export const CanonicalContextProviderDescriptor = Schema.TaggedStruct('ContextProvider', {
  id: ContextProviderId,
  protocolVersion: CapabilityProtocolVersion,
  description: contextProviderDescription,
  maxTokens: TokenLimit,
  maxDurationMs: CapabilityDurationMilliseconds,
  selection: ContextProviderSelection,
})

export interface CanonicalContextProviderDescriptor extends Schema.Schema.Type<
  typeof CanonicalContextProviderDescriptor
> {}

const CanonicalActionToolDescriptorRegistration = Schema.TaggedStruct('ActionTool', {
  id: ActionToolId,
  protocolVersion: CapabilityProtocolVersion,
  description: actionToolDescription,
  xmlTemplate: ActionToolXmlTemplate,
  inputSchema: PortableToolInputSchema,
  executionStage: ActionToolExecutionStage,
  completionPolicy: ActionToolCompletionPolicy,
  failurePolicy: ActionToolFailurePolicy,
  maxDurationMs: CapabilityDurationMilliseconds,
})

type CanonicalActionToolDescriptorRegistration =
  typeof CanonicalActionToolDescriptorRegistration.Type

export const CanonicalActionToolDescriptor = CanonicalActionToolDescriptorRegistration.check(
  Schema.makeFilter((tool: CanonicalActionToolDescriptorRegistration) => {
    if (tool.failurePolicy === 'block-reply' && tool.executionStage !== 'before-send') {
      return 'Expected block-reply ActionTool failure policy only at before-send stage'
    }
    return tool.completionPolicy === 'wake' && tool.executionStage !== 'deferred'
      ? 'Expected wake ActionTool completion policy only at deferred stage'
      : true
  }),
)

export interface CanonicalActionToolDescriptor extends Schema.Schema.Type<
  typeof CanonicalActionToolDescriptor
> {}

export const CanonicalFeedbackToolDescriptor = Schema.TaggedStruct('FeedbackTool', {
  id: FeedbackToolId,
  protocolVersion: CapabilityProtocolVersion,
  description: feedbackToolDescription,
  inputSchema: PortableToolInputSchema,
  outputSchema: PortableToolOutputSchema,
  maxResultTokens: TokenLimit,
  maxDurationMs: CapabilityDurationMilliseconds,
})

export interface CanonicalFeedbackToolDescriptor extends Schema.Schema.Type<
  typeof CanonicalFeedbackToolDescriptor
> {}

export const CanonicalSkillDescriptor = Schema.TaggedStruct('Skill', {
  id: SkillId,
  protocolVersion: CapabilityProtocolVersion,
  description: skillDescription,
  promptHash: Sha256Digest,
  selection: SkillSelection,
  contextProviders: Schema.Array(ContextProviderId).check(
    Schema.isMaxLength(MAX_SKILL_CAPABILITY_REFERENCES),
    Schema.isUnique(),
  ),
  actionTools: Schema.Array(ActionToolId).check(
    Schema.isMaxLength(MAX_SKILL_CAPABILITY_REFERENCES),
    Schema.isUnique(),
  ),
  feedbackTools: Schema.Array(FeedbackToolId).check(
    Schema.isMaxLength(MAX_SKILL_CAPABILITY_REFERENCES),
    Schema.isUnique(),
  ),
})

export interface CanonicalSkillDescriptor extends Schema.Schema.Type<
  typeof CanonicalSkillDescriptor
> {}

/** SHA-256 over the exact, well-formed UTF-8 Skill prompt bytes. */
export const skillPromptHashV1 = (prompt: string): Sha256Digest =>
  Sha256Digest.make(sha256Hex(UTF8_ENCODER.encode(prompt)))

export const CanonicalMcpServerDescriptor = Schema.TaggedStruct('McpServer', {
  id: McpServerId,
  protocolVersion: CapabilityProtocolVersion,
})

export interface CanonicalMcpServerDescriptor extends Schema.Schema.Type<
  typeof CanonicalMcpServerDescriptor
> {}

export const CanonicalCapabilityDescriptor = Schema.Union([
  CanonicalContextProviderDescriptor,
  CanonicalActionToolDescriptor,
  CanonicalFeedbackToolDescriptor,
  CanonicalSkillDescriptor,
  CanonicalMcpServerDescriptor,
])

export type CanonicalCapabilityDescriptor = typeof CanonicalCapabilityDescriptor.Type

const CanonicalMcpToolProjectionDescriptorRegistration = Schema.TaggedUnion({
  McpActionProjection: {
    serverId: McpServerId,
    serverProtocolVersion: CapabilityProtocolVersion,
    name: McpToolName,
    tool: CanonicalActionToolDescriptor,
  },
  McpFeedbackProjection: {
    serverId: McpServerId,
    serverProtocolVersion: CapabilityProtocolVersion,
    name: McpToolName,
    tool: CanonicalFeedbackToolDescriptor,
  },
})

type CanonicalMcpToolProjectionDescriptorRegistration =
  typeof CanonicalMcpToolProjectionDescriptorRegistration.Type

export const CanonicalMcpToolProjectionDescriptor =
  CanonicalMcpToolProjectionDescriptorRegistration.check(
    Schema.makeFilter((projection: CanonicalMcpToolProjectionDescriptorRegistration) =>
      projection.tool.id === `${projection.serverId}.${projection.name}`
        ? true
        : 'Expected MCP Tool projection ID to equal <serverId>.<toolName>',
    ),
  )

export type CanonicalMcpToolProjectionDescriptor = typeof CanonicalMcpToolProjectionDescriptor.Type

export type FingerprintableCapabilityDescriptor =
  CanonicalCapabilityDescriptor | CanonicalMcpToolProjectionDescriptor

export type ModelExposedCapabilityDescriptor =
  | CanonicalActionToolDescriptor
  | CanonicalFeedbackToolDescriptor
  | CanonicalMcpToolProjectionDescriptor

export const canonicalContextProviderDescriptor = (
  provider: ContextProviderType,
): CanonicalContextProviderDescriptor =>
  CanonicalContextProviderDescriptor.make({
    id: provider.id,
    protocolVersion: provider.protocolVersion,
    description: provider.description,
    maxTokens: provider.maxTokens,
    maxDurationMs: provider.maxDurationMs,
    selection: provider.selection,
  })

export const canonicalActionToolDescriptor = (
  tool: ActionToolType,
): CanonicalActionToolDescriptor =>
  CanonicalActionToolDescriptor.make({
    id: tool.id,
    protocolVersion: tool.protocolVersion,
    description: tool.description,
    xmlTemplate: tool.xmlTemplate,
    inputSchema: tool.inputSchema,
    executionStage: tool.executionStage,
    completionPolicy: tool.completionPolicy,
    failurePolicy: tool.failurePolicy,
    maxDurationMs: tool.maxDurationMs,
  })

export const canonicalFeedbackToolDescriptor = (
  tool: FeedbackToolType,
): CanonicalFeedbackToolDescriptor =>
  CanonicalFeedbackToolDescriptor.make({
    id: tool.id,
    protocolVersion: tool.protocolVersion,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    maxResultTokens: tool.maxResultTokens,
    maxDurationMs: tool.maxDurationMs,
  })

export const canonicalSkillDescriptor = (skill: SkillType): CanonicalSkillDescriptor =>
  CanonicalSkillDescriptor.make({
    id: skill.id,
    protocolVersion: skill.protocolVersion,
    description: skill.description,
    promptHash: skillPromptHashV1(skill.prompt),
    selection: skill.selection,
    contextProviders: [...skill.contextProviders],
    actionTools: [...skill.actionTools],
    feedbackTools: [...skill.feedbackTools],
  })

export const canonicalMcpServerDescriptor = (server: McpServerType): CanonicalMcpServerDescriptor =>
  CanonicalMcpServerDescriptor.make({
    id: server.id,
    protocolVersion: server.protocolVersion,
  })

export const canonicalMcpToolProjectionDescriptor = (
  server: McpServerType,
  projection: McpToolProjection,
): CanonicalMcpToolProjectionDescriptor =>
  projection._tag === 'Action'
    ? CanonicalMcpToolProjectionDescriptor.make({
        _tag: 'McpActionProjection',
        serverId: server.id,
        serverProtocolVersion: server.protocolVersion,
        name: projection.name,
        tool: canonicalActionToolDescriptor(projection.tool),
      })
    : CanonicalMcpToolProjectionDescriptor.make({
        _tag: 'McpFeedbackProjection',
        serverId: server.id,
        serverProtocolVersion: server.protocolVersion,
        name: projection.name,
        tool: canonicalFeedbackToolDescriptor(projection.tool),
      })

const optionalJsonField = (key: string, value: string | number | undefined): Schema.JsonObject =>
  value === undefined ? {} : { [key]: value }

const protocolVersionJson = (version: CapabilityProtocolVersion): Schema.JsonObject => ({
  major: version.major,
  minor: version.minor,
})

const portablePropertyJson = (property: PortableObjectProperty): Schema.JsonObject => ({
  name: property.name,
  required: property.required,
  schema: portableSchemaJson(property.schema),
})

const portableSchemaJson = (schema: PortableValueSchema): Schema.JsonObject => {
  switch (schema._tag) {
    case 'String':
    case 'Boolean':
      return {
        _tag: schema._tag,
        ...optionalJsonField('description', schema.description),
      }
    case 'Number':
    case 'Integer':
      return {
        _tag: schema._tag,
        ...optionalJsonField('description', schema.description),
        ...optionalJsonField('minimum', schema.minimum),
        ...optionalJsonField('maximum', schema.maximum),
      }
    case 'StringEnum':
      return {
        _tag: schema._tag,
        ...optionalJsonField('description', schema.description),
        values: [...schema.values],
      }
    case 'Array':
      return {
        _tag: schema._tag,
        ...optionalJsonField('description', schema.description),
        items: portableSchemaJson(schema.items),
        minItems: schema.minItems,
        maxItems: schema.maxItems,
      }
    case 'Object':
      return {
        _tag: schema._tag,
        ...optionalJsonField('description', schema.description),
        properties: schema.properties.map(portablePropertyJson),
      }
  }
}

const skillSelectionJson = (selection: SkillSelection): Schema.JsonObject =>
  selection._tag === 'Always'
    ? { _tag: 'Always' }
    : {
        _tag: 'MatchAny',
        keywords: [...selection.keywords],
        responseMechanisms: [...selection.responseMechanisms],
        eventKinds: [...selection.eventKinds],
      }

const contextProviderSelectionJson = (selection: ContextProviderSelection): Schema.JsonObject =>
  selection._tag === 'Always'
    ? { _tag: 'Always' }
    : {
        _tag: 'MatchAny',
        keywords: [...selection.keywords],
        responseMechanisms: [...selection.responseMechanisms],
        skills: [...selection.skills],
      }

const capabilityDescriptorJson = (
  descriptor: FingerprintableCapabilityDescriptor,
): Schema.JsonObject => {
  switch (descriptor._tag) {
    case 'ContextProvider':
      return {
        _tag: descriptor._tag,
        id: descriptor.id,
        protocolVersion: protocolVersionJson(descriptor.protocolVersion),
        description: descriptor.description,
        maxTokens: descriptor.maxTokens,
        maxDurationMs: descriptor.maxDurationMs,
        selection: contextProviderSelectionJson(descriptor.selection),
      }
    case 'ActionTool':
      return {
        _tag: descriptor._tag,
        id: descriptor.id,
        protocolVersion: protocolVersionJson(descriptor.protocolVersion),
        description: descriptor.description,
        xmlTemplate: descriptor.xmlTemplate,
        inputSchema: portableSchemaJson(descriptor.inputSchema),
        executionStage: descriptor.executionStage,
        completionPolicy: descriptor.completionPolicy,
        failurePolicy: descriptor.failurePolicy,
        maxDurationMs: descriptor.maxDurationMs,
      }
    case 'FeedbackTool':
      return {
        _tag: descriptor._tag,
        id: descriptor.id,
        protocolVersion: protocolVersionJson(descriptor.protocolVersion),
        description: descriptor.description,
        inputSchema: portableSchemaJson(descriptor.inputSchema),
        outputSchema: portableSchemaJson(descriptor.outputSchema),
        maxResultTokens: descriptor.maxResultTokens,
        maxDurationMs: descriptor.maxDurationMs,
      }
    case 'Skill':
      return {
        _tag: descriptor._tag,
        id: descriptor.id,
        protocolVersion: protocolVersionJson(descriptor.protocolVersion),
        description: descriptor.description,
        promptHash: descriptor.promptHash,
        selection: skillSelectionJson(descriptor.selection),
        contextProviders: [...descriptor.contextProviders],
        actionTools: [...descriptor.actionTools],
        feedbackTools: [...descriptor.feedbackTools],
      }
    case 'McpServer':
      return {
        _tag: descriptor._tag,
        id: descriptor.id,
        protocolVersion: protocolVersionJson(descriptor.protocolVersion),
      }
    case 'McpActionProjection':
    case 'McpFeedbackProjection':
      return {
        _tag: descriptor._tag,
        serverId: descriptor.serverId,
        serverProtocolVersion: protocolVersionJson(descriptor.serverProtocolVersion),
        name: descriptor.name,
        tool: capabilityDescriptorJson(descriptor.tool),
      }
  }
}

export const capabilityDescriptorFingerprintV1 = (
  descriptor: FingerprintableCapabilityDescriptor,
): Result.Result<Sha256Digest, CanonicalJsonError> =>
  Result.map(canonicalJsonSha256Hex(capabilityDescriptorJson(descriptor)), Sha256Digest.make)

export const encodedCapabilityDescriptorBytesV1 = (
  descriptor: FingerprintableCapabilityDescriptor,
): Result.Result<number, CanonicalJsonError> =>
  canonicalJsonByteLength(capabilityDescriptorJson(descriptor))

const modelExposureBytes = (
  descriptor: ModelExposedCapabilityDescriptor,
): Result.Result<number, CanonicalJsonError> => {
  switch (descriptor._tag) {
    case 'ActionTool':
      return canonicalJsonByteLength({
        id: descriptor.id,
        description: descriptor.description,
        xmlTemplate: descriptor.xmlTemplate,
        inputSchema: portableSchemaJson(descriptor.inputSchema),
      })
    case 'FeedbackTool':
      return canonicalJsonByteLength({
        id: descriptor.id,
        description: descriptor.description,
        inputSchema: portableSchemaJson(descriptor.inputSchema),
      })
    case 'McpActionProjection':
    case 'McpFeedbackProjection':
      return modelExposureBytes(descriptor.tool)
  }
}

export const capabilityModelExposureBytesV1 = modelExposureBytes

const descriptorModelExposureBytes = (
  descriptor: FingerprintableCapabilityDescriptor,
): Result.Result<number, CanonicalJsonError> => {
  switch (descriptor._tag) {
    case 'ActionTool':
    case 'FeedbackTool':
    case 'McpActionProjection':
    case 'McpFeedbackProjection':
      return capabilityModelExposureBytesV1(descriptor)
    case 'ContextProvider':
    case 'Skill':
    case 'McpServer':
      return Result.succeed(0)
  }
}

/** Builds the complete fingerprint and byte evidence consumed by registry inventory. */
export const capabilityDescriptorIdentityV1 = (
  descriptor: FingerprintableCapabilityDescriptor,
): Result.Result<CapabilityDescriptorIdentityV1, CanonicalJsonError> =>
  Result.gen(function* () {
    const descriptorHash = yield* capabilityDescriptorFingerprintV1(descriptor)
    const encodedDescriptorBytes = yield* encodedCapabilityDescriptorBytesV1(descriptor)
    const exposureBytes = yield* descriptorModelExposureBytes(descriptor)
    return CapabilityDescriptorIdentityV1.make({
      version: CAPABILITY_DESCRIPTOR_IDENTITY_VERSION,
      fingerprintVersion: CAPABILITY_FINGERPRINT_VERSION,
      descriptorHash,
      encodedDescriptorBytes,
      modelExposureBytes: exposureBytes,
    })
  })

export const CapabilityDescriptorKind = Schema.Literals([
  'context-provider',
  'action-tool',
  'feedback-tool',
  'skill',
  'mcp-server',
  'mcp-projection',
])

export type CapabilityDescriptorKind = typeof CapabilityDescriptorKind.Type

const MAX_JSON_ESCAPED_BYTES_PER_UTF16_CODE_UNIT = 6
const MAX_JSON_CONTAINER_OVERHEAD_BYTES = 256
const MAX_SAFE_INTEGER_DIGITS = String(Number.MAX_SAFE_INTEGER).length
const MAX_ENCODED_PROTOCOL_VERSION_BYTES =
  '{"major":'.length +
  MAX_SAFE_INTEGER_DIGITS +
  ',"minor":'.length +
  MAX_SAFE_INTEGER_DIGITS +
  '}'.length
const MAX_PORTABLE_SCHEMA_NODES = 1 + MAX_PORTABLE_SCHEMA_PROPERTIES * MAX_PORTABLE_SCHEMA_DEPTH
const MAX_PORTABLE_ENUM_MEMBERS = MAX_PORTABLE_SCHEMA_PROPERTIES * MAX_PORTABLE_ENUM_VALUES
const MAX_PORTABLE_SCHEMA_STRING_CODE_UNITS =
  MAX_PORTABLE_SCHEMA_NODES * MAX_PORTABLE_DESCRIPTION_LENGTH +
  MAX_PORTABLE_SCHEMA_PROPERTIES * MAX_PORTABLE_PROPERTY_NAME_LENGTH +
  MAX_PORTABLE_ENUM_MEMBERS * MAX_PORTABLE_ENUM_VALUE_LENGTH

/**
 * A conservative, allocation-free upper bound derived from every bounded
 * string and collection in the Portable Schema v1 grammar.
 */
export const MAX_ENCODED_PORTABLE_SCHEMA_BYTES_V1 =
  MAX_PORTABLE_SCHEMA_STRING_CODE_UNITS * MAX_JSON_ESCAPED_BYTES_PER_UTF16_CODE_UNIT +
  MAX_PORTABLE_SCHEMA_NODES * MAX_JSON_CONTAINER_OVERHEAD_BYTES +
  MAX_PORTABLE_ENUM_MEMBERS * 4

const MAX_ENCODED_IDENTIFIER_BYTES =
  128 * MAX_JSON_ESCAPED_BYTES_PER_UTF16_CODE_UNIT + MAX_JSON_CONTAINER_OVERHEAD_BYTES
const MAX_ENCODED_LOCAL_SELECTION_BYTES =
  (MAX_LOCAL_SELECTION_KEYWORDS * MAX_LOCAL_SELECTION_KEYWORD_LENGTH +
    (MAX_LOCAL_SELECTION_RESPONSE_MECHANISMS + MAX_LOCAL_SELECTION_SKILLS) * 128) *
    MAX_JSON_ESCAPED_BYTES_PER_UTF16_CODE_UNIT +
  MAX_JSON_CONTAINER_OVERHEAD_BYTES * 4
const MAX_ENCODED_CONTEXT_PROVIDER_DESCRIPTOR_BYTES_V1 =
  MAX_CONTEXT_PROVIDER_DESCRIPTION_LENGTH * MAX_JSON_ESCAPED_BYTES_PER_UTF16_CODE_UNIT +
  MAX_ENCODED_LOCAL_SELECTION_BYTES +
  MAX_ENCODED_IDENTIFIER_BYTES +
  MAX_ENCODED_PROTOCOL_VERSION_BYTES +
  MAX_JSON_CONTAINER_OVERHEAD_BYTES * 2
const MAX_ENCODED_ACTION_TOOL_DESCRIPTOR_BYTES_V1 =
  MAX_ENCODED_PORTABLE_SCHEMA_BYTES_V1 +
  (MAX_ACTION_TOOL_DESCRIPTION_LENGTH + MAX_ACTION_TOOL_XML_TEMPLATE_LENGTH) *
    MAX_JSON_ESCAPED_BYTES_PER_UTF16_CODE_UNIT +
  MAX_ENCODED_IDENTIFIER_BYTES +
  MAX_ENCODED_PROTOCOL_VERSION_BYTES +
  MAX_JSON_CONTAINER_OVERHEAD_BYTES * 2
const MAX_ENCODED_FEEDBACK_TOOL_DESCRIPTOR_BYTES_V1 =
  MAX_ENCODED_PORTABLE_SCHEMA_BYTES_V1 * 2 +
  MAX_FEEDBACK_TOOL_DESCRIPTION_LENGTH * MAX_JSON_ESCAPED_BYTES_PER_UTF16_CODE_UNIT +
  MAX_ENCODED_IDENTIFIER_BYTES +
  MAX_ENCODED_PROTOCOL_VERSION_BYTES +
  MAX_JSON_CONTAINER_OVERHEAD_BYTES * 2
const MAX_ENCODED_SKILL_DESCRIPTOR_BYTES_V1 =
  (MAX_SKILL_DESCRIPTION_LENGTH + 64 + MAX_SKILL_CAPABILITY_REFERENCES * 3 * 128) *
    MAX_JSON_ESCAPED_BYTES_PER_UTF16_CODE_UNIT +
  MAX_ENCODED_LOCAL_SELECTION_BYTES +
  MAX_ENCODED_IDENTIFIER_BYTES +
  MAX_ENCODED_PROTOCOL_VERSION_BYTES +
  MAX_JSON_CONTAINER_OVERHEAD_BYTES * 4
const MAX_ENCODED_MCP_SERVER_DESCRIPTOR_BYTES_V1 =
  MAX_ENCODED_IDENTIFIER_BYTES +
  MAX_ENCODED_PROTOCOL_VERSION_BYTES +
  MAX_JSON_CONTAINER_OVERHEAD_BYTES
const MAX_ENCODED_MCP_PROJECTION_DESCRIPTOR_BYTES_V1 =
  Math.max(
    MAX_ENCODED_ACTION_TOOL_DESCRIPTOR_BYTES_V1,
    MAX_ENCODED_FEEDBACK_TOOL_DESCRIPTOR_BYTES_V1,
  ) +
  MAX_MCP_TOOL_NAME_LENGTH * MAX_JSON_ESCAPED_BYTES_PER_UTF16_CODE_UNIT +
  MAX_ENCODED_IDENTIFIER_BYTES +
  MAX_ENCODED_PROTOCOL_VERSION_BYTES +
  MAX_JSON_CONTAINER_OVERHEAD_BYTES * 2

export const MAX_ENCODED_DECLARATION_BYTES_V1 = {
  'context-provider': MAX_ENCODED_CONTEXT_PROVIDER_DESCRIPTOR_BYTES_V1,
  'action-tool': MAX_ENCODED_ACTION_TOOL_DESCRIPTOR_BYTES_V1,
  'feedback-tool': MAX_ENCODED_FEEDBACK_TOOL_DESCRIPTOR_BYTES_V1,
  skill: MAX_ENCODED_SKILL_DESCRIPTOR_BYTES_V1,
  'mcp-server': MAX_ENCODED_MCP_SERVER_DESCRIPTOR_BYTES_V1,
  'mcp-projection': MAX_ENCODED_MCP_PROJECTION_DESCRIPTOR_BYTES_V1,
} as const

const MAX_ENCODED_DECLARATION_BYTES_BY_FINGERPRINT_VERSION = {
  [CAPABILITY_FINGERPRINT_VERSION]: MAX_ENCODED_DECLARATION_BYTES_V1,
} as const

const encodedProtocolVersionBytes = (protocolVersion: CapabilityProtocolVersion): number =>
  '{"major":'.length +
  String(protocolVersion.major).length +
  ',"minor":'.length +
  String(protocolVersion.minor).length +
  '}'.length

/**
 * Returns the registration hard cap generated for one capability protocol
 * version under an explicitly versioned canonical descriptor grammar.
 * Capability version numbers are data in v1; adding declaration fields must
 * introduce a new fingerprint version and a corresponding limit table.
 */
export const maxEncodedDeclarationBytes = (
  protocolVersion: CapabilityProtocolVersion,
  kind: CapabilityDescriptorKind,
  fingerprintVersion: CapabilityFingerprintVersion = CAPABILITY_FINGERPRINT_VERSION,
): number =>
  MAX_ENCODED_DECLARATION_BYTES_BY_FINGERPRINT_VERSION[fingerprintVersion][kind] -
  MAX_ENCODED_PROTOCOL_VERSION_BYTES +
  encodedProtocolVersionBytes(protocolVersion)

const descriptorKind = (
  descriptor: FingerprintableCapabilityDescriptor,
): CapabilityDescriptorKind => {
  switch (descriptor._tag) {
    case 'ContextProvider':
      return 'context-provider'
    case 'ActionTool':
      return 'action-tool'
    case 'FeedbackTool':
      return 'feedback-tool'
    case 'Skill':
      return 'skill'
    case 'McpServer':
      return 'mcp-server'
    case 'McpActionProjection':
    case 'McpFeedbackProjection':
      return 'mcp-projection'
  }
}

const descriptorProtocolVersion = (
  descriptor: FingerprintableCapabilityDescriptor,
): CapabilityProtocolVersion => {
  switch (descriptor._tag) {
    case 'ContextProvider':
    case 'ActionTool':
    case 'FeedbackTool':
    case 'Skill':
    case 'McpServer':
      return descriptor.protocolVersion
    case 'McpActionProjection':
    case 'McpFeedbackProjection':
      return descriptor.tool.protocolVersion
  }
}

const declarationByteMetrics = Schema.Struct({
  encodedDescriptorBytes: Schema.Natural,
  modelExposureBytes: Schema.Natural,
  turnBudgetBytes: Schema.Natural,
  protocolHardCapBytes: Schema.Natural,
})

export const CapabilityDeclarationByteStatus = Schema.TaggedUnion({
  WithinTurnBudget: declarationByteMetrics.fields,
  TurnBudgetExceeded: declarationByteMetrics.fields,
  ProtocolHardCapExceeded: declarationByteMetrics.fields,
})

export type CapabilityDeclarationByteStatus = typeof CapabilityDeclarationByteStatus.Type

/**
 * Classifies protocol legality before the lower, per-turn model exposure cap.
 * A descriptor may therefore remain registered while being hidden for a turn.
 */
export const capabilityDeclarationByteStatusV1 = (
  descriptor: ModelExposedCapabilityDescriptor,
  turnBudgetBytes: number,
): Result.Result<CapabilityDeclarationByteStatus, CanonicalJsonError> =>
  Result.gen(function* () {
    const encodedDescriptorBytes = yield* encodedCapabilityDescriptorBytesV1(descriptor)
    const exposureBytes = yield* capabilityModelExposureBytesV1(descriptor)
    const protocolHardCapBytes = maxEncodedDeclarationBytes(
      descriptorProtocolVersion(descriptor),
      descriptorKind(descriptor),
    )
    const metrics = {
      encodedDescriptorBytes,
      modelExposureBytes: exposureBytes,
      turnBudgetBytes,
      protocolHardCapBytes,
    }

    if (encodedDescriptorBytes > protocolHardCapBytes) {
      return CapabilityDeclarationByteStatus.make({
        _tag: 'ProtocolHardCapExceeded',
        ...metrics,
      })
    }
    return CapabilityDeclarationByteStatus.make({
      _tag: exposureBytes > turnBudgetBytes ? 'TurnBudgetExceeded' : 'WithinTurnBudget',
      ...metrics,
    })
  })
