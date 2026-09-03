import { expect, it } from '@effect/vitest'
import { Effect, Result, Schema } from 'effect'

import {
  ActionTool,
  CanonicalCapabilityDescriptor,
  CanonicalMcpToolProjectionDescriptor,
  ContextProvider,
  FeedbackTool,
  McpServer,
  McpServerSnapshot,
  McpToolName,
  Skill,
  capabilityDeclarationByteStatusV1,
  capabilityDescriptorIdentityV1,
  capabilityDescriptorFingerprintV1,
  capabilityModelExposureBytesV1,
  canonicalActionToolDescriptor,
  canonicalContextProviderDescriptor,
  canonicalFeedbackToolDescriptor,
  canonicalMcpServerDescriptor,
  canonicalMcpToolProjectionDescriptor,
  canonicalSkillDescriptor,
  encodedCapabilityDescriptorBytesV1,
  maxEncodedDeclarationBytes,
  skillPromptHashV1,
  type FingerprintableCapabilityDescriptor,
} from '../../../src/index'

const actionDefinition = {
  id: 'calendar.create',
  protocolVersion: { major: 0, minor: 1 },
  description: 'Create one calendar entry.',
  xmlTemplate: '<action tool="calendar.create"><title>XML_ESCAPED_TITLE</title></action>',
  inputSchema: {
    _tag: 'Object',
    properties: [
      {
        name: 'title',
        required: true,
        schema: { _tag: 'String', description: 'Calendar entry title.' },
      },
    ],
  },
  executionStage: 'deferred',
  completionPolicy: 'none',
  failurePolicy: 'continue',
  maxDurationMs: 250,
  isAvailable: () => true,
  isInputAllowed: () => true,
  execute: () => Effect.void,
}

const feedbackDefinition = {
  id: 'history.search',
  protocolVersion: { major: 0, minor: 1 },
  description: 'Search local history.',
  inputSchema: {
    _tag: 'Object',
    properties: [
      {
        name: 'query',
        required: true,
        schema: { _tag: 'String', description: 'Exact query.' },
      },
    ],
  },
  outputSchema: {
    _tag: 'Array',
    description: 'Matches.',
    items: { _tag: 'String' },
    minItems: 0,
    maxItems: 8,
  },
  maxResultTokens: 64,
  maxDurationMs: 250,
  isAvailable: () => true,
  prepare: () => Effect.succeed({ execute: () => Effect.succeed(['match']) }),
}

const contextProviderDefinition = {
  id: 'history.context',
  protocolVersion: { major: 0, minor: 1 },
  description: 'Select relevant local history.',
  maxTokens: 512,
  maxDurationMs: 100,
  selection: { _tag: 'Always' },
  isAvailable: () => true,
  provide: () => Effect.succeedNone,
}

const skillDefinition = {
  id: 'calendar.assistant',
  protocolVersion: { major: 0, minor: 1 },
  description: 'Help with calendar tasks.',
  prompt: 'Apply the trusted calendar rules.',
  selection: { _tag: 'Always' },
  contextProviders: ['history.context'],
  actionTools: ['calendar.create'],
  feedbackTools: ['history.search'],
}

const fingerprint = (descriptor: FingerprintableCapabilityDescriptor) =>
  Effect.fromResult(capabilityDescriptorFingerprintV1(descriptor))

it('hashes exact Skill prompt UTF-8 bytes with the v1 SHA-256 vector', () => {
  expect(skillPromptHashV1('abc')).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
})

it.effect('rejects non-I-JSON registration text and negative-zero protocol versions', () =>
  Effect.gen(function* () {
    const results = yield* Effect.all([
      Schema.decodeUnknownEffect(ContextProvider)({
        ...contextProviderDefinition,
        description: '\ud800',
      }).pipe(Effect.result),
      Schema.decodeUnknownEffect(ActionTool)({
        ...actionDefinition,
        xmlTemplate: '\ud800',
      }).pipe(Effect.result),
      Schema.decodeUnknownEffect(FeedbackTool)({
        ...feedbackDefinition,
        description: '\ud800',
      }).pipe(Effect.result),
      Schema.decodeUnknownEffect(Skill)({
        ...skillDefinition,
        prompt: '\ud800',
      }).pipe(Effect.result),
      Schema.decodeUnknownEffect(McpServer)({
        id: 'calendar',
        protocolVersion: { major: -0, minor: 1 },
      }).pipe(Effect.result),
    ])

    expect(results.every((result) => result._tag === 'Failure')).toBe(true)
  }),
)

