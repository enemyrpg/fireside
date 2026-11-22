# 0007. The contract package

- **Date:** 2026-11-09
- **Status:** Accepted

## Context

The plugin (Java) and the server (TypeScript) are in two repos
([ADR 0002](0002-two-repos.md)) and must agree exactly on every event and on
the plugin's endpoints. Hand-written copies drift apart, and the plugin can't
import Zod.

## Decision

- The Zod schemas in `shared/src/schemas/` are the only definition.
- `pnpm --filter @fireside/shared build` generates JSON Schemas from them and
  packs them with the fixtures, a manifest and the license into
  `contract-v<version>.zip`.
- A `contract-v<version>` tag on `main` publishes the zip with a SHA-256
  checksum as a GitHub release (`.github/workflows/release-contract.yml`). The
  tag must match `CONTRACT_VERSION`, and a published version is never replaced.
- The plugin pins a version with `scripts/update-contract.sh <version>` into
  `src/test/resources/contract/` and validates what it sends against it in its
  tests.
- `CONTRACT_VERSION` is semver: additions are minor, breaking changes need a
  major version and a new API path or event `schemaVersion`.

## Consequences

- The plugin is always tested against a known contract, and the server reports
  its version so the plugin can warn when the server is too old.
- Every change to events or the API updates the schemas, fixtures, version and
  docs in the same pull request.
- Objects are strict, so a server only accepts fields it knows: the server is
  released before a plugin that sends something new.
- Details: [architecture.md](../architecture.md#the-contract-package).
