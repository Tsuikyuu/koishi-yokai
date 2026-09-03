import { expect, it } from '@effect/vitest'
import { Effect, Result, Schema } from 'effect'

import {
  BUILD_ATTESTATION_VERSION,
  CAPABILITY_DESCRIPTOR_IDENTITY_FIXTURE,
  CAPABILITY_DESCRIPTOR_IDENTITY_VERSION,
  CAPABILITY_FINGERPRINT_VERSION,
  CAPABILITY_SOURCE_EVIDENCE_FIXTURE,
  CAPABILITY_SOURCE_EVIDENCE_VERSION,
  MAX_CAPABILITY_SOURCE_ID_LENGTH,
  BuildAttestationV1,
  CapabilityDescriptorIdentityV1,
  CapabilitySourceEvidence,
} from '../../../src/governance/capability-fingerprint/source-evidence'

const encodedFixture: typeof CapabilitySourceEvidence.Encoded = {
  version: CAPABILITY_SOURCE_EVIDENCE_VERSION,
  sourceId: 'builtin:yokai/history.context',
  buildAttestation: {
    _tag: 'Complete',
    version: BUILD_ATTESTATION_VERSION,
    algorithm: 'sha-256',
    fingerprint: '795b1d4cd5e7f9b585271414be5b9935eb6fd25865f071a59d78bc46bf520e93',
  },
}

const encodedDescriptorFixture: typeof CapabilityDescriptorIdentityV1.Encoded = {
  version: CAPABILITY_DESCRIPTOR_IDENTITY_VERSION,
  fingerprintVersion: CAPABILITY_FINGERPRINT_VERSION,
  descriptorHash: '8601fd6267c69b37c33cfa3a007e68349dfea0c562a8fd345c5105ffc4d8a4f7',
  encodedDescriptorBytes: 256,
  modelExposureBytes: 0,
}

it.effect('round-trips the fixed complete source evidence fixture', () =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(CapabilitySourceEvidence)(encodedFixture)
    const encoded = yield* Schema.encodeEffect(CapabilitySourceEvidence)(decoded)

    expect(decoded).toEqual(CAPABILITY_SOURCE_EVIDENCE_FIXTURE)
    expect(encoded).toEqual(encodedFixture)
  }),
)

it.effect('round-trips the fixed descriptor identity fixture', () =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(CapabilityDescriptorIdentityV1)(
      encodedDescriptorFixture,
    )
    const encoded = yield* Schema.encodeEffect(CapabilityDescriptorIdentityV1)(decoded)

    expect(decoded).toEqual(CAPABILITY_DESCRIPTOR_IDENTITY_FIXTURE)
    expect(encoded).toEqual(encodedDescriptorFixture)
  }),
)

it.effect('round-trips registration-scoped build evidence', () =>
  Effect.gen(function* () {
    const encoded: typeof BuildAttestationV1.Encoded = {
      ...encodedFixture.buildAttestation,
      _tag: 'RegistrationScoped',
    }
    const decoded = yield* Schema.decodeUnknownEffect(BuildAttestationV1)(encoded)

    expect(yield* Schema.encodeEffect(BuildAttestationV1)(decoded)).toEqual(encoded)
  }),
)

it.effect('rejects empty, untrimmed, controlled, and oversized source IDs', () =>
  Effect.gen(function* () {
    const sourceIds = [
      '',
      ' source',
      'source ',
      'source\u0000id',
      'x'.repeat(MAX_CAPABILITY_SOURCE_ID_LENGTH + 1),
    ]
    const results = yield* Effect.forEach(sourceIds, (sourceId) =>
      Schema.decodeUnknownEffect(CapabilitySourceEvidence)({
        ...encodedFixture,
        sourceId,
      }).pipe(Effect.result),
    )

    expect(results.every(Result.isFailure)).toBe(true)
  }),
)

it.effect('rejects malformed SHA-256 build and descriptor digests', () =>
  Effect.gen(function* () {
    const malformed = ['0'.repeat(63), '0'.repeat(65), 'G'.repeat(64), 'A'.repeat(64)]
    const buildResults = yield* Effect.forEach(malformed, (fingerprint) =>
      Schema.decodeUnknownEffect(CapabilitySourceEvidence)({
        ...encodedFixture,
        buildAttestation: { ...encodedFixture.buildAttestation, fingerprint },
      }).pipe(Effect.result),
    )
    const descriptorResults = yield* Effect.forEach(malformed, (descriptorHash) =>
      Schema.decodeUnknownEffect(CapabilityDescriptorIdentityV1)({
        ...encodedDescriptorFixture,
        descriptorHash,
      }).pipe(Effect.result),
    )

    expect(buildResults.every(Result.isFailure)).toBe(true)
    expect(descriptorResults.every(Result.isFailure)).toBe(true)
  }),
)

it.effect(
  'rejects unsupported evidence, attestation, descriptor, fingerprint, tag, and algorithm versions',
  () =>
    Effect.gen(function* () {
      const sourceCandidates = [
        { ...encodedFixture, version: 2 },
        {
          ...encodedFixture,
          buildAttestation: { ...encodedFixture.buildAttestation, version: 2 },
        },
        {
          ...encodedFixture,
          buildAttestation: { ...encodedFixture.buildAttestation, _tag: 'RootOnly' },
        },
        {
          ...encodedFixture,
          buildAttestation: { ...encodedFixture.buildAttestation, algorithm: 'sha-512' },
        },
      ]
      const sourceResults = yield* Effect.forEach(sourceCandidates, (candidate) =>
        Schema.decodeUnknownEffect(CapabilitySourceEvidence)(candidate).pipe(Effect.result),
      )
      const descriptorCandidates = [
        { ...encodedDescriptorFixture, version: 2 },
        { ...encodedDescriptorFixture, fingerprintVersion: 2 },
      ]
      const descriptorResults = yield* Effect.forEach(descriptorCandidates, (candidate) =>
        Schema.decodeUnknownEffect(CapabilityDescriptorIdentityV1)(candidate).pipe(Effect.result),
      )

      expect(sourceResults.every(Result.isFailure)).toBe(true)
      expect(descriptorResults.every(Result.isFailure)).toBe(true)
    }),
)

it.effect('accepts safe non-negative byte counts and rejects invalid counts', () =>
  Effect.gen(function* () {
    const boundaries = [
      { ...encodedDescriptorFixture, encodedDescriptorBytes: 0, modelExposureBytes: 0 },
      {
        ...encodedDescriptorFixture,
        encodedDescriptorBytes: Number.MAX_SAFE_INTEGER,
        modelExposureBytes: Number.MAX_SAFE_INTEGER,
      },
    ]
    yield* Effect.forEach(boundaries, (candidate) =>
      Schema.decodeUnknownEffect(CapabilityDescriptorIdentityV1)(candidate),
    )

    const invalid = [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]
    const candidates = invalid.flatMap((bytes) => [
      { ...encodedDescriptorFixture, encodedDescriptorBytes: bytes },
      { ...encodedDescriptorFixture, modelExposureBytes: bytes },
    ])
    const results = yield* Effect.forEach(candidates, (candidate) =>
      Schema.decodeUnknownEffect(CapabilityDescriptorIdentityV1)(candidate).pipe(Effect.result),
    )

    expect(results.every(Result.isFailure)).toBe(true)
  }),
)
