import { expect, it } from '@effect/vitest'
import {
  ActionTool,
  ActionToolExecutionError,
  ActionToolId,
  ActionToolRequest,
  ActionToolXmlTemplate,
  CapabilityDurationMilliseconds,
  CapabilityProtocolVersion,
  CapabilityScope,
  ContextProviderRequest,
  NOTEBOOK_CONTEXT_PROVIDER_ID,
  NOTEBOOK_WRITE_ACTION_TOOL_ID,
  TokenLimit,
} from 'yokai-protocol'
import { Effect, Option, Ref } from 'effect'

import {
  Notebook,
  NotebookContextProvider,
  NotebookModel,
  NotebookTurnPolicy,
  NotebookWriteActionTool,
} from '../../src/index'
import {
  INSTANCE_ID,
  OTHER_INSTANCE_SCOPE,
  SCOPE,
  SOURCE_ONE,
  SOURCE_TWO,
  note,
  noteId,
  objectId,
  topic,
} from './fixtures'

const CAPABILITY_SCOPE = CapabilityScope.make(SCOPE)

const inertWrite = (): Effect.Effect<NotebookModel.WriteReport> =>
  Effect.succeed(NotebookModel.emptyWriteReport(0))

const inertEvidence: Notebook.Interface['findRecallableEvidence'] = () => Effect.succeed([])

const inertNotebook = (
  recall: Notebook.Interface['recall'],
  write: Notebook.Interface['write'] = inertWrite,
): Notebook.Interface => ({ write, recall, findRecallableEvidence: inertEvidence })

it.effect('renders bounded recalled notes with explicit certainty and source provenance', () =>
  Effect.gen(function* () {
    const captured = yield* Ref.make<Option.Option<NotebookModel.RecallRequest>>(Option.none())
    const certain = NotebookModel.RecalledNote.make({
      note: note({
        noteId: noteId(1),
        objectId: objectId('alice'),
        content: 'Alice prefers tea',
        topics: [topic('tea')],
        sourceMessageIds: [SOURCE_ONE],
        confidence: 0.9,
      }),
      uncertain: false,
    })
    const uncertain = NotebookModel.RecalledNote.make({
      note: note({
        noteId: noteId(2),
        objectId: objectId('alice'),
        content: 'Alice may travel this weekend',
        topics: [topic('travel')],
        sourceMessageIds: [SOURCE_ONE, SOURCE_TWO],
        confidence: 0.5,
      }),
      uncertain: true,
    })
    const notebook = inertNotebook((request) =>
      Ref.set(captured, Option.some(request)).pipe(
        Effect.andThen(Effect.succeed([certain, uncertain])),
      ),
    )
    const provider = NotebookContextProvider.make(notebook, INSTANCE_ID)
    const fragment = yield* provider.provide(
      ContextProviderRequest.make({
        scope: CAPABILITY_SCOPE,
        focus: {
          messageId: 'focus',
          authorId: 'alice',
          timestamp: 1,
          content: 'Tea travel tea',
        },
        tokenBudget: TokenLimit.make(512),
      }),
    )
    if (Option.isNone(fragment)) return yield* Effect.die('Expected notebook context')

    expect(provider.id).toBe(NOTEBOOK_CONTEXT_PROVIDER_ID)
    expect(provider.isAvailable(CAPABILITY_SCOPE)).toBe(true)
    expect(provider.isAvailable(CapabilityScope.make(OTHER_INSTANCE_SCOPE))).toBe(false)
    expect(fragment.value.untrusted).toBe(true)
    expect(fragment.value.sourceRefs).toEqual([SOURCE_ONE, SOURCE_TWO])
    expect(fragment.value.content).toContain('"certainty":"certain"')
    expect(fragment.value.content).toContain('"certainty":"uncertain"')
    expect(fragment.value.content).toContain(certain.note.noteId)
    expect(fragment.value.content).toContain(uncertain.note.noteId)
    expect(fragment.value.content).not.toContain('"confidence"')
    expect(fragment.value.estimatedTokens).toBeLessThanOrEqual(512)

    const request = yield* Ref.get(captured)
    if (Option.isNone(request)) return yield* Effect.die('Expected captured recall request')
    expect(request.value.scope).toEqual(SCOPE)
    expect(request.value.objectIds).toEqual([objectId('alice')])
    expect(request.value.topics).toEqual([topic('tea'), topic('travel')])
  }),
)

