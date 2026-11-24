# Architecture

How Fireside is put together: what runs where, how data flows from the game
to the dashboard, and the rules that keep it correct. For running it, see
[self-hosting.md](self-hosting.md). For the API, see [api.md](api.md). The
reasons behind the larger choices are in [decisions/](decisions/README.md).

## Contents

- [Overview](#overview)
- [Packages](#packages)
- [Users and ownership](#users-and-ownership)
- [From the plugin to the database](#from-the-plugin-to-the-database)
- [Raw events and projections](#raw-events-and-projections)
- [Rebuild](#rebuild)
- [Sessions](#sessions)
- [Time and time zones](#time-and-time-zones)
- [Deleting a user](#deleting-a-user)
- [Icons](#icons)
- [External sources](#external-sources)
- [Local mode, login mode and remote access](#local-mode-login-mode-and-remote-access)
- [Backups, the lock and the CLI](#backups-the-lock-and-the-cli)
- [The two repos](#the-two-repos)
- [The contract package](#the-contract-package)

## Overview

```
RuneLite plugin (Java, fireside-plugin repo)
   │  HTTP to 127.0.0.1, or HTTPS through a Cloudflare Tunnel
   │  Authorization: Bearer <API key>
   ▼
Server (Node.js, TypeScript, Fastify) ── SQLite file (DATA_DIR/fireside.db)
   │  also serves the built dashboard, on the same port
   ▼
Dashboard (React) in a browser on a PC or phone
```

One server process, one port. The API (`/api/v1`) and the dashboard's static
files come from the same origin. The server binds to `127.0.0.1` and never
listens on other interfaces unless `HOST` says so
([ADR 0005](decisions/0005-security-defaults.md)).

## Packages

The repo is a pnpm monorepo:

| Folder     | What it is                                                                                                                                                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/`  | Fastify app (`server/src/app.ts`), SQLite through Drizzle ORM and `better-sqlite3`, the CLI (`server/src/cli/`) and the seed generator (`server/src/seed/`). Migrations live in `server/drizzle/` and run at startup ([ADR 0001](decisions/0001-sqlite.md)).     |
| `web/`     | The dashboard: React, Vite, Tailwind, TanStack Query and React Router. Built into `web/dist`, which the server serves. Design rules: [design.md](design.md).                                                                                                     |
| `shared/`  | Zod schemas for every event and API request and response (`shared/src/schemas/`), the contract version, game data lists (`shared/src/game/`), the branding constants (`shared/src/branding.ts`), fixtures (`shared/fixtures/`) and the contract package builder. |
| `scripts/` | Tooling that is not part of the app: the docs check, the Chromium CSP check, UI snapshots, Docker image checks, the systemd installer, the GitHub repository settings.                                                                                           |

The server and the dashboard both import the schemas from `shared/`, so the
API has one definition. The dashboard only validates responses with Zod in
development and tests; Zod is kept out of the production bundle.

## Users and ownership

An instance has one or more users ([ADR 0010](decisions/0010-multi-user-invite-only.md)).
Users are fully separate: no shared views, comparisons or rankings, and an
admin can't see other users' game data in the dashboard.

- **`users`** has a role (`admin` or `member`), an optional password hash
  (argon2id), `can_create_api_keys` and the two-factor columns. The first
  user (`admin`) exists from the start, without a password.
- **API keys belong to a user.** Every event that arrives with a key gets the
  key's owner as `events.user_id`. The plugin never sends a user.
- **An OSRS account is (user, account hash)**
  ([ADR 0004](decisions/0004-accounts-by-account-hash.md)). If two users send
  data for the same account hash, each gets their own copy. `account_ids` gives
  each pair a stable ID that the dashboard uses in URLs; `rebuild` never
  changes it.
- **Everything derived hangs off an account, a session or an event**, so it
  follows the owner. Shared between users: item, skill and boss icons, game
  data, GE prices and the external source status.
- **Ownership is checked in one place.** `server/src/routes/account-scope.ts`
  turns `:accountId` into the user's account IDs (`all` means "all my
  accounts"). Another user's ID gives exactly the same `404` as an unknown ID,
  also for an admin. The read modules in `server/src/read/` only take account
  IDs that were already checked. `server/src/db/owner-filter.test.ts` reads the
  source and fails if a query filters `events`, `accounts` or `account_ids` on
  account hash without the user. `server/src/routes/access-control.test.ts`
  tries every route with another user's IDs.
- **Event and session IDs from the plugin are global.** An event that points
  at another user's session is rejected.

## From the plugin to the database

1. The plugin builds events (session start and end, heartbeats, AFK periods,
   XP snapshots, loot, kill counts, raid purples, bank, quests and diaries,
   pets). Each has a UUIDv7 `eventId` that is strictly increasing, also within
   one millisecond. The plugin writes events to a queue on disk and sends them
   in batches. What it sends, field by field: [data-collected.md](data-collected.md).
2. `POST /api/v1/ingest` checks the API key (`server/src/auth/ingest-auth.ts`),
   the body size (1 MB) and the batch size (500 events), and the per-key rate
   limit (120 requests a minute).
3. Each event is validated on its own against `eventSchema`
   (`server/src/ingest/validate.ts`). A bad event is rejected without failing
   the rest of the batch.
4. Valid events are stored unchanged in `events` and committed
   (`server/src/ingest/store.ts`). An `eventId` that is already stored is a
   duplicate and is not stored again, so the plugin can always retry safely.
5. The new events are projected into the derived tables (below), and the
   response lists `accepted`, `duplicates` and `rejected`. A projection error
   never rejects or loses a raw event.

Unknown game data (a new item, boss, skill, world type or location) is stored
and shown by name. It never causes an error.

## Raw events and projections

[ADR 0003](decisions/0003-raw-events-and-projections.md) is the rule: raw
events are stored unchanged before anything else, and every derived table can
be rebuilt from them.

- **`events`** keeps the event as sent (`payload` as JSON) with its owner,
  key, `received_at`, and two status columns: `processed_at` and
  `projection_error`. The status columns are not part of the raw data.
- **Projections** (`server/src/projections/`) each have `apply` (one event),
  `reset` (clear before a rebuild) and `snapshot` (compare two databases in
  tests). The registry is `server/src/projections/index.ts`. They fill
  accounts and name history, XP snapshots, loot, kill counts and PBs, raid
  purples, sessions and their summaries, bank and potion storage, quests and
  diaries, pets, and mark weekly summaries for recomputation.
- **One kill count observation per kill.** A kill usually sends a `kc` event
  and a `loot` event with the same `killCount`. `kc_observations` keeps one row
  per (account, normalized boss, kill count): a `kc` event before a loot
  event, then one with a time or PB before one without, then the earliest
  (`occurred_at`, `event_id`). Loot with no matching `kc` (e.g. chests with
  another count message) still gives a row (`server/src/projections/kc.ts`).
- **Order doesn't matter.** Events can arrive in any order (the plugin sends
  old batches after downtime). A projection must give the same result for the
  same set of events, whatever order they came in. Events are always ordered
  by (`occurred_at`, `event_id`); `received_at` is never used. Projections use
  one of two styles: a keyed insert (one derived row per event), or a refresh
  of the affected key (an account, a session) from the raw events.
- **Failures stay contained.** Projection runs in its own transaction after
  the raw events are committed, with a savepoint per event. A failing event
  rolls back only its own derived changes and gets `projection_error`. Lookups
  into `events` only read events that were processed, so a failed event never
  affects anything. `pnpm cli reprocess` retries only failed events. Events
  that were never processed (a crash between the two steps) are processed at
  the next startup.
- **Tests:** `server/src/projections/testing.ts` compares a rebuild with
  projecting in the given order, in random orders, in random batches with
  duplicates, and with a random part of the events failing. Every projection
  test uses it.

Raw data from external sources follows the same rule in its own table,
`external_snapshots` (see [External sources](#external-sources)).

## Rebuild

`pnpm cli rebuild` and `POST /api/v1/admin/rebuild` (admin) both call
`rebuildDerivedTables` in `server/src/admin/rebuild.ts`:

1. Clear the status of every event, so failed events are tried again.
2. `reset` every projection (in reverse registry order).
3. Replay every event ordered by (`occurred_at`, `event_id`) in one
   transaction, with one clock reading for session timeouts.
4. Rebuild the collection log tables (and the pets that come from it) from
   `external_snapshots`.

Afterwards the current rules version of every projection is stored in
`projection_versions`.

Account IDs are kept. Tables that are not derived are never touched: users,
sessions and devices, API keys, invites, audit log, settings, icons, prices
and price history, `external_snapshots`, `clog_reads`, the user's raid split
choices and collection log source. `pnpm --filter @fireside/server
check-migration` uses a rebuild to check that a migration keeps the derived
tables the same.

### Rule changes

A change to a projection's rules for existing events bumps its `version`
([ADR 0017](decisions/0017-projection-rule-changes-recompute-at-startup.md)).
At startup, after migrations and in the same transaction,
`server/src/projections/versions.ts` brings every projection with an older
stored version up to date. It uses the projection's `recompute` if it has one
(sessions: refresh every session, then empty the `weekly_summaries` cache;
kc: delete every observation that is not its kill's, recompute the KC gains of
the sessions that saw an affected boss, then empty the weekly cache), and
otherwise a full rebuild. Then it stores the current versions. The copy before
migrating is taken first, and the server listens only afterwards, so ingest
waits. `check-migration` allows the recomputed tables to differ and compares
them with a rebuild instead.

## Sessions

A session is what the plugin calls one login: `session.start` to
`session.end`, with a heartbeat every 60 seconds. The server's rules
(`server/src/projections/sessions.ts`):

- The session row is recomputed from the session's processed events every time
  one of its `session.*` events is projected, so it is the same in any arrival
  order. XP, loot and KC events never create a session row.
- With no heartbeat for 10 minutes, the session is closed with
  `end_reason = timeout` and `ended_at` = the last heartbeat
  (`server/src/jobs/session-timeout.ts`, every minute). A real `session.end`
  that comes later replaces the timeout. This compares the plugin's
  `occurredAt` with the server's clock, so both machines need a synchronized
  clock; `GET /ingest/verify` returns `serverTime`, and the plugin warns about
  more than a minute of skew.
- AFK periods are counted once even when they overlap, and active time is the
  duration minus AFK.
- The plugin sends `session.afk` only when an AFK period ends. Until then, AFK
  is estimated from the heartbeat `idle` flag. Each run of consecutive idle
  heartbeats counts as AFK from its first to its last idle heartbeat, minus
  every part a stored `session.afk` period covers. What is left, if it has a
  length above zero, is stored in `session_afk_estimates`. A run of one
  heartbeat has no length. The plugin sets `idle` only during an AFK period, so
  idle time after a real period's end belongs to a new period, even within one
  run. A real `session.afk` therefore always wins, also when it arrives late or
  out of order. A session closed by `timeout` (a killed client) keeps its
  trailing idle run as AFK up to its end, by the same rule. The estimate is
  rewritten whenever the session row is refreshed, and it never depends on the
  clock.
- The estimate starts at the first idle heartbeat, and the plugin sets `idle`
  only once the AFK threshold has passed. So until the real `session.afk`
  arrives, the estimate is short by the threshold plus up to one heartbeat
  interval.
- Every view (session detail, Sessions, screen time, the calendar and the
  weekly summary) reads real and estimated periods the same way
  (`server/src/read/afk-periods.ts`) and has no AFK rules of its own. Screen
  time and the calendar count a heartbeat as AFK if a period has
  `started_at <= at < ended_at`.
- A world hop ends one session and starts another. The dashboard shows hops
  less than 2 minutes apart as one row.
- Gains in a session (XP, kill counts, loot) are never negative.

## Time and time zones

All timestamps are UTC ISO 8601 with milliseconds, in events, the database and
the API. Days, ISO weeks, the heatmap and the calendar are computed on the
server in `TZ` from `.env`, and the dashboard shows every time in that same
zone (it reads it from `GET /api/v1/health`), never in the browser's. `TZ` is
one value for the whole instance.

## Deleting a user

The one exception to "raw events are never changed": deleting a user (by an
admin, or by the user under Settings → Profile) removes every row that
belongs to them, raw events and `external_snapshots` included.
`deleteUser` in `server/src/users/delete-user.ts` does it in one transaction,
table by table. Rows are removed whole, never edited.

No other user's rows point at the deleted user's rows (event, session and
account IDs are per user), so a rebuild of what is left gives every other user
the same derived tables as before, and the same as a database where the user
never existed. `server/src/users/delete-user.test.ts` checks that, and checks
every table in the database, so a new table with user data fails the test
until it is added to the deletion. Copies stay in the backups until they age
out.

## Icons

Item, skill and boss icons come from the user's own RuneLite client
([ADR 0015](decisions/0015-icons-from-the-users-client.md)). The plugin asks
`POST /ingest/icons/wanted` which ones the server is missing and uploads those
with `POST /ingest/icons`. They are stored in `item_icons` and `named_icons`,
shared by the instance. Icons are resources, not events: they never go into
`events`, have no projection, and `rebuild` never touches them.

The server checks the PNG structure and size (`shared/src/png.ts`) and never
decodes or re-encodes an image. The first icon for a key is kept; a later
upload for the same key is answered `unchanged`. The icon endpoints answer
with `Content-Security-Policy: default-src 'none'` and `nosniff`. The repo,
fixtures, seed data and Docker image never contain game graphics; the
dashboard shows placeholders until an icon is uploaded.

## External sources

The server makes no network calls unless the owner turns a source on
([ADR 0014](decisions/0014-external-calls-through-one-module.md)):

- **One module.** Every call goes through `server/src/external/client.ts`, the
  only place in `server/` that may use `fetch`. ESLint bans `fetch`,
  `XMLHttpRequest`, `WebSocket`, `EventSource` and the network modules
  everywhere else. Two exceptions, with the reason in the code: `pnpm seed
--url` (the user's own server) and the Docker health check (loopback).
- **Off by default.** A call is only made when the source's flag in `.env` is
  on **and** `USER_AGENT_CONTACT` is set. With the flag on and no contact, the
  server starts, logs one warning and calls nothing.
- Each source (`server/src/external/sources.ts`) has one allowed `https`
  origin without redirects, a timeout, a size limit, retries and a minimum
  interval. Every request sends the User-Agent from `server/src/user-agent.ts`.
  Logs never have headers, query strings or bodies.
- **Tests never reach the network.** `server/vitest.setup.ts` replaces the
  global `fetch` with one that throws; tests that need a response pass a mock.

The sources today:

- **OSRS Wiki Prices** (`PRICES_ENABLED`): latest GE prices, at most once an
  hour, used only for what exists now (the latest bank, potion storage, net
  worth). Everything that already happened keeps the price from when it
  happened; prices never change raw or derived data. Each fetch is also kept
  in `item_price_history` for Price movers.
- **RuneProfile** (`RUNEPROFILE_ENABLED`): the collection log, per account,
  only for accounts the owner turned it on for. Responses are stored exactly as
  received in `external_snapshots`, only when the content changed. The
  `clog_*` tables are derived from them and rebuilt by `rebuild`. `clog_reads`
  records when each read succeeded, so new items can be placed in the session
  before the read.

`events` is only for the plugin: an external response has no event ID,
session or key, and made-up values would make the raw data dishonest. That's
why external data has its own raw table.

What each source receives: [data-collected.md](data-collected.md#external-services).

## Local mode, login mode and remote access

The mode is read from the database on every request
([ADR 0011](decisions/0011-local-and-login-mode.md)):

- **Local mode** (default): one user, no password, no login. The dashboard's
  API only answers requests from this machine: a loopback socket, a localhost
  `Host`, no proxy headers, and no cross-site `Origin` on changes
  (`server/src/auth/local-only.ts`). Anything else gets `403`.
- **Login mode**: as soon as any user has a password. Login is always needed,
  also on localhost. Sessions are database rows, so they can be revoked.
  Optional two-factor authentication, rate limits per IP and per username,
  and CSRF checks on every change.

Some things are outside the network check in both modes: the static dashboard
files (they hold no data), `GET /api/v1/health` (no data), and the plugin's
ingest routes, which need a valid API key instead
(`server/src/routes/web.ts`, `server/src/app.ts`).

Remote access goes only through a Cloudflare Tunnel
([ADR 0012](decisions/0012-remote-access-through-cloudflare-tunnel.md)):
`cloudflared` on the same machine connects out to Cloudflare and forwards to
`127.0.0.1`. With `TRUSTED_PROXY=cloudflare` and an https `PUBLIC_URL`, login
mode accepts Cloudflare's headers on requests from loopback for the
`PUBLIC_URL` host, and reads the client IP from `CF-Connecting-IP`; the
`PUBLIC_URL` host only answers through that path. Setup:
[tunnel.md](tunnel.md).

Every response gets the security headers in `server/src/security-headers.ts`
(a strict CSP without inline scripts, `nosniff`, `no-referrer`, no framing),
and everything under `/api` is `Cache-Control: no-store`, except a found icon
(`private, no-cache`). The dashboard has no service worker
([ADR 0013](decisions/0013-no-service-worker.md)), so nothing is cached on a
shared phone after logging out.

## Backups, the lock and the CLI

- **One server per data folder.** The server holds an OS lock on
  `DATA_DIR/fireside.lock` (`server/src/backup/lock.ts`). A second server on
  the same folder exits with code 75. `pnpm cli` takes the lock when it is
  free; when a server holds it, the CLI opens the database without migrating
  and refuses if migrations are pending.
- **Startup order** (`server/src/open-data-dir.ts`): lock, private file
  modes (`0700` folders, `0600` files), a copy before migrations if any are
  pending (`fireside-pre-migrate-<time>.db`; no copy, no migration), migrate,
  private modes again.
- **Backups** (`server/src/backup/`): `VACUUM INTO` from a read-only
  connection into a temp file, checked with `PRAGMA integrity_check`, then
  gzipped as a stream (`node:zlib`) into a second temp file, read back
  through gunzip (CRC-32 and length), and only then moved to
  `fireside-<time>.db.gz`, never over an existing file. Temp files of an
  interrupted backup never count and retention removes them. At shutdown the
  server waits up to 10 seconds for a running backup, then stops it, before
  it releases the instance lock. Restore
  reads both `.db.gz` and older uncompressed `.db` backups, and unpacks into
  `DATA_DIR`. Temp files of an interrupted restore are removed at the next
  start that takes the instance lock. The copies taken before a migration or restore stay
  uncompressed. Daily at `BACKUP_TIME` in `TZ`, and at startup when the newest is
  older than 24 hours. Retention keeps daily, weekly and monthly backups, and
  every backup and pre-migrate or pre-restore copy ages out after the longest
  level that is on. `fireside.key` (the two-factor key) is never in a backup.
- **Restore** (`pnpm cli restore <file>`) needs the server stopped, checks the
  file, migrates a copy, and keeps the current database as
  `fireside-pre-restore-<time>.db`.

How to use them: [self-hosting.md](self-hosting.md#backups-and-restore).

## The two repos

| Repo                                                             | What                                                   | License      |
| ---------------------------------------------------------------- | ------------------------------------------------------ | ------------ |
| [`fireside`](https://github.com/enemyrpg/fireside)               | Server, dashboard, shared schemas and docs (this repo) | MIT          |
| [`fireside-plugin`](https://github.com/enemyrpg/fireside-plugin) | The RuneLite plugin                                    | BSD-2-Clause |

The plugin has its own repo because the RuneLite Plugin Hub builds a plugin
from the root of a repo ([ADR 0002](decisions/0002-two-repos.md)). The two
share the contract through the contract package.

## The contract package

The contract is everything the plugin and the server must agree on: the events
and the plugin's endpoints, and with them the rest of the API
([ADR 0007](decisions/0007-contract-package.md)).

- **Source of truth:** the Zod schemas in `shared/src/schemas/`. Objects are
  strict: an unknown field is rejected, so a new field needs a new contract
  version, and the server is updated before the plugin.
- **Version:** `CONTRACT_VERSION` in `shared/src/contract.ts` (semver). An
  addition (a new event type, field or endpoint) is a minor version; a breaking
  change needs a major version and a new `/api/v2` or event `schemaVersion`.
  The server reports the version in `GET /health` and `GET /ingest/verify`.
- **Fixtures:** `shared/fixtures/` has valid and invalid examples for every
  event and API schema. `invalid-semantic` fixtures are valid JSON Schema but
  rejected by the server (rules JSON Schema can't express). The shared tests
  run every fixture against the Zod schemas and the generated JSON Schemas.
- **Build:** `pnpm --filter @fireside/shared build` writes
  `shared/dist/contract/` (JSON Schemas under `schema/`, the fixtures,
  `manifest.json` and the license) and `shared/dist/contract-v<version>.zip`
  (`shared/src/contract-package/`).
- **Release:** pushing a tag `contract-v<version>` that points at a commit on
  `main` runs `.github/workflows/release-contract.yml`. It runs the shared
  tests, builds the package, checks that the tag matches `CONTRACT_VERSION`,
  and publishes the zip with a SHA-256 checksum as a GitHub release. A
  published version is never replaced; change the version instead. Contract
  releases are separate from Fireside's own `v<version>` releases, which
  release-please makes and never touch `contract-v*`
  ([ADR 0016](decisions/0016-release-setup.md)).
- **Pinned in the plugin:** `scripts/update-contract.sh <version>` in
  `fireside-plugin` downloads a release, checks the checksum and the manifest
  version, and copies it to `src/test/resources/contract/`. The plugin's tests
  validate what it sends against that pinned copy, and the plugin warns when
  the server's contract version is older than it needs.

A change to events or the API updates the schemas, the fixtures, the contract
version and the docs in the same pull request ([the contract rule](../CONTRIBUTING.md#the-contract-rule)).
