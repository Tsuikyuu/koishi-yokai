# Yokai Repository Guide

Yokai is a Yarn 4 and Yakumo monorepo for developing the Yokai family of Koishi plugins.
All paths in this document are relative to the repository root.

## Repository structure

- `plugins/`: publishable Koishi plugins. Public packages use the
  `@yokai/koishi-plugin-*` naming scheme. The main plugin currently lives in
  `plugins/yokai`.
- `packages/`: internal implementation packages shared by plugins. These are not Koishi
  plugins and use the `@yokai/*` naming scheme.
- `docs/`: architecture and behavior design documents.
- `yakumo.yml`: workspace build pipeline configuration.

Source code belongs in each workspace's `src/` directory. Do not edit generated `lib/`,
`dist/`, or `*.tsbuildinfo` files directly.

## TypeScript module specifiers

- Relative module specifiers that resolve to TypeScript source must be extensionless. Write
  `./module`, not `./module.js`, in imports, type-only imports, re-exports, dynamic imports,
  and import types. The Koishi development host maps Yokai workspaces directly to `src/`
  and loads them through `esbuild-register`; a source-spelled `.js` suffix can prevent HMR
  from loading the module and its exported plugin schema.
- `yarn lint` enforces this invariant. Do not suppress it for TypeScript modules. Fix the
  specifier and run `yarn lint` and `yarn build`; when changing a plugin entry or export
  chain, also smoke-test its source entry through the development loader. A narrow,
  documented disable is permitted only when importing an actual JavaScript runtime file.

## Effect baseline

- The repository targets exactly `effect@4.0.0-rc.110`. Every workspace that imports
  Effect must declare this exact version in its own dependencies; do not use a caret, tilde,
  npm dist-tag, or implicit dependency.
- The authoritative Effect skill source is
  <https://github.com/Tsuikyuu/skills/tree/main/skills/effect>. Install and update the local
  Effect skill only from this source; do not substitute Effect v3, beta, another RC, or
  guidance written for a different API version.
- An Effect upgrade is an explicit repository-wide change. Update this baseline and every
  workspace dependency declaration together, then validate all Effect code before adopting
  APIs from the new version.

## Functional architecture

- Effect v4 is the standard effect system for new internal code. Do not introduce another
  effect, dependency injection, optional-value, or result abstraction without a concrete
  interoperability requirement.
- Keep a functional core and an effectful shell. Deterministic domain transformations are
  ordinary pure functions; I/O, time, randomness, configuration, concurrency, and shared
  state are explicit Effects.
- Keep Koishi entry points thin: translate framework input, provide the runtime Layer, run
  one Effect, and translate its result back. `Effect.run*` belongs only at this outer
  boundary or in test infrastructure, never in reusable services or internal packages.
- Internal packages must not depend on Koishi. Framework-specific behavior belongs in a
  plugin adapter, while internal services expose framework-independent domain types.
- Do not use native Promise workflows or `async`/`await` for application logic. Wrap
  Promise APIs with `Effect.tryPromise` and synchronous unsafe APIs with `Effect.try` at the
  adapter boundary.

## Effect workflows, services, and Layers

- Compose workflows with `Effect.gen(function* () { ... })`. Define public service methods
  and non-trivial internal operations with a stable `Effect.fn("Domain.operation")` name.
- Define application services with Effect `Context.Service` and readonly function-valued
  members. Build real implementations with the matching Layer constructor, defaulting
  effectful acquisition to `Layer.effect` and returning `Service.of({ ... })`.
- Keep dependencies explicit in the Effect environment. Do not hide credentials,
  persistence, transports, provider clients, or other authority in module globals or
  default references.
- Compose Layers at the application boundary. Use `Layer.provideMerge` only when a
  dependency intentionally remains visible, and do not use `Layer.mergeAll` or broad
  provisioning merely to silence environment errors.
- Long-lived streams, listeners, and workers must be owned by a Layer scope and forked with
  `Effect.forkScoped`, `FiberSet`, or `FiberMap`. Layer acquisition itself must complete.

## Data, optional values, and errors

- Model ordinary records with `Schema.Struct` plus a same-name interface. Use constrained
  branded schemas for scalar identifiers and value objects.
- Use `Data.TaggedEnum` for internal decisions and state machines. Use
  `Schema.TaggedStruct` or `Schema.TaggedUnion` when variants cross persistence, provider,
  plugin, or wire boundaries, and match every tagged variant exhaustively.
- Decode untrusted input with `Schema.decodeUnknownEffect` at the boundary. Use
  `schema.makeEffect` when construction failure belongs in the Effect error channel;
  reserve `schema.make` for trusted construction. Never bypass validation with a cast.
- Normalize absent, nullable, and defaulted external fields during decoding. Represent
  semantic absence inside the domain with Effect `Option`, not nullish control flow.
- Model expected failures with `Schema.TaggedError`. Translate infrastructure errors
  into domain-specific tagged errors at service boundaries and recover with typed error
  operators such as `catchTag` or `catchTags`.
- Do not write business `throw` or `try`/`catch`. Reserve defects and cause-level recovery
  for broken invariants and explicit supervision boundaries; never hide interruptions.
- Do not use ordinary mutable classes for domain data or services. Classes are reserved for
  Effect service tags, tagged Effect errors, and unavoidable framework interoperability.

## Runtime effects and state

- Read runtime configuration through Effect `Config` or translate Koishi configuration into
  an explicit service at the plugin boundary. Never read `process.env` in application logic;
  use redacted configuration values for credentials.
