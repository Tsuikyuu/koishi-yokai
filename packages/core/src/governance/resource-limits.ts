import { Option } from 'effect'

export interface Input {
  readonly platform: number
  readonly policy: number
  readonly registered: Option.Option<number>
  readonly model: Option.Option<number>
  readonly remaining: Option.Option<number>
}

const presentLimits = (limits: ReadonlyArray<Option.Option<number>>): ReadonlyArray<number> =>
  limits.flatMap((limit) =>
    Option.match(limit, {
      onNone: () => [],
      onSome: (value) => [value],
    }),
  )

/** Resolve a resource limit without allowing policy to widen any applicable authority. */
export const minimumApplicable = (input: Input): number =>
  Math.min(
    input.platform,
    input.policy,
    ...presentLimits([input.registered, input.model, input.remaining]),
  )

export * as ResourceLimits from './resource-limits'