it.effect('matches the fixed canonical FeedbackTool descriptor vector', () =>
  Effect.gen(function* () {
    const tool = yield* Schema.decodeUnknownEffect(FeedbackTool)(feedbackDefinition)
    const descriptor = canonicalFeedbackToolDescriptor(tool)
    const identity = yield* Effect.fromResult(capabilityDescriptorIdentityV1(descriptor))

    expect(yield* Effect.fromResult(encodedCapabilityDescriptorBytesV1(descriptor))).toBe(409)
    expect(yield* fingerprint(descriptor)).toBe(
      '21247e63e31333862d4765b50e541ebdb035a28c787e42088c2d9b7c5d946f81',
    )
    expect(identity).toMatchObject({
      version: 1,
      fingerprintVersion: 1,
      descriptorHash: '21247e63e31333862d4765b50e541ebdb035a28c787e42088c2d9b7c5d946f81',
      encodedDescriptorBytes: 409,
    })
    expect(identity.modelExposureBytes).toBeGreaterThan(0)
  }),
)

it.effect('normalizes all five capability registrations into wire-safe descriptors', () =>
  Effect.gen(function* () {
    const provider = yield* Schema.decodeUnknownEffect(ContextProvider)(contextProviderDefinition)
    const action = yield* Schema.decodeUnknownEffect(ActionTool)(actionDefinition)
    const feedback = yield* Schema.decodeUnknownEffect(FeedbackTool)(feedbackDefinition)
    const skill = yield* Schema.decodeUnknownEffect(Skill)(skillDefinition)
    const server = yield* Schema.decodeUnknownEffect(McpServer)({
      id: 'calendar',
      protocolVersion: { major: 0, minor: 1 },
    })

    const descriptors = [
      canonicalContextProviderDescriptor(provider),
      canonicalActionToolDescriptor(action),
      canonicalFeedbackToolDescriptor(feedback),
      canonicalSkillDescriptor(skill),
      canonicalMcpServerDescriptor(server),
    ]
    yield* Effect.forEach(descriptors, (descriptor) =>
      Schema.decodeUnknownEffect(CanonicalCapabilityDescriptor)(descriptor),
    )
    const identities = yield* Effect.forEach(descriptors, (descriptor) =>
      Effect.fromResult(capabilityDescriptorIdentityV1(descriptor)),
    )
    expect(descriptors.map((descriptor) => descriptor._tag)).toEqual([
      'ContextProvider',
      'ActionTool',
      'FeedbackTool',
      'Skill',
      'McpServer',
    ])
    expect(identities.map((identity) => identity.modelExposureBytes > 0)).toEqual([
      false,
      true,
      true,
      false,
      false,
    ])
    expect(descriptors[3]).toHaveProperty('promptHash')
    expect(descriptors[3]).not.toHaveProperty('prompt')
  }),
)

it.effect('changes the ContextProvider hash for every static or permission field', () =>
  Effect.gen(function* () {
    const candidates = [
      contextProviderDefinition,
      { ...contextProviderDefinition, id: 'notebook.context' },
      { ...contextProviderDefinition, protocolVersion: { major: 0, minor: 2 } },
      { ...contextProviderDefinition, description: 'Select notebook context.' },
      { ...contextProviderDefinition, maxTokens: 256 },
      { ...contextProviderDefinition, maxDurationMs: 101 },
      {
        ...contextProviderDefinition,
        selection: {
          _tag: 'MatchAny',
          keywords: ['history'],
          responseMechanisms: [],
          skills: [],
        },
      },
      {
        ...contextProviderDefinition,
        selection: {
          _tag: 'MatchAny',
          keywords: [],
          responseMechanisms: ['direct'],
          skills: [],
        },
      },
      {
        ...contextProviderDefinition,
        selection: {
          _tag: 'MatchAny',
          keywords: [],
          responseMechanisms: [],
          skills: ['calendar.assistant'],
        },
      },
    ]
    const providers = yield* Effect.forEach(candidates, (candidate) =>
      Schema.decodeUnknownEffect(ContextProvider)(candidate),
    )
    const hashes = yield* Effect.forEach(
      providers.map(canonicalContextProviderDescriptor),
      fingerprint,
    )

    expect(new Set(hashes).size).toBe(candidates.length)
  }),
)