- Use Effect `Clock` and explicit services for time, randomness, and identifier generation.
  Use `Schedule` for bounded retry, repetition, polling, pacing, and backoff. Retry only
  transient operations with proven idempotency.
- Use `Stream` for ordered, many-valued effectful sources. Prefer `Stream.paginate` for
  paginated APIs, `Queue` for work distribution, `PubSub` for broadcast, and
  `SubscriptionRef` for current state plus updates.
- Prefer Effect HTTP clients for provider adapters. If raw `fetch` is required by a platform
  boundary, keep it inside a named adapter Effect, propagate cancellation, classify status,
  and decode the response with Schema.
- Prefer Effect `Cache` for bounded keyed caching and concurrent lookup deduplication. Build
  caches once in their owning Layer; do not hand-roll TTL, prune, or in-flight maps when the
  Effect primitive fits.
- Keep data immutable with `readonly` properties, readonly arrays, and new return values.
  Put necessary shared state behind `Ref`, `SynchronizedRef`, `SubscriptionRef`, `Queue`, or
  an explicit service rather than a module-level mutable value.

## Code quality

- Do not use type assertions. `as const` is the only exception; ordinary `as` assertions,
  angle-bracket assertions, and forced narrowing are prohibited. Narrow values with
  constructors, parsing functions, type guards, or explicit data structures instead.
- Do not use non-null assertions or definite assignment assertions. Handle missing values
  with explicit branches, Effect `Option`, or typed domain errors.
- Do not use optional chaining. Access optional values through explicit branches,
  `Option.match`, or exhaustive tagged matching.
- Do not use `any` or write explicit `unknown` types. Parse boundary input into a precise
  type or an explicit error as early as possible.
- Prefer immutable data. Use `readonly` properties, readonly arrays, and new return values;
  avoid shared mutable state and do not mutate function parameters.

## Effect testing

- Use Effect-aware tests and explicit test Layers by default. Production code depends on
  production service tags; tests provide deterministic implementations and expose a test
  service only when control or inspection is required.
- Use `TestClock` for time, sleeps, schedules, retries, and timeouts. Do not wait on real time
  or add arbitrary sleeps to synchronize a test.
- Coordinate concurrent tests with `Deferred`, `Queue`, `Latch`, `Ref`, or explicit hooks.
  Test typed failures, interruption, finalization, retry bounds, idempotency, and malformed
  boundary data where relevant.

## Source file responsibilities

- Each source file should express one clear responsibility: a domain concept, value object,
  use case, port, adapter sub-capability, protocol parser, or cohesive set of pure functions.
- File length is not itself a problem; mixed responsibilities are. Do not split files
  mechanically to satisfy a line count.
- Before adding a function, type, or service, confirm that the current filename naturally
  explains why it belongs there. Otherwise, place it in a semantic subdirectory or an
  adjacent responsibility-focused file.
- Prefer splitting when domain logic and side effects share a file, when one file implements
  multiple use cases, protocols, or adapter capabilities, when its filename cannot describe
  its main exports, or when testing a small behavior requires substantial unrelated setup.

## Directory structure

- Before adding a source file, identify the domain concept, use case, port, adapter,
  protocol, value object, or shared infrastructure it belongs to. Directory levels must
  express that semantic ownership.
- Do not flatten many files into a package root, the `src/` root, or one large directory.
  When files can be grouped by capability, protocol, tool type, or boundary layer, create a
  semantic subdirectory for that group.
- When a responsibility becomes complex enough to split, first create a semantic directory
  around the responsibility represented by the original file, then place its
  sub-responsibilities inside that directory.
- Tests belong in the package or application's `test/` directory and must mirror paths under
  `src/`. For example, code under `src/tools/read/` is tested under `test/tools/read/`.

## Git workflow

- Keep `main` releasable and do not develop directly on it. Before starting work, fetch the
  remote, fast-forward local `main` to `origin/main`, and create a short-lived branch named
  `<type>/<short-kebab-description>`, such as `feat/gemini-discovery` or
  `docs/model-selection`.
- Keep one coherent goal per branch. Do not mix unrelated fixes, formatting sweeps, dependency
  upgrades, or refactors into the same branch merely because they were discovered together.
- Make every commit atomic: it must represent one reviewable, testable, and safely revertible
  change. Supporting tests and documentation belong in the same commit as the behavior they
  verify or describe.
- Stage exact files or hunks and inspect `git diff --cached` before committing. Do not commit
  secrets, local configuration, generated output, or unrelated working-tree changes.
- Use Conventional Commit headers: `<type>(<optional-scope>): <imperative summary>`. Prefer
  `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, and `chore`; keep the summary concise,
  without a trailing period. Add a body when the motivation or migration impact is not obvious.
- Before pushing or merging, run the checks relevant to the change, including `yarn lint` and
  `yarn build` when applicable, and confirm the worktree is clean. Never force-push `main` or
  rewrite commits already shared with collaborators.
- Merge an accepted branch into an up-to-date `main` with an explicit merge commit (`--no-ff`),
  then push `main`. Delete the local and remote task branches only after verifying that their
  tips are contained in the pushed `main`.

## Common commands

- `yarn build`: build all workspaces.
- `yarn lint`: run ESLint and verify formatting.
- `yarn lint:fix`: fix lint and formatting issues where possible.
- `yarn format`: format the repository with Prettier.
