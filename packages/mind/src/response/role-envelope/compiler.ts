import { Effect, Schema } from 'effect'
import { ActionTool, type CapabilityScope } from 'yokai-protocol'

import { parseCompiled } from './parser'
import { validateTemplateInput } from './portable-input'
import {
  CompileError,
  MAX_ACTION_TEMPLATE_BYTES,
  MAX_SYSTEM_INSTRUCTION_BYTES,
  MAX_VISIBLE_ACTION_TOOLS,
  PROTOCOL_ID,
  type CompiledProtocol,
  type ParseContext,
  type TurnContext,
} from './schema'
import { buildSystemInstruction } from './prompt'
import { attributeValue, hasOnlyAttributes, readDocument } from './xml'

const compileError = (reason: CompileError['reason'], toolId: string): CompileError =>
  new CompileError({ reason, toolId })

const validateToolTemplate = Effect.fn('RoleResponseEnvelope.validateToolTemplate')(function* (
  tool: ActionTool,
) {
  const root = yield* readDocument(tool.xmlTemplate).pipe(
    Effect.mapError(() => compileError('invalid-template', tool.id)),
  )
  if (
    root.name !== 'action' ||
    root.attributes.length !== 1 ||
    !hasOnlyAttributes(root, ['tool'])
  ) {
    return yield* Effect.fail(compileError('invalid-template', tool.id))
  }

  const templateToolId = attributeValue(root, 'tool')
  if (templateToolId !== tool.id) {
    return yield* Effect.fail(compileError('template-tool-mismatch', tool.id))
  }

  yield* validateTemplateInput(root, tool.inputSchema).pipe(
    Effect.mapError(() => compileError('template-schema-mismatch', tool.id)),
  )
})

const findDuplicateTool = (tools: ReadonlyArray<ActionTool>): ActionTool | undefined => {
  const ids = new Set<string>()
  for (const tool of tools) {
    if (ids.has(tool.id)) return tool
    ids.add(tool.id)
  }
  return undefined
}

export const validateActionToolRegistration = Effect.fn(
  'RoleResponseEnvelope.validateActionToolRegistration',
)(function* (candidate: ActionTool) {
  const tool = yield* Schema.decodeUnknownEffect(ActionTool)(candidate).pipe(
    Effect.mapError(() => compileError('invalid-tool', 'registry')),
  )
  yield* validateToolTemplate(tool)
  return tool
})

const visibleTool = Effect.fn('RoleResponseEnvelope.visibleTool')(function* (
  tool: ActionTool,
  scope: CapabilityScope,
) {
  const available = yield* Effect.try({
    try: () => tool.isAvailable(scope),
    catch: () => compileError('availability-check-failed', tool.id),
  })
  return { tool, available }
})

interface VisibleToolSelection {
  readonly scope: CapabilityScope
  readonly tools: ReadonlyArray<ActionTool>
}

const resolveVisibleTools = Effect.fn('RoleResponseEnvelope.resolveVisibleTools')(function* (
  actionTools: ReadonlyArray<ActionTool>,
  scope: CapabilityScope,
) {
  const frozenScope: CapabilityScope = { ...scope }
  const decodedTools = yield* Effect.forEach(actionTools, validateActionToolRegistration)

  const duplicate = findDuplicateTool(decodedTools)
  if (duplicate !== undefined) {
    return yield* Effect.fail(compileError('duplicate-tool', duplicate.id))
  }

  const visibility = yield* Effect.forEach(decodedTools, (tool) => visibleTool(tool, frozenScope))
  const visibleTools = visibility
    .filter((entry) => entry.available === true)
    .map((entry) => entry.tool)
  return { scope: frozenScope, tools: visibleTools } satisfies VisibleToolSelection
})

const sortedTools = (tools: ReadonlyArray<ActionTool>): ReadonlyArray<ActionTool> =>
  [...tools].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))

