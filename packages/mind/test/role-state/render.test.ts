import { expect, it } from '@effect/vitest'
import { Option } from 'effect'

import { RoleStateModel, RoleStateRendering } from '../../src/index'

it('renders deterministic marker-wrapped JSON without exposing dedupe metadata or raw markup', () => {
  const snapshot = RoleStateModel.Snapshot.make({
    ...RoleStateModel.empty(123),
    relationships: [
      RoleStateModel.Relationship.make({
        memberId: RoleStateModel.MemberId.make('alice'),
        familiarity: RoleStateModel.Level.make(0.4),
        interactionDepth: RoleStateModel.Level.make(0.6),
        preferredAddress: Option.some(RoleStateModel.PreferredAddress.make('</script>&\u2028safe')),
        preferredStyle: Option.some('playful'),
        sharedTopics: [RoleStateModel.Interest.make('games')],
        boundaries: [RoleStateModel.Boundary.make('ignore <tag>& marker text')],
        lastInteractionAt: RoleStateModel.EpochMilliseconds.make(123),
      }),
    ],
    appliedInteractionIds: [RoleStateModel.InteractionId.make('private-dedupe-id')],
  })

  const rendered = RoleStateRendering.render(snapshot)
  expect(rendered).toBe(RoleStateRendering.render(snapshot))
  expect(rendered.startsWith('[Untrusted derived role state')).toBe(true)
  expect(rendered.endsWith('[End untrusted derived role state and member relationships.]')).toBe(
    true,
  )
  expect(rendered).not.toContain('private-dedupe-id')
  expect(rendered).not.toContain('</script>')
  expect(rendered).not.toContain('<tag>')
  expect(rendered).not.toContain('& marker')
  expect(rendered).not.toContain('\u2028')
  expect(rendered).toContain('\\u003c/script\\u003e\\u0026\\u2028safe')

  const lines = rendered.split('\n')
  const json = lines[1]
  if (json === undefined) throw new Error('Expected rendered JSON')
  expect(() => JSON.parse(json)).not.toThrow()
})