it.effect('changes the ActionTool hash for every static or permission field', () =>
  Effect.gen(function* () {
    const candidates = [
      actionDefinition,
      { ...actionDefinition, id: 'calendar.update' },
      { ...actionDefinition, protocolVersion: { major: 0, minor: 2 } },
      { ...actionDefinition, description: 'Create a dated calendar entry.' },
      {
        ...actionDefinition,
        xmlTemplate: '<action tool="calendar.create"><date>XML_ESCAPED_DATE</date></action>',
      },
      {
        ...actionDefinition,
        inputSchema: {
          _tag: 'Object',
          properties: [
            {
              name: 'title',
              required: true,
              schema: { _tag: 'String', description: 'A changed field description.' },
            },
          ],
        },
      },
      { ...actionDefinition, executionStage: 'after-send' },
      { ...actionDefinition, completionPolicy: 'wake' },
      {
        ...actionDefinition,
        executionStage: 'before-send',
        failurePolicy: 'block-reply',
      },
      { ...actionDefinition, maxDurationMs: 251 },
    ]
    const tools = yield* Effect.forEach(candidates, (candidate) =>
      Schema.decodeUnknownEffect(ActionTool)(candidate),
    )
    const hashes = yield* Effect.forEach(tools.map(canonicalActionToolDescriptor), fingerprint)

    expect(new Set(hashes).size).toBe(candidates.length)
  }),
)

