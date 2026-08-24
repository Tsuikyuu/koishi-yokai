import { Equal } from 'effect'

import type { AdapterModelSnapshot } from 'yokai-protocol'

/** Compare discovery content while deliberately excluding refresh time. */
export const adapterModelSnapshotContentEqual = (
  left: AdapterModelSnapshot,
  right: AdapterModelSnapshot,
): boolean => Equal.equals(left.models, right.models)
