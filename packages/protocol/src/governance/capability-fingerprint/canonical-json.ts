import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'
import { Result, Schema } from 'effect'

export const CanonicalJsonFailureReason = Schema.Literals([
  'non-finite-number',
  'negative-zero',
  'lone-surrogate',
  'circular-reference',
  'invalid-json-value',
])

export type CanonicalJsonFailureReason = typeof CanonicalJsonFailureReason.Type

export class CanonicalJsonError extends Schema.TaggedError<CanonicalJsonError>(
  '@yokai/protocol/CanonicalJsonError',
)('CanonicalJsonError', {
  reason: CanonicalJsonFailureReason,
}) {}

type CanonicalJsonResult<A> = Result.Result<A, CanonicalJsonError>
type CanonicalJsonRuntimeValue = null | boolean | number | string | object

interface RuntimeJsonArray extends ReadonlyArray<CanonicalJsonRuntimeValue | undefined> {}

interface RuntimeJsonObject {
  readonly [key: string]: CanonicalJsonRuntimeValue | undefined
}

const UTF8_ENCODER = new TextEncoder()

const failure = (reason: CanonicalJsonFailureReason): CanonicalJsonResult<never> =>
  Result.fail(new CanonicalJsonError({ reason }))

const hasLoneSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextIndex = index + 1
      if (nextIndex >= value.length) return true
      const nextCodeUnit = value.charCodeAt(nextIndex)
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) return true
      index = nextIndex
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true
    }
  }
  return false
}

const serializeString = (value: string): CanonicalJsonResult<string> => {
  if (hasLoneSurrogate(value)) return failure('lone-surrogate')
  const encoded = JSON.stringify(value)
  return encoded === undefined ? failure('invalid-json-value') : Result.succeed(encoded)
}

const serializeNumber = (value: number): CanonicalJsonResult<string> => {
  if (!Number.isFinite(value)) return failure('non-finite-number')
  if (Object.is(value, -0)) return failure('negative-zero')
  const encoded = JSON.stringify(value)
  return encoded === undefined ? failure('invalid-json-value') : Result.succeed(encoded)
}

const isJsonArray = (value: object): value is RuntimeJsonArray => Array.isArray(value)

const isJsonObject = (value: object): value is RuntimeJsonObject => {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const serializeJson = (
  value: CanonicalJsonRuntimeValue,
  ancestors: Set<object>,
): CanonicalJsonResult<string> => {
  if (value === null) return Result.succeed('null')

  switch (typeof value) {
    case 'boolean':
      return Result.succeed(value ? 'true' : 'false')
    case 'number':
      return serializeNumber(value)
    case 'string':
      return serializeString(value)
    case 'object': {
      if (ancestors.has(value)) return failure('circular-reference')
      ancestors.add(value)

      const parts: Array<string> = []
      if (isJsonArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          const item = value[index]
          if (item === undefined) {
            ancestors.delete(value)
            return failure('invalid-json-value')
          }
          const encoded = serializeJson(item, ancestors)
          if (Result.isFailure(encoded)) {
            ancestors.delete(value)
            return encoded
          }
          parts.push(encoded.success)
        }
        ancestors.delete(value)
        return Result.succeed(`[${parts.join(',')}]`)
      }

      if (!isJsonObject(value)) {
        ancestors.delete(value)
        return failure('invalid-json-value')
      }

      for (const key of Object.keys(value).sort()) {
        const item = value[key]
        if (item === undefined) {
          ancestors.delete(value)
          return failure('invalid-json-value')
        }
        const encodedKey = serializeString(key)
        if (Result.isFailure(encodedKey)) {
          ancestors.delete(value)
          return encodedKey
        }
        const encodedItem = serializeJson(item, ancestors)
        if (Result.isFailure(encodedItem)) {
          ancestors.delete(value)
          return encodedItem
        }
        parts.push(`${encodedKey.success}:${encodedItem.success}`)
      }
      ancestors.delete(value)
      return Result.succeed(`{${parts.join(',')}}`)
    }
    default:
      return failure('invalid-json-value')
  }
}

const canonicalizeJsonValue = (value: CanonicalJsonRuntimeValue): CanonicalJsonResult<string> =>
  Result.flatMap(
    Result.try({
      try: () => serializeJson(value, new Set()),
      catch: () => new CanonicalJsonError({ reason: 'invalid-json-value' }),
    }),
    (result) => result,
  )

const canonicalizeJsonValueUtf8 = (
  value: CanonicalJsonRuntimeValue,
): CanonicalJsonResult<Uint8Array> =>
  Result.map(canonicalizeJsonValue(value), (canonical) => UTF8_ENCODER.encode(canonical))

/** RFC 8785 serialization for an already decoded, bounded JSON value. */
export const canonicalizeJson = (value: Schema.Json): CanonicalJsonResult<string> =>
  canonicalizeJsonValue(value)

/** RFC 8785 requires the canonical JSON text to be encoded as UTF-8. */
export const canonicalizeJsonUtf8 = (value: Schema.Json): CanonicalJsonResult<Uint8Array> =>
  canonicalizeJsonValueUtf8(value)

export const canonicalJsonByteLength = (value: Schema.Json): CanonicalJsonResult<number> =>
  Result.map(canonicalizeJsonValueUtf8(value), (bytes) => bytes.byteLength)

export const sha256Hex = (bytes: Uint8Array): string => bytesToHex(sha256(bytes))

export const canonicalJsonSha256Hex = (value: Schema.Json): CanonicalJsonResult<string> =>
  Result.map(canonicalizeJsonValueUtf8(value), sha256Hex)
