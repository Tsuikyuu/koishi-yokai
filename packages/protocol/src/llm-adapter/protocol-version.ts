import { Schema } from 'effect'

export const AdapterProtocolVersion = Schema.Struct({
  major: Schema.Natural,
  minor: Schema.Natural,
})

export interface AdapterProtocolVersion extends Schema.Schema.Type<typeof AdapterProtocolVersion> {}

/**
 * YK-002 starts as an experimental protocol. The first production adapter can
 * validate the shape before it is promoted to major version 1.
 */
export const CURRENT_ADAPTER_PROTOCOL_VERSION = AdapterProtocolVersion.make({
  major: 0,
  minor: 1,
})

/**
 * Minor releases may only add optional, ignorable information. A major change
 * is required for new variants, required fields, or lifecycle changes.
 */
export const isAdapterProtocolVersionCompatible = (
  supported: AdapterProtocolVersion,
  candidate: AdapterProtocolVersion,
): boolean => supported.major === candidate.major
