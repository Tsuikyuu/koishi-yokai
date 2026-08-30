import {
  ActionTool,
  ActionToolExecutionError,
  ActionToolXmlTemplate,
  CapabilityDurationMilliseconds,
  CapabilityProtocolVersion,
  NOTEBOOK_WRITE_ACTION_TOOL_ID,
  type ActionToolInput,
  type PortableObjectSchema,
} from 'yokai-protocol'
import { Effect, Option, Schema } from 'effect'

import { ChannelScope } from '../message-archive/event'
import { Timestamp } from '../message-archive/event'
import {
  Confidence,
  DEFAULT_NOTE_CONFIDENCE,
  DEFAULT_NOTE_IMPORTANCE,
  Importance,
  MAX_NOTES_PER_REPLY,
  NoteContent,
  NoteId,
  NoteKind,
  NoteObjectId,
  NoteSources,
  NoteTopics,
  NotesPerReply,
  WriteProposal,
} from './model'
import { Notebook } from './notebook'

const VERSION = CapabilityProtocolVersion.make({ major: 0, minor: 1 })
const MAX_DURATION_MS = CapabilityDurationMilliseconds.make(1_000)

const WriteNoteInput = Schema.Struct({
  kind: NoteKind,
  'object-id': Schema.optionalKey(NoteObjectId),
  content: NoteContent,
  topics: Schema.optionalKey(NoteTopics),
  'source-message-ids': NoteSources,
  confidence: Schema.optionalKey(Confidence),
  importance: Schema.optionalKey(Importance),
  'expires-at': Schema.optionalKey(Timestamp),
  'corrects-note-id': Schema.optionalKey(NoteId),
})

interface WriteNoteInput extends Schema.Schema.Type<typeof WriteNoteInput> {}

const WriteInput = Schema.Struct({
  notes: Schema.Array(WriteNoteInput).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_NOTES_PER_REPLY),
  ),
})

interface WriteInput extends Schema.Schema.Type<typeof WriteInput> {}

const decodeInput = Schema.decodeUnknownEffect(WriteInput, { onExcessProperty: 'error' })
const isWriteInput = Schema.is(WriteInput)
const decodeScope = Schema.decodeUnknownEffect(ChannelScope)

const stringProperty = (name: string, description: string, required: boolean) => ({
  name,
  required,
  schema: { _tag: 'String', description } as const,
})

const inputSchema = (maximum: NotesPerReply): PortableObjectSchema => ({
  _tag: 'Object',
  description: 'Write only durable, future-useful notebook notes after a successful role reply.',
  properties: [
    {
      name: 'notes',
      required: true,
      schema: {
        _tag: 'Array',
        description: `One bounded batch of at most ${maximum} durable notes. Omit this ActionTool when there is nothing important to remember.`,
        minItems: 1,
        maxItems: maximum,
        items: {
          _tag: 'Object',
          properties: [
            {
              name: 'kind',
              required: true,
              schema: {
                _tag: 'StringEnum',
                values: ['episode', 'fact', 'relationship', 'self'],
                description:
                  'episode=event, fact=stated useful fact, relationship=address/topic/boundary, self=your own view/decision/promise.',
              },
            },
            stringProperty(
              'object-id',
              'Optional exact member or object ID that this note concerns.',
              false,
            ),
            stringProperty('content', 'Concise durable note content.', true),
            {
              name: 'topics',
              required: false,
              schema: {
                _tag: 'Array',
                description: 'Short retrieval topics.',
                minItems: 0,
                maxItems: 8,
                items: { _tag: 'String', description: 'One retrieval topic.' },
              },
            },
            {
              name: 'source-message-ids',
              required: true,
              schema: {
                _tag: 'Array',
                description:
                  'Existing message IDs in the current group that directly support this note.',
                minItems: 1,
                maxItems: 8,
                items: { _tag: 'String', description: 'One exact source message ID.' },
              },
            },
            {
              name: 'confidence',
              required: false,
              schema: {
                _tag: 'Number',
                minimum: 0,
                maximum: 1,
                description: 'Confidence from 0 to 1; omit to use the host default.',
              },
            },
            {
              name: 'importance',
              required: false,
              schema: {
                _tag: 'Number',
                minimum: 0,
                maximum: 1,
                description: 'Future usefulness from 0 to 1; omit to use the host default.',
              },
            },
            {
              name: 'expires-at',
              required: false,
              schema: {
                _tag: 'Integer',
                minimum: 0,
                description:
                  'Optional Unix timestamp in milliseconds when the note stops being recalled.',
              },
            },
            stringProperty(
              'corrects-note-id',
              'Optional recalled note ID that this note explicitly replaces.',
              false,
            ),
          ],
        },
      },
    },
  ],
})

