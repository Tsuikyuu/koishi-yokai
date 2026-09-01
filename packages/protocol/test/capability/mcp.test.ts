import { expect, it } from '@effect/vitest'
import { Effect, Result, Schema } from 'effect'

import {
  MAX_MCP_TOOL_PROJECTIONS,
  McpServerSnapshot,
  type McpServerSnapshot as McpServerSnapshotType,
} from '../../src/index'

const actionTool = (id: string) => ({
  id,
  protocolVersion: { major: 0, minor: 1 },
  description: 'Create one calendar entry.',
  xmlTemplate: `<action tool="${id}"><title>XML_ESCAPED_TITLE</title></action>`,
  inputSchema: {
    _tag: 'Object',
    properties: [
      {
        name: 'title',
        required: true,
        schema: { _tag: 'String' },
      },
    ],
  },
  executionStage: 'after-send',
  completionPolicy: 'none',
  failurePolicy: 'continue',
  maxDurationMs: 250,
  isAvailable: () => true,
  isInputAllowed: () => true,
  execute: () => Effect.void,
})

const feedbackTool = (id: string) => ({
  id,
  protocolVersion: { major: 0, minor: 1 },
  description: 'Read one calendar entry.',
  inputSchema: { _tag: 'Object', properties: [] },
  outputSchema: { _tag: 'String' },
  maxResultTokens: 64,
  maxDurationMs: 250,
  isAvailable: () => true,
  prepare: () => Effect.succeed({ execute: () => Effect.succeed('entry') }),
})

const connected = {
  _tag: 'Connected',
  serverId: 'calendar',
  revision: 1,
  projections: [
    { _tag: 'Action', name: 'create', tool: actionTool('calendar.create') },
    { _tag: 'Feedback', name: 'lookup', tool: feedbackTool('calendar.lookup') },
  ],
}

it.effect(
  'decodes one atomic connected snapshot with explicit Action and Feedback projections',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* Schema.decodeUnknownEffect(McpServerSnapshot)(connected)
      if (snapshot._tag !== 'Connected') return yield* Effect.die('Expected a connected snapshot')

      expect(snapshot.serverId).toBe('calendar')
      expect(snapshot.revision).toBe(1)
      expect(snapshot.projections.map((projection) => projection._tag)).toEqual([
        'Action',
        'Feedback',
      ])
      expect(snapshot.projections.map((projection) => projection.tool.id)).toEqual([
        'calendar.create',
        'calendar.lookup',
      ])
    }),
)

it.effect('decodes a disconnected snapshot without retaining projected capabilities', () =>
  Effect.gen(function* () {
    const snapshot: McpServerSnapshotType = yield* Schema.decodeUnknownEffect(McpServerSnapshot)({
      _tag: 'Disconnected',
      serverId: 'calendar',
      revision: 2,
    })

    expect(snapshot).toEqual({ _tag: 'Disconnected', serverId: 'calendar', revision: 2 })
  }),
)

it.effect('rejects wrong namespaces and duplicate cross-kind projection names', () =>
  Effect.gen(function* () {
    const candidates = [
      {
        ...connected,
        projections: [{ _tag: 'Action', name: 'create', tool: actionTool('other.create') }],
      },
      {
        ...connected,
        projections: [
          { _tag: 'Action', name: 'shared', tool: actionTool('calendar.shared') },
          { _tag: 'Feedback', name: 'shared', tool: feedbackTool('calendar.shared') },
        ],
      },
    ]
    const results = yield* Effect.forEach(candidates, (candidate) =>
      Schema.decodeUnknownEffect(McpServerSnapshot)(candidate).pipe(Effect.result),
    )

    expect(results.every(Result.isFailure)).toBe(true)
  }),
)

it.effect('bounds MCP projection names, revisions, and complete snapshot size', () =>
  Effect.gen(function* () {
    const candidates = [
      { ...connected, revision: -1 },
      {
        ...connected,
        projections: [{ _tag: 'Action', name: 'bad name', tool: actionTool('calendar.bad-name') }],
      },
      {
        ...connected,
        projections: Array.from({ length: MAX_MCP_TOOL_PROJECTIONS + 1 }, (_, index) => {
          const name = `tool-${String(index)}`
          return { _tag: 'Action', name, tool: actionTool(`calendar.${name}`) }
        }),
      },
    ]
    const results = yield* Effect.forEach(candidates, (candidate) =>
      Schema.decodeUnknownEffect(McpServerSnapshot)(candidate).pipe(Effect.result),
    )

    expect(results.every(Result.isFailure)).toBe(true)
  }),
)