it.effect('hashes one-field Portable Schema mutations and preserves meaningful array order', () =>
  Effect.gen(function* () {
    const property = (schema: object, name = 'value', required = true) => ({
      name,
      required,
      schema,
    })
    const schemaPairs: ReadonlyArray<readonly [object, object]> = [
      [
        { _tag: 'Object', properties: [property({ _tag: 'String' })] },
        {
          _tag: 'Object',
          description: 'Root input.',
          properties: [property({ _tag: 'String' })],
        },
      ],
      [
        { _tag: 'Object', properties: [property({ _tag: 'String' })] },
        { _tag: 'Object', properties: [property({ _tag: 'String' }, 'other')] },
      ],
      [
        { _tag: 'Object', properties: [property({ _tag: 'String' })] },
        { _tag: 'Object', properties: [property({ _tag: 'String' }, 'value', false)] },
      ],
      [
        { _tag: 'Object', properties: [property({ _tag: 'String' })] },
        { _tag: 'Object', properties: [property({ _tag: 'Boolean' })] },
      ],
      [
        { _tag: 'Object', properties: [property({ _tag: 'String' })] },
        {
          _tag: 'Object',
          properties: [property({ _tag: 'String', description: 'Text value.' })],
        },
      ],
      [
        { _tag: 'Object', properties: [property({ _tag: 'Number' })] },
        { _tag: 'Object', properties: [property({ _tag: 'Number', minimum: 0 })] },
      ],
      [
        { _tag: 'Object', properties: [property({ _tag: 'Number' })] },
        { _tag: 'Object', properties: [property({ _tag: 'Number', maximum: 1 })] },
      ],
      [
        { _tag: 'Object', properties: [property({ _tag: 'Integer' })] },
        { _tag: 'Object', properties: [property({ _tag: 'Integer', minimum: 0 })] },
      ],
      [
        { _tag: 'Object', properties: [property({ _tag: 'Integer' })] },
        { _tag: 'Object', properties: [property({ _tag: 'Integer', maximum: 1 })] },
      ],
      [
        { _tag: 'Object', properties: [property({ _tag: 'StringEnum', values: ['a', 'b'] })] },
        { _tag: 'Object', properties: [property({ _tag: 'StringEnum', values: ['a', 'c'] })] },
      ],
      [
        { _tag: 'Object', properties: [property({ _tag: 'StringEnum', values: ['a', 'b'] })] },
        { _tag: 'Object', properties: [property({ _tag: 'StringEnum', values: ['b', 'a'] })] },
      ],
      [
        {
          _tag: 'Object',
          properties: [
            property({ _tag: 'Array', items: { _tag: 'String' }, minItems: 0, maxItems: 2 }),
          ],
        },
        {
          _tag: 'Object',
          properties: [
            property({ _tag: 'Array', items: { _tag: 'Boolean' }, minItems: 0, maxItems: 2 }),
          ],
        },
      ],
      [
        {
          _tag: 'Object',
          properties: [
            property({ _tag: 'Array', items: { _tag: 'String' }, minItems: 0, maxItems: 2 }),
          ],
        },
        {
          _tag: 'Object',
          properties: [
            property({ _tag: 'Array', items: { _tag: 'String' }, minItems: 1, maxItems: 2 }),
          ],
        },
      ],
      [
        {
          _tag: 'Object',
          properties: [
            property({ _tag: 'Array', items: { _tag: 'String' }, minItems: 0, maxItems: 1 }),
          ],
        },
        {
          _tag: 'Object',
          properties: [
            property({ _tag: 'Array', items: { _tag: 'String' }, minItems: 0, maxItems: 2 }),
          ],
        },
      ],
      [
        {
          _tag: 'Object',
          properties: [
            property({ _tag: 'String' }, 'first'),
            property({ _tag: 'String' }, 'second'),
          ],
        },
        {
          _tag: 'Object',
          properties: [
            property({ _tag: 'String' }, 'second'),
            property({ _tag: 'String' }, 'first'),
          ],
        },
      ],
    ]
    const changed = yield* Effect.forEach(schemaPairs, ([baselineSchema, changedSchema]) =>
      Effect.gen(function* () {
        const baseline = yield* Schema.decodeUnknownEffect(ActionTool)({
          ...actionDefinition,
          inputSchema: baselineSchema,
        })
        const mutation = yield* Schema.decodeUnknownEffect(ActionTool)({
          ...actionDefinition,
          inputSchema: changedSchema,
        })
        return (
          (yield* fingerprint(canonicalActionToolDescriptor(baseline))) !==
          (yield* fingerprint(canonicalActionToolDescriptor(mutation)))
        )
      }),
    )

    expect(changed.every(Boolean)).toBe(true)
  }),
)

it.effect('changes the FeedbackTool hash for every static or permission field', () =>
  Effect.gen(function* () {
    const candidates = [
      feedbackDefinition,
      { ...feedbackDefinition, id: 'history.lookup' },
      { ...feedbackDefinition, protocolVersion: { major: 0, minor: 2 } },
      { ...feedbackDefinition, description: 'Look up local history.' },
      {
        ...feedbackDefinition,
        inputSchema: {
          _tag: 'Object',
          properties: [
            {
              name: 'query',
              required: false,
              schema: { _tag: 'String', description: 'Exact query.' },
            },
          ],
        },
      },
      { ...feedbackDefinition, outputSchema: { _tag: 'String', description: 'One match.' } },
      { ...feedbackDefinition, maxResultTokens: 65 },
      { ...feedbackDefinition, maxDurationMs: 251 },
    ]
    const tools = yield* Effect.forEach(candidates, (candidate) =>
      Schema.decodeUnknownEffect(FeedbackTool)(candidate),
    )
    const hashes = yield* Effect.forEach(tools.map(canonicalFeedbackToolDescriptor), fingerprint)

    expect(new Set(hashes).size).toBe(candidates.length)
  }),
)