const compileVisibleTools = Effect.fn('RoleResponseEnvelope.compileVisibleTools')(function* (
  visibleTools: ReadonlyArray<ActionTool>,
  frozenScope: CapabilityScope,
  systemInstructionByteLimit: number,
) {
  if (visibleTools.length > MAX_VISIBLE_ACTION_TOOLS) {
    return yield* Effect.fail(compileError('too-many-tools', 'registry'))
  }

  const templateBytes = visibleTools.reduce(
    (total, tool) => total + Buffer.byteLength(tool.xmlTemplate, 'utf8'),
    0,
  )
  if (templateBytes > MAX_ACTION_TEMPLATE_BYTES) {
    return yield* Effect.fail(compileError('templates-too-large', 'registry'))
  }

  const frozenTools = sortedTools(visibleTools)
  const systemInstruction = buildSystemInstruction(frozenTools)
  if (Buffer.byteLength(systemInstruction, 'utf8') > systemInstructionByteLimit) {
    return yield* Effect.fail(compileError('prompt-too-large', 'registry'))
  }
  const protocol: CompiledProtocol = {
    protocolId: PROTOCOL_ID,
    systemInstruction,
    parse: (source: string, context: ParseContext) =>
      parseCompiled(
        source,
        { scope: frozenScope, quotableMessageIds: [...context.quotableMessageIds] },
        frozenTools,
      ),
  }
  return protocol
})

interface BoundedToolSelection {
  readonly tools: ReadonlyArray<ActionTool>
  readonly templateBytes: number
}

const selectBoundedVisibleTools = (
  visibleTools: ReadonlyArray<ActionTool>,
  systemInstructionByteLimit: number,
): ReadonlyArray<ActionTool> =>
  visibleTools.reduce<BoundedToolSelection>(
    (selected, tool) => {
      if (selected.tools.length >= MAX_VISIBLE_ACTION_TOOLS) return selected

      const templateBytes = selected.templateBytes + Buffer.byteLength(tool.xmlTemplate, 'utf8')
      if (templateBytes > MAX_ACTION_TEMPLATE_BYTES) return selected

      const tools = [...selected.tools, tool]
      const systemInstruction = buildSystemInstruction(sortedTools(tools))
      return Buffer.byteLength(systemInstruction, 'utf8') <= systemInstructionByteLimit
        ? { tools, templateBytes }
        : selected
    },
    { tools: [], templateBytes: 0 },
  ).tools

export const compile = Effect.fn('RoleResponseEnvelope.compile')(function* (
  actionTools: ReadonlyArray<ActionTool>,
  scope: CapabilityScope,
) {
  const visible = yield* resolveVisibleTools(actionTools, scope)
  return yield* compileVisibleTools(visible.tools, visible.scope, MAX_SYSTEM_INSTRUCTION_BYTES)
})

/** Select a deterministic legal subset after evaluating each tool's visibility exactly once. */
export const compileBounded = Effect.fn('RoleResponseEnvelope.compileBounded')(function* (
  actionTools: ReadonlyArray<ActionTool>,
  scope: CapabilityScope,
  systemInstructionByteLimit = MAX_SYSTEM_INSTRUCTION_BYTES,
) {
  const boundedByteLimit =
    Number.isSafeInteger(systemInstructionByteLimit) && systemInstructionByteLimit >= 0
      ? Math.min(systemInstructionByteLimit, MAX_SYSTEM_INSTRUCTION_BYTES)
      : 0
  if (Buffer.byteLength(buildSystemInstruction([]), 'utf8') > boundedByteLimit) {
    return yield* Effect.fail(compileError('prompt-too-large', 'registry'))
  }
  const visible = yield* resolveVisibleTools(actionTools, scope)
  return yield* compileVisibleTools(
    selectBoundedVisibleTools(visible.tools, boundedByteLimit),
    visible.scope,
    boundedByteLimit,
  )
})

export const parse = Effect.fn('RoleResponseEnvelope.parse')(function* (
  source: string,
  context: TurnContext,
  actionTools: ReadonlyArray<ActionTool>,
) {
  const protocol = yield* compile(actionTools, context.scope)
  return yield* protocol.parse(source, { quotableMessageIds: context.quotableMessageIds })
})
