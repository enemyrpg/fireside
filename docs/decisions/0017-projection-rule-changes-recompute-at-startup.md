# 0017. Rule changes to projections recompute existing data at startup

- **Date:** 2026-11-23
- **Status:** Accepted

## Context

[ADR 0003](0003-raw-events-and-projections.md) says a fixed rule is a code
change plus a rebuild. Until now, someone had to run that rebuild by hand after
upgrading. Until they did, existing rows kept the old rules, and
`check-migration` reported the difference as a failure. The first rule change
of this kind is the AFK estimate from idle heartbeats
([architecture.md](../architecture.md#sessions)): every existing session needs
new AFK numbers.

## Decision

- Each projection has a rules version in code (`version` in
  `server/src/projections/framework.ts`, default 1). The database stores the
  version its rows were built with, in `projection_versions`. A missing row
  means version 1.
- **Changing a projection's rules for existing data bumps its version.** The
  same change either gives the projection a `recompute`, which updates only what
  the rule changes, or relies on the fallback: a full rebuild inside the startup
  transaction.
- At startup (and in `pnpm cli` when it holds the lock), migrations run first.
  Then, in the same transaction, every projection whose stored version is older
  than the code's is recomputed, and the current versions are stored
  (`server/src/projections/versions.ts`). This runs after the copy before
  migrating and before the server listens. It is logged with its duration. A
  fresh or rebuilt database only stores the current versions.
- `pnpm cli` refuses outdated versions while a server runs, just as it refuses
  pending migrations.
- `check-migration` allows the tables an upgrade recomputed to differ. The
  rebuild check still compares them exactly.

## Consequences

- Upgrading needs no manual step. A rule fix reaches existing data with the
  next start.
- The first start after a rule change takes longer. On the 12-month seed, the
  AFK recompute took well under a second. A fallback rebuild takes about as long
  as `pnpm cli rebuild`. Ingest waits until it is done, and the plugin retries.
- A rule change that does not bump the version only applies to new events and
  to the next manual rebuild. Reviews must check for the bump.
- ADR 0003 still holds: derived rows come only from raw data, and
  `pnpm cli rebuild` still rebuilds everything.
