import { AdapterId } from '@yokai/protocol'

import { makeFakeAdapterConformanceFactory } from '../../src/fake/index'
import { defineAdapterConformanceSuite } from '../../src/vitest/index'

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
