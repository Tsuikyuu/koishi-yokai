# Shared packages

This directory contains the non-Koishi-plugin implementation and test-support packages:

- `@yokai/protocol`: public, vendor-neutral extension contracts.
- `@yokai/adapter-conformance`: public, reusable adapter conformance tests and deterministic test doubles.
- `@yokai/core`: private orchestration and runtime primitives.
- `@yokai/mind`: private roleplay decision and expression logic.
- `@yokai/memory`: private archive and memory capabilities.

Packages intended for publication as Koishi plugins belong in `../plugins`.
