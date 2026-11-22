# 0003. Raw events unchanged, rebuildable projections

- **Date:** 2026-11-08 (the user-deletion exception: 2026-11-18; external raw
  data: 2026-11-16)
- **Status:** Accepted

## Context

The plugin collects data that can't be collected again: a session that was
played is gone. The rules that turn events into sessions, gains and summaries
will get better over time, and they will have bugs. A bug in a rule must never
destroy data.

## Decision

- Every event from the plugin is stored **unchanged** in `events` before
  anything else happens, and is never edited afterwards. Events are idempotent
  by `eventId` (a UUIDv7 from the plugin); a duplicate is never stored twice.
- Everything the dashboard reads is a **projection**: derived tables built
  from the raw events by `server/src/projections/`. A projection gives the same
  result for the same set of events in any order, ordered by
  (`occurred_at`, `event_id`).
- `pnpm cli rebuild` (and `POST /admin/rebuild`) empties every derived table
  and builds it again from `events`.
- Data from external sources is raw data too, in its own table,
  `external_snapshots`, stored exactly as received and never edited. `events`
  stays for the plugin only.
- **The one exception:** deleting a user deletes all their rows, raw events and
  `external_snapshots` included. Rows are removed whole, never edited, and a
  rebuild of what is left gives every other user the same tables as before
  (`server/src/users/delete-user.ts`).

## Consequences

- Fixing a rule is a code change and a rebuild, never a data migration.
- A projection error never loses or rejects an event: it is marked and can be
  retried (`pnpm cli reprocess`).
- Projections must not depend on arrival order, `received_at` or their own
  earlier output. The test helper in `server/src/projections/testing.ts`
  checks every projection in random orders and batches, with duplicates and
  failures.
- Tables that are not derived (users, keys, sessions, settings, icons, prices,
  the user's own choices) are never touched by a rebuild, and must not be
  derivable only from data that a rebuild would clear.
- The database only grows. A rebuild of a large database takes about a
  minute.
- Details: [architecture.md](../architecture.md#raw-events-and-projections).