it.effect('changes the Skill hash for every selection, instruction, and dependency field', () =>
  Effect.gen(function* () {
    const candidates = [
      skillDefinition,
      { ...skillDefinition, id: 'calendar.writer' },
      { ...skillDefinition, protocolVersion: { major: 0, minor: 2 } },
      { ...skillDefinition, description: 'Help write calendar entries.' },
      { ...skillDefinition, prompt: 'Apply a different trusted calendar rule.' },
      {
        ...skillDefinition,
        selection: {
          _tag: 'MatchAny',
          keywords: ['calendar'],
          responseMechanisms: [],
          eventKinds: [],
        },
      },
      {
        ...skillDefinition,
        selection: {
          _tag: 'MatchAny',
          keywords: [],
          responseMechanisms: ['direct'],
          eventKinds: [],
        },
      },
      {
        ...skillDefinition,
        selection: {
          _tag: 'MatchAny',
          keywords: [],
          responseMechanisms: [],
          eventKinds: ['schedule'],
        },
      },
      { ...skillDefinition, contextProviders: ['notebook.context'] },
      { ...skillDefinition, actionTools: ['calendar.update'] },
      { ...skillDefinition, feedbackTools: ['schedule.query'] },
    ]
    const skills = yield* Effect.forEach(candidates, (candidate) =>
      Schema.decodeUnknownEffect(Skill)(candidate),
    )
    const hashes = yield* Effect.forEach(skills.map(canonicalSkillDescriptor), fingerprint)

    expect(new Set(hashes).size).toBe(candidates.length)
  }),
)

it.effect('binds MCP projection server, name, type, and complete projected descriptor', () =>
  Effect.gen(function* () {
    const server = yield* Schema.decodeUnknownEffect(McpServer)({
      id: 'calendar',
      protocolVersion: { major: 0, minor: 1 },
    })
    const otherServer = yield* Schema.decodeUnknownEffect(McpServer)({
      id: 'other',
      protocolVersion: { major: 0, minor: 1 },
    })
    const newerServer = yield* Schema.decodeUnknownEffect(McpServer)({
      id: 'calendar',
      protocolVersion: { major: 0, minor: 2 },
    })
    const action = yield* Schema.decodeUnknownEffect(ActionTool)(actionDefinition)
    const otherAction = yield* Schema.decodeUnknownEffect(ActionTool)({
      ...actionDefinition,
      id: 'other.create',
    })
    const writeAction = yield* Schema.decodeUnknownEffect(ActionTool)({
      ...actionDefinition,
      id: 'calendar.write',
    })
    const feedback = yield* Schema.decodeUnknownEffect(FeedbackTool)({
      ...feedbackDefinition,
      id: 'calendar.create',
    })
    const variants = [
      canonicalMcpToolProjectionDescriptor(server, {
        _tag: 'Action',
        name: McpToolName.make('create'),
        tool: action,
      }),
      canonicalMcpToolProjectionDescriptor(otherServer, {
        _tag: 'Action',
        name: McpToolName.make('create'),
        tool: otherAction,
      }),
      canonicalMcpToolProjectionDescriptor(server, {
        _tag: 'Action',
        name: McpToolName.make('write'),
        tool: writeAction,
      }),
      canonicalMcpToolProjectionDescriptor(server, {
        _tag: 'Feedback',
        name: McpToolName.make('create'),
        tool: feedback,
      }),
      canonicalMcpToolProjectionDescriptor(newerServer, {
        _tag: 'Action',
        name: McpToolName.make('create'),
        tool: action,
      }),
    ]
    const hashes = yield* Effect.forEach(variants, fingerprint)

    expect(new Set(hashes).size).toBe(variants.length)
  }),
)

it.effect('changes the independent MCP Server hash for its ID and protocol version', () =>
  Effect.gen(function* () {
    const servers = yield* Effect.forEach(
      [
        { id: 'calendar', protocolVersion: { major: 0, minor: 1 } },
        { id: 'other', protocolVersion: { major: 0, minor: 1 } },
        { id: 'calendar', protocolVersion: { major: 0, minor: 2 } },
      ],
      (candidate) => Schema.decodeUnknownEffect(McpServer)(candidate),
    )
    const hashes = yield* Effect.forEach(servers.map(canonicalMcpServerDescriptor), fingerprint)

    expect(new Set(hashes).size).toBe(servers.length)
  }),
)

