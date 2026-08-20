import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'

import { ToolResultBatch } from '../../src/llm-adapter/feedback-tool'

it.effect('round-trips ordered success and safe failure results by call ID', () =>
  Effect.gen(function* () {
    const encoded = [
      {
        _tag: 'Success',
        callId: 'call-2',
        output: { title: 'Result', score: 1 },
      },
      {
        _tag: 'Failure',
        callId: 'call-1',
        reason: 'timeout',
        message: 'The bounded lookup timed out',
      },
    ]

    const batch = yield* Schema.decodeUnknownEffect(ToolResultBatch)(encoded)
    expect(yield* Schema.encodeEffect(ToolResultBatch)(batch)).toEqual(encoded)
  }),
)

it.effect('preserves every JSON shape in successful tool results', () =>
  Effect.gen(function* () {
    const encoded = [
      { _tag: 'Success', callId: 'null', output: null },
      { _tag: 'Success', callId: 'scalar', output: 42 },
      { _tag: 'Success', callId: 'array', output: ['one', 2, false] },
      { _tag: 'Success', callId: 'object', output: { nested: { ok: true } } },
    ]

    const batch = yield* Schema.decodeUnknownEffect(ToolResultBatch)(encoded)
    expect(yield* Schema.encodeEffect(ToolResultBatch)(batch)).toEqual(encoded)
  }),
)

it.effect('rejects empty, duplicate, and unknown tool result variants', () =>
  Effect.gen(function* () {
    const success = { _tag: 'Success', callId: 'call-1', output: true }
    const errors = yield* Effect.all(
      [[], [success, success], [{ _tag: 'Unknown', callId: 'call-1' }]].map((input) =>
        Schema.decodeUnknownEffect(ToolResultBatch)(input).pipe(Effect.flip),
      ),
    )

    expect(errors.every(Schema.isSchemaError)).toBe(true)
  }),
)
