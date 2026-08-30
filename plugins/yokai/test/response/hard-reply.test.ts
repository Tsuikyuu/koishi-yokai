import { expect, it } from 'vitest'

import type { HardReplyPolicy } from '../../src/config'
import { HardReplyDecision } from '../../src/response/hard-reply'

const booleans: ReadonlyArray<boolean> = [false, true]

const policies: ReadonlyArray<HardReplyPolicy> = booleans.flatMap((atMention) =>
  booleans.flatMap((replyToSelf) =>
    booleans.flatMap((roleNamePrefix) =>
      booleans.map((roleNameContains) => ({
        atMention,
        replyToSelf,
        roleNamePrefix,
        roleNameContains,
      })),
    ),
  ),
)

it('classifies all four configurable hard reply recognizers independently', () => {
  for (const policy of policies) {
    expect(
      HardReplyDecision.classify(
        { explicitMention: true, replyToSelf: false, presetNameMatch: 'none' },
        policy,
      ),
    ).toBe(policy.atMention ? 'explicit-mention' : 'none')
    expect(
      HardReplyDecision.classify(
        { explicitMention: false, replyToSelf: false, presetNameMatch: 'prefix' },
        policy,
      ),
    ).toBe(
      policy.roleNamePrefix
        ? 'role-name-prefix'
        : policy.roleNameContains
          ? 'role-name-contains'
          : 'none',
    )
    expect(
      HardReplyDecision.classify(
        { explicitMention: false, replyToSelf: false, presetNameMatch: 'contains' },
        policy,
      ),
    ).toBe(policy.roleNameContains ? 'role-name-contains' : 'none')
    expect(
      HardReplyDecision.classify(
        { explicitMention: false, replyToSelf: true, presetNameMatch: 'none' },
        policy,
      ),
    ).toBe(policy.replyToSelf ? 'reply-to-self' : 'none')
  }
})

it('uses one deterministic decision when recognizers overlap', () => {
  const allEnabled: HardReplyPolicy = {
    atMention: true,
    replyToSelf: true,
    roleNamePrefix: true,
    roleNameContains: true,
  }
  expect(
    HardReplyDecision.classify(
      { explicitMention: true, replyToSelf: true, presetNameMatch: 'prefix' },
      allEnabled,
    ),
  ).toBe('explicit-mention')
  expect(
    HardReplyDecision.classify(
      { explicitMention: true, replyToSelf: true, presetNameMatch: 'prefix' },
      { ...allEnabled, atMention: false },
    ),
  ).toBe('reply-to-self')
  expect(
    HardReplyDecision.classify(
      { explicitMention: false, replyToSelf: true, presetNameMatch: 'prefix' },
      { ...allEnabled, replyToSelf: false },
    ),
  ).toBe('role-name-prefix')
  expect(
    HardReplyDecision.classify(
      { explicitMention: false, replyToSelf: false, presetNameMatch: 'prefix' },
      allEnabled,
    ),
  ).toBe('role-name-prefix')
  expect(
    HardReplyDecision.classify(
      { explicitMention: true, replyToSelf: false, presetNameMatch: 'prefix' },
      { ...allEnabled, atMention: false },
    ),
  ).toBe('role-name-prefix')
})
