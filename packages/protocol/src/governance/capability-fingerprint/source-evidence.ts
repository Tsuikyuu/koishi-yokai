import { Schema } from 'effect'

export const CAPABILITY_SOURCE_EVIDENCE_VERSION = 1
export const BUILD_ATTESTATION_VERSION = 1
export const CAPABILITY_DESCRIPTOR_IDENTITY_VERSION = 1
export const CAPABILITY_FINGERPRINT_VERSION = 1
export const MAX_CAPABILITY_SOURCE_ID_LENGTH = 512

export const CapabilitySourceId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_CAPABILITY_SOURCE_ID_LENGTH),
  Schema.isPattern(/^[^\p{C}]+$/u),
).pipe(Schema.brand('@yokai/protocol/CapabilitySourceId'))

export type CapabilitySourceId = typeof CapabilitySourceId.Type

export const Sha256Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(
  Schema.brand('@yokai/protocol/Sha256Digest'),
)

export type Sha256Digest = typeof Sha256Digest.Type

export const CapabilityFingerprintVersion = Schema.Literal(CAPABILITY_FINGERPRINT_VERSION)

export type CapabilityFingerprintVersion = typeof CapabilityFingerprintVersion.Type

const buildAttestationFields = {
  version: Schema.Literal(BUILD_ATTESTATION_VERSION),
  algorithm: Schema.Literal('sha-256'),
  fingerprint: Sha256Digest,
}

/**
 * `Complete` is the Merkle fingerprint of the root bundle and the complete
 * loader-resolved runtime dependency closure. `RegistrationScoped` is used when that closure
 * cannot be proven; its producer must include unique per-registration material
 * so a previous approval can never be reused after registration.
 */
export const BuildAttestationV1 = Schema.TaggedUnion({
  Complete: buildAttestationFields,
  RegistrationScoped: buildAttestationFields,
})

export type BuildAttestationV1 = typeof BuildAttestationV1.Type

export const CapabilitySourceEvidence = Schema.Struct({
  version: Schema.Literal(CAPABILITY_SOURCE_EVIDENCE_VERSION),
  sourceId: CapabilitySourceId,
  buildAttestation: BuildAttestationV1,
})

export interface CapabilitySourceEvidence extends Schema.Schema.Type<
  typeof CapabilitySourceEvidence
> {}

/**
 * `modelExposureBytes` measures only a static ActionTool or FeedbackTool
 * declaration. Capability kinds without a Tool declaration use zero and keep
 * their independent token or rendered-instruction budgets.
 */
export const CapabilityDescriptorIdentityV1 = Schema.Struct({
  version: Schema.Literal(CAPABILITY_DESCRIPTOR_IDENTITY_VERSION),
  fingerprintVersion: CapabilityFingerprintVersion,
  descriptorHash: Sha256Digest,
  encodedDescriptorBytes: Schema.Natural,
  modelExposureBytes: Schema.Natural,
})

export interface CapabilityDescriptorIdentityV1 extends Schema.Schema.Type<
  typeof CapabilityDescriptorIdentityV1
> {}

/** Stable evidence shared by governance planner fixtures across packages. */
export const CAPABILITY_SOURCE_EVIDENCE_FIXTURE = CapabilitySourceEvidence.make({
  version: CAPABILITY_SOURCE_EVIDENCE_VERSION,
  sourceId: CapabilitySourceId.make('builtin:yokai/history.context'),
  buildAttestation: {
    _tag: 'Complete',
    version: BUILD_ATTESTATION_VERSION,
    algorithm: 'sha-256',
    fingerprint: Sha256Digest.make(
      '795b1d4cd5e7f9b585271414be5b9935eb6fd25865f071a59d78bc46bf520e93',
    ),
  },
})

/** Stable descriptor identity shared by governance planner fixtures across packages. */
export const CAPABILITY_DESCRIPTOR_IDENTITY_FIXTURE = CapabilityDescriptorIdentityV1.make({
  version: CAPABILITY_DESCRIPTOR_IDENTITY_VERSION,
  fingerprintVersion: CAPABILITY_FINGERPRINT_VERSION,
  descriptorHash: Sha256Digest.make(
    '8601fd6267c69b37c33cfa3a007e68349dfea0c562a8fd345c5105ffc4d8a4f7',
  ),
  encodedDescriptorBytes: 256,
  modelExposureBytes: 0,
})