it.effect('returns no fragment for no recall and rejects an invalid provider budget', () =>
  Effect.gen(function* () {
    const provider = NotebookContextProvider.make(
      inertNotebook(() => Effect.succeed([])),
      INSTANCE_ID,
    )
    const request = (tokenBudget: number) =>
      ContextProviderRequest.make({
        scope: CAPABILITY_SCOPE,
        focus: {
          messageId: 'focus',
          authorId: 'alice',
          timestamp: 1,
          content: 'ordinary message',
        },
        tokenBudget: TokenLimit.make(tokenBudget),
      })

    expect(Option.isNone(yield* provider.provide(request(512)))).toBe(true)
    const failure = yield* provider.provide(request(32)).pipe(Effect.flip)
    expect(failure._tag).toBe('ContextProviderError')
    expect(failure.reason).toBe('budget-exceeded')
  }),
)

it.effect(
  'registers notebook.write as a bounded non-waking after-send action and maps defaults',
  () =>
    Effect.gen(function* () {
      const captured = yield* Ref.make<
        Option.Option<{
          readonly scope: Parameters<Notebook.Interface['write']>[0]
          readonly proposals: Parameters<Notebook.Interface['write']>[1]
        }>
      >(Option.none())
      const notebook = inertNotebook(
        () => Effect.succeed([]),
        (scope, proposals) =>
          Ref.set(captured, Option.some({ scope, proposals })).pipe(
            Effect.andThen(Effect.succeed(NotebookModel.emptyWriteReport(proposals.length))),
          ),
      )
      const tool = NotebookWriteActionTool.make(
        notebook,
        INSTANCE_ID,
        NotebookModel.NotesPerReply.make(2),
      )
      const validNoteInput = {
        kind: 'fact',
        content: 'Alice prefers tea',
        'source-message-ids': [SOURCE_ONE],
      }
      const validInput = {
        notes: [validNoteInput],
      }

      expect(tool.id).toBe(NOTEBOOK_WRITE_ACTION_TOOL_ID)
      expect(tool.executionStage).toBe('after-send')
      expect(tool.completionPolicy).toBe('none')
      expect(tool.failurePolicy).toBe('continue')
      expect(tool.isAvailable(CAPABILITY_SCOPE)).toBe(true)
      expect(tool.isAvailable(CapabilityScope.make(OTHER_INSTANCE_SCOPE))).toBe(false)
      expect(tool.isInputAllowed(CAPABILITY_SCOPE, validInput)).toBe(true)
      expect(tool.isInputAllowed(CAPABILITY_SCOPE, { notes: [] })).toBe(false)
      expect(
        tool.isInputAllowed(CAPABILITY_SCOPE, {
          notes: [validNoteInput, validNoteInput, validNoteInput],
        }),
      ).toBe(false)
      expect(NotebookWriteActionTool.noteCount(validInput)).toBe(1)
      const notesProperty = tool.inputSchema.properties.find(
        (property) => property.name === 'notes',
      )
      expect(notesProperty === undefined ? undefined : notesProperty.schema._tag).toBe('Array')
      if (notesProperty === undefined || notesProperty.schema._tag !== 'Array') {
        return yield* Effect.die('Expected notebook notes array schema')
      }
      expect(notesProperty.schema.minItems).toBe(1)
      expect(notesProperty.schema.maxItems).toBe(2)
      expect(tool.xmlTemplate).toContain('<action tool="notebook.write">')
      expect(tool.xmlTemplate).toContain('<source-message-ids>')

      yield* tool.execute(ActionToolRequest.make({ scope: CAPABILITY_SCOPE, input: validInput }))
      const observed = yield* Ref.get(captured)
      if (Option.isNone(observed)) return yield* Effect.die('Expected notebook write')
      expect(observed.value.scope).toEqual(SCOPE)
      expect(observed.value.proposals).toHaveLength(1)
      const written = observed.value.proposals[0]
      if (written === undefined) return yield* Effect.die('Expected one proposal')
      expect(written.kind).toBe('fact')
      expect(written.confidence).toBe(NotebookModel.DEFAULT_NOTE_CONFIDENCE)
      expect(written.importance).toBe(NotebookModel.DEFAULT_NOTE_IMPORTANCE)
      expect(written.topics).toEqual([])
      expect(written.sourceMessageIds).toEqual([SOURCE_ONE])
      expect(Option.isNone(written.objectId)).toBe(true)
      expect(Option.isNone(written.expiresAt)).toBe(true)
      expect(Option.isNone(written.correctsNoteId)).toBe(true)
    }),
)

