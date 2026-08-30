import { expect, it } from '@effect/vitest'
import { Effect, Result, Schema } from 'effect'

import {
  CapabilityScope,
  FeedbackTool,
  FeedbackToolId,
  FeedbackToolRequest,
  MAX_FEEDBACK_TOOL_DESCRIPTION_LENGTH,
} from '../../src/index'

const TOOL_ID = FeedbackToolId.make('test.lookup')
const SCOPE = CapabilityScope.make({
  instanceId: 'instance',
  platform: 'test',
  guildId: 'guild',
  channelId: 'channel',
})

const definition = {
  id: TOOL_ID,
  protocolVersion: { major: 0, minor: 1 },
  description: 'Look up one bounded test value.',
  inputSchema: {
    _tag: 'Object',
    properties: [
      {
        name: 'query',
        required: true,
        schema: { _tag: 'String' },
      },
    ],
  },
  outputSchema: {
    _tag: 'Object',
    properties: [
      {
        name: 'answer',
        required: true,
        schema: { _tag: 'String' },
      },
    ],
  },
  maxResultTokens: 64,
  maxDurationMs: 250,
  isAvailable: (scope: CapabilityScope) => scope.channelId === SCOPE.channelId,
  prepare: (request: FeedbackToolRequest) =>
    Effect.succeed({
      execute: () => Effect.succeed({ answer: request.input.query }),
    }),
}

it.effect('decodes FeedbackTool duration, availability, output, and execution contracts', () =>
  Effect.gen(function* () {
    const tool = yield* Schema.decodeUnknownEffect(FeedbackTool)(definition)
    expect(tool.maxDurationMs).toBe(250)
    expect(tool.isAvailable(SCOPE)).toBe(true)
    expect(tool.outputSchema._tag).toBe('Object')

    const prepared = yield* tool.prepare(
      FeedbackToolRequest.make({ scope: SCOPE, input: { query: 'value' } }),
    )
    expect(yield* prepared.execute()).toEqual({ answer: 'value' })
  }),
)

it.effect('rejects invalid FeedbackTool execution bounds and function contracts', () =>
  Effect.gen(function* () {
    const candidates = [
      { ...definition, maxDurationMs: 0 },
      { ...definition, maxDurationMs: 1.5 },
      { ...definition, isAvailable: true },
      { ...definition, prepare: true },
      { ...definition, outputSchema: { _tag: 'Null' } },
      { ...definition, description: 'x'.repeat(MAX_FEEDBACK_TOOL_DESCRIPTION_LENGTH + 1) },
    ]
    const results = yield* Effect.forEach(candidates, (candidate) =>
      Schema.decodeUnknownEffect(FeedbackTool)(candidate).pipe(Effect.result),
    )

    expect(results.every(Result.isFailure)).toBe(true)
  }),
)
