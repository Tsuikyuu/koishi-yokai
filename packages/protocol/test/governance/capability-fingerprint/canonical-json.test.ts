import { expect, it } from '@effect/vitest'
import { Result, Schema } from 'effect'

import {
  canonicalizeJson,
  canonicalizeJsonUtf8,
  canonicalJsonByteLength,
  canonicalJsonSha256Hex,
  type CanonicalJsonFailureReason,
} from '../../../src/governance/capability-fingerprint/canonical-json'

const expectFailure = <A>(
  result: Result.Result<A, { readonly reason: CanonicalJsonFailureReason }>,
  reason: CanonicalJsonFailureReason,
): void => {
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(result.failure.reason).toBe(reason)
}

it('matches the RFC 8785 canonical JSON and UTF-8 fixed vector', () => {
  const input: Schema.Json = {
    numbers: [Number('333333333.33333329'), 1e30, 4.5, 2e-3, 1e-27],
    string: `€$\u000f\nA'B"\\\\"/`,
    literals: [null, true, false],
  }
  const expected = String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`

  const canonical = canonicalizeJson(input)
  const utf8 = canonicalizeJsonUtf8(input)
  const byteLength = canonicalJsonByteLength(input)
  const fingerprint = canonicalJsonSha256Hex(input)

  expect(Result.getOrThrow(canonical)).toBe(expected)
  expect(Result.getOrThrow(utf8)).toEqual(new TextEncoder().encode(expected))
  expect(Result.getOrThrow(byteLength)).toBe(118)
  expect(Result.getOrThrow(fingerprint)).toBe(
    '2d5e01a318d0f0879ab568c4be289c8b1f64ef8921a53c6277d5e069978baacb',
  )
})

it('sorts object keys by unsigned UTF-16 code units', () => {
  const input: Schema.Json = {
    '\u20ac': 'Euro Sign',
    '\r': 'Carriage Return',
    '\ufb33': 'Hebrew Letter Dalet With Dagesh',
    '1': 'One',
    '\ud83d\ude00': 'Emoji: Grinning Face',
    '\u0080': 'Control',
    '\u00f6': 'Latin Small Letter O With Diaeresis',
  }

  expect(Result.getOrThrow(canonicalizeJson(input))).toBe(
    String.raw`{"\r":"Carriage Return","1":"One","":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}`,
  )
})

it('rejects every non-finite number', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    expectFailure(canonicalizeJson(value), 'non-finite-number')
  }
})

it('rejects negative zero according to verified RFC 8785 erratum 7920', () => {
  expectFailure(canonicalizeJson(-0), 'negative-zero')
})

it('rejects lone surrogates in values and object keys', () => {
  expectFailure(canonicalizeJson('\ud800'), 'lone-surrogate')
  expectFailure(canonicalizeJson({ ['\udc00']: true }), 'lone-surrogate')
})

it('rejects circular references without rejecting repeated sibling values', () => {
  const cyclic: Schema.JsonObject = {}
  Object.defineProperty(cyclic, 'self', { value: cyclic, enumerable: true })
  expectFailure(canonicalizeJson(cyclic), 'circular-reference')

  const shared: Schema.JsonObject = { value: 1 }
  expect(Result.getOrThrow(canonicalizeJson({ left: shared, right: shared }))).toBe(
    '{"left":{"value":1},"right":{"value":1}}',
  )
})

it('keeps reflective failures and excessive nesting in the typed failure channel', () => {
  const throwingGetter: Schema.JsonObject = {}
  Object.defineProperty(throwingGetter, 'value', {
    enumerable: true,
    get: () => {
      throw new Error('untrusted accessor')
    },
  })
  const throwingPrototype = new Proxy<Schema.JsonObject>(
    {},
    {
      getPrototypeOf: () => {
        throw new Error('untrusted proxy')
      },
    },
  )
  let deeplyNested: Schema.Json = null
  for (let depth = 0; depth < 20_000; depth += 1) deeplyNested = [deeplyNested]

  expectFailure(canonicalizeJson(throwingGetter), 'invalid-json-value')
  expectFailure(canonicalizeJson(throwingPrototype), 'invalid-json-value')
  expectFailure(canonicalizeJson(deeplyNested), 'invalid-json-value')
})