it.effect('maps malformed input and notebook failures to the stable ActionTool error', () =>
  Effect.gen(function* () {
    const failingNotebook = inertNotebook(
      () => Effect.succeed([]),
      () => Effect.fail(new Notebook.ProposalLimitExceededError({ proposed: 3, maximum: 2 })),
    )
    const tool = NotebookWriteActionTool.make(
      failingNotebook,
      INSTANCE_ID,
      NotebookModel.NotesPerReply.make(2),
    )
    const malformed = yield* tool
      .execute(
        ActionToolRequest.make({
          scope: CAPABILITY_SCOPE,
          input: { notes: [{ kind: 'fact', content: 'missing sources' }] },
        }),
      )
      .pipe(Effect.flip)
    expect(malformed).toEqual(
      new ActionToolExecutionError({
        toolId: NOTEBOOK_WRITE_ACTION_TOOL_ID,
        reason: 'execution-failed',
      }),
    )

    const failed = yield* tool
      .execute(
        ActionToolRequest.make({
          scope: CAPABILITY_SCOPE,
          input: {
            notes: [
              {
                kind: 'fact',
                content: 'bounded note',
                'source-message-ids': [SOURCE_ONE],
              },
            ],
          },
        }),
      )
      .pipe(Effect.flip)
    expect(failed._tag).toBe('ActionToolExecutionError')
    expect(failed.toolId).toBe(NOTEBOOK_WRITE_ACTION_TOOL_ID)
    expect(failed.reason).toBe('execution-failed')
  }),
)

const ordinaryAfterSendTool = ActionTool.make({
  id: ActionToolId.make('test.after'),
  protocolVersion: CapabilityProtocolVersion.make({ major: 0, minor: 1 }),
  description: 'Observe an ordinary after-send action.',
  xmlTemplate: ActionToolXmlTemplate.make('<action tool="test.after"></action>'),
  inputSchema: { _tag: 'Object', properties: [] },
  executionStage: 'after-send',
  completionPolicy: 'none',
  failurePolicy: 'continue',
  maxDurationMs: CapabilityDurationMilliseconds.make(100),
  isAvailable: () => true,
  isInputAllowed: () => true,
  execute: () => Effect.void,
})

it.effect('aggregates the notebook proposal limit and filters only notebook on silence', () =>
  Effect.gen(function* () {
    const notebook = inertNotebook(() => Effect.succeed([]))
    const tool = NotebookWriteActionTool.make(
      notebook,
      INSTANCE_ID,
      NotebookModel.NotesPerReply.make(2),
    )
    const one = {
      tool,
      input: {
        notes: [
          {
            kind: 'fact',
            content: 'one',
            'source-message-ids': [SOURCE_ONE],
          },
        ],
      },
    }
    const second = {
      tool,
      input: {
        notes: [
          {
            kind: 'self',
            content: 'two',
            'source-message-ids': [SOURCE_TWO],
          },
        ],
      },
    }
    const ordinary = { tool: ordinaryAfterSendTool, input: {} }

    yield* NotebookTurnPolicy.validate([one, second, ordinary])
    const overflow = yield* NotebookTurnPolicy.validate([one, second, one]).pipe(Effect.flip)
    expect(overflow._tag).toBe('NotebookTurnProposalLimitExceededError')
    expect(NotebookTurnPolicy.afterSuccessfulSend([one, ordinary], 0)).toEqual([ordinary])
    expect(NotebookTurnPolicy.afterSuccessfulSend([one, ordinary], 1)).toEqual([one, ordinary])
  }),
)
