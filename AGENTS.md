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

## Code quality

- Do not use type assertions. `as const` is the only exception; ordinary `as` assertions,
  angle-bracket assertions, and forced narrowing are prohibited. Narrow values with
  constructors, parsing functions, type guards, or explicit data structures instead.
- Do not use non-null assertions or definite assignment assertions. Handle missing values
  with explicit branches, `Option`, or domain errors.
- Do not use optional chaining. Access optional values through explicit branches, `Option`,
  or pattern matching.
- Do not use `any` or write explicit `unknown` types. Parse boundary input into a precise
  type or an explicit error as early as possible.
- Prefer immutable data. Use `readonly` properties, readonly arrays, and new return values;
  avoid shared mutable state and do not mutate function parameters.

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

## Common commands

- `yarn build`: build all workspaces.
- `yarn lint`: run ESLint and verify formatting.
- `yarn lint:fix`: fix lint and formatting issues where possible.
- `yarn format`: format the repository with Prettier.
