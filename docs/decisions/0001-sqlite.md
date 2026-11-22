# 0001. SQLite with Drizzle

- **Date:** 2026-11-08
- **Status:** Accepted

## Context

Fireside is self-hosted by people who don't want to run a database server. An
instance has one or a few users and a few accounts each: a few thousand events
a day at most. Backups should be a file copy, and moving to another machine
should be just as easy.

## Decision

One SQLite file, `DATA_DIR/fireside.db`, through Drizzle ORM with the
`better-sqlite3` driver. WAL and foreign keys are on for every connection.
Migrations are generated with drizzle-kit, live in `server/drizzle/` and run at
startup, after a copy of the database is taken.

## Consequences

- Nothing to install or run besides the server, and backups are a consistent
  `VACUUM INTO` while the server writes.
- Only one server may use a database file. An OS lock on
  `DATA_DIR/fireside.lock` enforces it, also against the CLI and the seed
  script.
- `better-sqlite3` has prebuilt binaries for amd64 and arm64, so the Docker
  build never compiles. Moving to `node:sqlite` later would only change the
  connection module; the schema and migrations stay.
- Drizzle keeps a move to Postgres possible, but nothing plans for it.
- Writes are synchronous: a long query blocks the server while it runs, so
  projections must stay small per event.
