import { WakeMessage } from '@yokai-internal/core'

import type { HardReplyPolicy } from '../config'

export interface Facts {
  readonly explicitMention: boolean
  readonly replyToSelf: boolean
  readonly presetNameMatch: WakeMessage.PresetNameMatch
}

export const classify = (facts: Facts, policy: HardReplyPolicy): WakeMessage.HardReplyKind => {
  if (policy.atMention && facts.explicitMention) {
    return WakeMessage.HardReplyKind.make('explicit-mention')
  }
  if (policy.replyToSelf && facts.replyToSelf) {
    return WakeMessage.HardReplyKind.make('reply-to-self')
  }
  if (policy.roleNamePrefix && facts.presetNameMatch === 'prefix') {
    return WakeMessage.HardReplyKind.make('role-name-prefix')
  }
  if (policy.roleNameContains && facts.presetNameMatch !== 'none') {
    return WakeMessage.HardReplyKind.make('role-name-contains')
  }
  return WakeMessage.HardReplyKind.make('none')
}

export * as HardReplyDecision from './hard-reply'