const XML_TEMPLATE = ActionToolXmlTemplate.make(`<action tool="notebook.write">
  <notes>
    <item>
      <kind>episode | fact | relationship | self</kind>
      <object-id>EXACT MEMBER OR OBJECT ID</object-id>
      <content>CONCISE FUTURE-USEFUL NOTE</content>
      <topics><item>RETRIEVAL TOPIC</item></topics>
      <source-message-ids><item>EXACT SOURCE MESSAGE ID</item></source-message-ids>
      <confidence>0 TO 1</confidence>
      <importance>0 TO 1</importance>
      <expires-at>UNIX MILLISECONDS</expires-at>
      <corrects-note-id>RECALLED NOTE ID TO REPLACE</corrects-note-id>
    </item>
  </notes>
</action>`)

const optional = <A>(value: A | undefined): Option.Option<A> =>
  value === undefined ? Option.none<A>() : Option.some(value)

const proposal = (input: WriteNoteInput): WriteProposal =>
  WriteProposal.make({
    kind: input.kind,
    objectId: optional(input['object-id']),
    content: input.content,
    topics: input.topics === undefined ? [] : input.topics,
    sourceMessageIds: input['source-message-ids'],
    confidence:
      input.confidence === undefined ? Confidence.make(DEFAULT_NOTE_CONFIDENCE) : input.confidence,
    importance:
      input.importance === undefined ? Importance.make(DEFAULT_NOTE_IMPORTANCE) : input.importance,
    expiresAt: optional(input['expires-at']),
    correctsNoteId: optional(input['corrects-note-id']),
  })

const executionError = () =>
  new ActionToolExecutionError({
    toolId: NOTEBOOK_WRITE_ACTION_TOOL_ID,
    reason: 'execution-failed',
  })

export const make = (
  notebook: Notebook.Interface,
  instanceId: string,
  maximum: NotesPerReply,
): ActionTool =>
  ActionTool.make({
    id: NOTEBOOK_WRITE_ACTION_TOOL_ID,
    protocolVersion: VERSION,
    description:
      'Selectively remember durable episodes, explicit facts, relationship details, or your own views and promises. Most ordinary replies should omit this action. Every note needs direct source messages.',
    xmlTemplate: XML_TEMPLATE,
    inputSchema: inputSchema(maximum),
    executionStage: 'after-send',
    completionPolicy: 'none',
    failurePolicy: 'continue',
    maxDurationMs: MAX_DURATION_MS,
    isAvailable: (scope) => scope.instanceId === instanceId,
    isInputAllowed: (_scope, input) => isWriteInput(input) && input.notes.length <= maximum,
    execute: Effect.fn('NotebookWriteActionTool.execute')(function* (request) {
      const scope = yield* decodeScope(request.scope).pipe(Effect.mapError(executionError))
      const input = yield* decodeInput(request.input).pipe(Effect.mapError(executionError))
      if (input.notes.length > maximum) return yield* Effect.fail(executionError())
      yield* notebook.write(scope, input.notes.map(proposal)).pipe(Effect.mapError(executionError))
    }),
  })

export const noteCount = (input: ActionToolInput): number => {
  const notes = input.notes
  return notes !== undefined && Array.isArray(notes) ? notes.length : 0
}

export * as NotebookWriteActionTool from './action-tool'
