import { Effect, Schema } from 'effect'
import { ActionTool, type CapabilityScope } from 'yokai-protocol'

import { parseCompiled } from './parser'
import { validateTemplateInput } from './portable-input'
import {
  CompileError,
  MAX_ACTION_TEMPLATE_BYTES,
  MAX_SYSTEM_INSTRUCTION_BYTES,
  MAX_VISIBLE_ACTION_TOOLS,
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

export const compile = Effect.fn('RoleResponseEnvelope.compile')(function* (
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

  const frozenTools = [...visibleTools].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  )
  const systemInstruction = buildSystemInstruction(frozenTools)
  if (Buffer.byteLength(systemInstruction, 'utf8') > MAX_SYSTEM_INSTRUCTION_BYTES) {
    return yield* Effect.fail(compileError('prompt-too-large', 'registry'))
  }
  const protocol: CompiledProtocol = {
    systemInstruction,
    parse: (source: string, context: ParseContext) =>
      parseCompiled(
        source,
        { scope: frozenScope, replyToMessageIds: [...context.replyToMessageIds] },
        frozenTools,
      ),
  }
  return protocol
})

export const parse = Effect.fn('RoleResponseEnvelope.parse')(function* (
  source: string,
  context: TurnContext,
  actionTools: ReadonlyArray<ActionTool>,
) {
  const protocol = yield* compile(actionTools, context.scope)
  return yield* protocol.parse(source, { replyToMessageIds: context.replyToMessageIds })
})
