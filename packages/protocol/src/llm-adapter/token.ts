import { Schema } from 'effect'

/** A provider-reported token count. Unknown counts are represented by absence. */
export const TokenCount = Schema.Natural.pipe(Schema.brand('@yokai/protocol/TokenCount'))

export type TokenCount = typeof TokenCount.Type

/** A configured or discovered token limit must be greater than zero. */
export const TokenLimit = Schema.Natural.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand('@yokai/protocol/TokenLimit'),
)

export type TokenLimit = typeof TokenLimit.Type
