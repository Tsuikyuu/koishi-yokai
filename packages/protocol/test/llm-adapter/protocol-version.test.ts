import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'

import {
  AdapterProtocolVersion,
  CURRENT_ADAPTER_PROTOCOL_VERSION,
  isAdapterProtocolVersionCompatible,
} from '../../src/llm-adapter/protocol-version.js'

it.effect('accepts every minor version with the supported major', () =>
  Effect.sync(() => {
    expect(
      isAdapterProtocolVersionCompatible(
        CURRENT_ADAPTER_PROTOCOL_VERSION,
        AdapterProtocolVersion.make({ major: 0, minor: 99 }),
      ),
    ).toBe(true)
    expect(
      isAdapterProtocolVersionCompatible(
        CURRENT_ADAPTER_PROTOCOL_VERSION,
        AdapterProtocolVersion.make({ major: 1, minor: 0 }),
      ),
    ).toBe(false)
  }),
)

it.effect('rejects invalid major and minor numbers', () =>
  Effect.gen(function* () {
    const errors = yield* Effect.all(
      [
        { major: -1, minor: 0 },
        { major: 0.5, minor: 0 },
        { major: 0, minor: Number.MAX_SAFE_INTEGER + 1 },
      ].map((input) => Schema.decodeUnknownEffect(AdapterProtocolVersion)(input).pipe(Effect.flip)),
    )

    expect(errors.every(Schema.isSchemaError)).toBe(true)
  }),
)