it.effect('rejects invalid canonical Action policy and MCP namespace combinations', () =>
  Effect.gen(function* () {
    const action = yield* Schema.decodeUnknownEffect(ActionTool)(actionDefinition)
    const descriptor = canonicalActionToolDescriptor(action)
    const invalidPolicy = yield* Schema.decodeUnknownEffect(CanonicalCapabilityDescriptor)({
      ...descriptor,
      executionStage: 'after-send',
      failurePolicy: 'block-reply',
    }).pipe(Effect.result)
    const invalidProjection = yield* Schema.decodeUnknownEffect(
      CanonicalMcpToolProjectionDescriptor,
    )({
      _tag: 'McpActionProjection',
      serverId: 'other',
      serverProtocolVersion: { major: 0, minor: 1 },
      name: 'create',
      tool: descriptor,
    }).pipe(Effect.result)

    expect(Result.isFailure(invalidPolicy)).toBe(true)
    expect(Result.isFailure(invalidProjection)).toBe(true)
  }),
)

it.effect('excludes callbacks and volatile MCP state from descriptor fingerprints', () =>
  Effect.gen(function* () {
    const firstProvider =
      yield* Schema.decodeUnknownEffect(ContextProvider)(contextProviderDefinition)
    const secondProvider = yield* Schema.decodeUnknownEffect(ContextProvider)({
      ...contextProviderDefinition,
      isAvailable: () => false,
      provide: () => Effect.die('different implementation'),
    })
    const firstAction = yield* Schema.decodeUnknownEffect(ActionTool)(actionDefinition)
    const secondAction = yield* Schema.decodeUnknownEffect(ActionTool)({
      ...actionDefinition,
      isAvailable: () => false,
      isInputAllowed: () => false,
      execute: () => Effect.die('different implementation'),
    })
    const firstFeedback = yield* Schema.decodeUnknownEffect(FeedbackTool)(feedbackDefinition)
    const secondFeedback = yield* Schema.decodeUnknownEffect(FeedbackTool)({
      ...feedbackDefinition,
      isAvailable: () => false,
      prepare: () => Effect.die('different implementation'),
    })
    const server = yield* Schema.decodeUnknownEffect(McpServer)({
      id: 'calendar',
      protocolVersion: { major: 0, minor: 1 },
    })
    const firstSnapshot = yield* Schema.decodeUnknownEffect(McpServerSnapshot)({
      _tag: 'Connected',
      serverId: 'calendar',
      revision: 1,
      projections: [{ _tag: 'Action', name: 'create', tool: firstAction }],
    })
    const secondSnapshot = yield* Schema.decodeUnknownEffect(McpServerSnapshot)({
      _tag: 'Connected',
      serverId: 'calendar',
      revision: 2,
      projections: [{ _tag: 'Action', name: 'create', tool: firstAction }],
    })
    if (firstSnapshot._tag !== 'Connected' || secondSnapshot._tag !== 'Connected') {
      return yield* Effect.die('Expected connected MCP fixtures')
    }
    const firstProjection = firstSnapshot.projections[0]
    const secondProjection = secondSnapshot.projections[0]
    if (firstProjection === undefined || secondProjection === undefined) {
      return yield* Effect.die('Expected one MCP projection per fixture')
    }

    expect(yield* fingerprint(canonicalContextProviderDescriptor(firstProvider))).toBe(
      yield* fingerprint(canonicalContextProviderDescriptor(secondProvider)),
    )
    expect(yield* fingerprint(canonicalActionToolDescriptor(firstAction))).toBe(
      yield* fingerprint(canonicalActionToolDescriptor(secondAction)),
    )
    expect(yield* fingerprint(canonicalFeedbackToolDescriptor(firstFeedback))).toBe(
      yield* fingerprint(canonicalFeedbackToolDescriptor(secondFeedback)),
    )
    expect(yield* fingerprint(canonicalMcpToolProjectionDescriptor(server, firstProjection))).toBe(
      yield* fingerprint(canonicalMcpToolProjectionDescriptor(server, secondProjection)),
    )
  }),
)

