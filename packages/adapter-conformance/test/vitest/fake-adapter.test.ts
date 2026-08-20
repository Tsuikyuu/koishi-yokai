import { AdapterId } from '@yokai/protocol'

import { makeFakeAdapterConformanceFactory } from '../../src/fake/index.js'
import { defineAdapterConformanceSuite } from '../../src/vitest/index.js'

defineAdapterConformanceSuite(
  'deterministic fake adapter with feedback tools',
  makeFakeAdapterConformanceFactory({
    adapterId: AdapterId.make('fake-feedback-enabled'),
    feedbackTools: true,
    tokenNamespace: 'enabled-suite',
  }),
)

defineAdapterConformanceSuite(
  'deterministic fake adapter without feedback tools',
  makeFakeAdapterConformanceFactory({
    adapterId: AdapterId.make('fake-feedback-disabled'),
    feedbackTools: false,
    tokenNamespace: 'disabled-suite',
  }),
)