it.effect('hashes FeedbackTool outputSchema without charging it to model exposure', () =>
  Effect.gen(function* () {
    const first = yield* Schema.decodeUnknownEffect(FeedbackTool)(feedbackDefinition)
    const second = yield* Schema.decodeUnknownEffect(FeedbackTool)({
      ...feedbackDefinition,
      outputSchema: {
        _tag: 'Array',
        description: 'Longer host-only result validation description.',
        items: { _tag: 'String' },
        minItems: 0,
        maxItems: 8,
      },
    })
    const firstDescriptor = canonicalFeedbackToolDescriptor(first)
    const secondDescriptor = canonicalFeedbackToolDescriptor(second)

    expect(yield* fingerprint(firstDescriptor)).not.toBe(yield* fingerprint(secondDescriptor))
    expect(yield* Effect.fromResult(encodedCapabilityDescriptorBytesV1(firstDescriptor))).not.toBe(
      yield* Effect.fromResult(encodedCapabilityDescriptorBytesV1(secondDescriptor)),
    )
    expect(yield* Effect.fromResult(capabilityModelExposureBytesV1(firstDescriptor))).toBe(
      yield* Effect.fromResult(capabilityModelExposureBytesV1(secondDescriptor)),
    )
  }),
)

it.effect('separates a legal budget-hidden declaration from a protocol-invalid registration', () =>
  Effect.gen(function* () {
    const values = Array.from(
      { length: 16 },
      (_, index) => `value-${String(index).padStart(2, '0')}-${'x'.repeat(240)}`,
    )
    const largeProperties = Array.from({ length: 20 }, (_, index) => ({
      name: `field-${String(index)}`,
      required: true,
      schema: {
        _tag: 'StringEnum',
        description: `Allowed values for field ${String(index)}.`,
        values,
      },
    }))
    const largeTool = yield* Schema.decodeUnknownEffect(ActionTool)({
      ...actionDefinition,
      inputSchema: { _tag: 'Object', properties: largeProperties },
    })
    const descriptor = canonicalActionToolDescriptor(largeTool)
    const status = yield* Effect.fromResult(capabilityDeclarationByteStatusV1(descriptor, 65_536))

    expect(status._tag).toBe('TurnBudgetExceeded')
    expect(status.modelExposureBytes).toBeGreaterThan(65_536)
    expect(status.encodedDescriptorBytes).toBeLessThanOrEqual(status.protocolHardCapBytes)

    const invalid = yield* Schema.decodeUnknownEffect(ActionTool)({
      ...actionDefinition,
      inputSchema: {
        _tag: 'Object',
        properties: Array.from({ length: 101 }, (_, index) => ({
          name: `field-${String(index)}`,
          required: true,
          schema: { _tag: 'String' },
        })),
      },
    }).pipe(Effect.result)
    expect(Result.isFailure(invalid)).toBe(true)
  }),
)

it('publishes protocol-version-specific registration maxima above the turn soft cap', () => {
  const compactVersion = { major: 0, minor: 1 }
  const largestVersion = {
    major: Number.MAX_SAFE_INTEGER,
    minor: Number.MAX_SAFE_INTEGER,
  }

  expect(maxEncodedDeclarationBytes(compactVersion, 'action-tool')).toBeGreaterThan(65_536)
  expect(maxEncodedDeclarationBytes(compactVersion, 'feedback-tool')).toBeGreaterThan(65_536)
  expect(maxEncodedDeclarationBytes(compactVersion, 'mcp-projection')).toBeGreaterThan(65_536)
  expect(maxEncodedDeclarationBytes(largestVersion, 'action-tool')).toBeGreaterThan(
    maxEncodedDeclarationBytes(compactVersion, 'action-tool'),
  )
})

it.effect('publishes and enforces a descriptor protocol hard-cap boundary', () =>
  Effect.gen(function* () {
    const action = yield* Schema.decodeUnknownEffect(ActionTool)(actionDefinition)
    const descriptor = canonicalActionToolDescriptor(action)
    const hardCap = maxEncodedDeclarationBytes(action.protocolVersion, 'action-tool')
    Object.defineProperty(descriptor, 'description', {
      value: 'x'.repeat(hardCap + 1),
      enumerable: true,
    })

    const status = yield* Effect.fromResult(
      capabilityDeclarationByteStatusV1(descriptor, Number.MAX_SAFE_INTEGER),
    )
    expect(status._tag).toBe('ProtocolHardCapExceeded')
    expect(status.encodedDescriptorBytes).toBeGreaterThan(hardCap)
  }),
)
