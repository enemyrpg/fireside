# Fireside

Self-hosted tracker for Old School RuneScape. A RuneLite plugin (separate repo:
`fireside-plugin`, cloned next to this repo in `../fireside-plugin`)
collects data for one or more accounts and sends it to this server, which shows
it on a personal dashboard. Open source. One or more invited users per instance,
each with their own accounts and data.

Read the relevant docs before starting a task:

- How it works: `docs/architecture.md`. The API: `docs/api.md`.
- Why it is like this: `docs/decisions/` (one ADR per lasting decision).
- Dashboard design rules: `docs/design.md`.
- What is collected and stored: `docs/data-collected.md`.
- Legal constraints: `docs/legal.md`.
- Running it: `docs/self-hosting.md` and `docs/tunnel.md`.

## Repo layout

- `server/` – Fastify + TypeScript + SQLite (Drizzle).
- `web/` – React + Vite + Tailwind + TanStack Query dashboard.
- `shared/` – Zod schemas (source of truth for the API contract), JSON Schema
  generation, fixtures, contract package, game data, branding constants.
- `scripts/` – game data scripts and other tooling.
- `docs/` – user and developer documentation, and the ADRs in `docs/decisions/`.

License: MIT, except `shared/gamedata/` (generated from the OSRS Wiki),
which is CC BY-NC-SA 3.0 with its own LICENSE file.

## Commands

- `pnpm install` / `pnpm dev` / `pnpm test` / `pnpm lint` / `pnpm build`
- `pnpm typecheck` – type-check all packages
- `pnpm format` – format with Prettier
- `pnpm seed` – fill a separate seed database (`data-seed/`, never `DATA_DIR`) with
  simulated data for 2–3 accounts, sent through `POST /api/v1/ingest`. The
  collection log of two accounts is not an event: it is stored as raw external
  data in `external_snapshots`, with no source turned on (skipped with `--url`). Options:
  `--seed <n>` (default 1), `--accounts 2|3` (default 3), `--months <n>` (default 6),
  `--until <ISO>` (default now; same seed + until = same events), `--reset` (delete
  and recreate the seed database), `--data-dir <dir>`, `--url <url> --key <key>`
  (send to a running server instead). Run the server on it with
  `env DATA_DIR=data-seed pnpm dev`
- `pnpm cli keys create <name> [--user <username>]` / `keys list` / `keys revoke <id>` – manage
  API keys. `--user` is needed when there are several users; `list` shows every user's keys
  with owners. The CLI acts as the server operator: not limited by `can_create_api_keys`,
  but by the 10 active keys per user
- `pnpm cli users list` / `users create <name> [--admin]` / `users set-password <name>` /
  `users rename <old> <new>` / `users clear-password <name>` / `users reset-2fa <name>` – manage
  users (`reset-2fa` turns off a user's two-factor authentication). A password
  turns login mode on; `create` needs login mode, `clear-password` only works with one user.
  Passwords are read from the terminal (or stdin), never from arguments
- `pnpm cli rebuild` – rebuild derived tables from raw events
- `pnpm cli reprocess` – retry only events whose projection failed
- `pnpm cli backup` – back up the database now into `BACKUP_DIR` (safe while the
  server runs; the server also backs up daily)
- `pnpm cli restore <file>` – restore the database from a backup (server stopped;
  keeps a copy of the current database in `BACKUP_DIR`)
- `pnpm --filter @fireside/server check-migration <db-file> [<work-dir>]` – check
  pending migrations on a copy of a database (the original is only read): same
  rows and content, ownership, and a rebuild gives the same derived tables

## Rules

- The product name is "Fireside" (slug `fireside`, API key prefix `fs_`).
  Never hardcode it: use the constants in `shared/src/branding.ts` (display
  name, short name, API key prefix, Jagex disclaimer text, etc.).
- The contract lives in `shared/`. Any change to events or API must update the
  Zod schemas, fixtures, the contract version and the matching documentation
  in `docs/` in the same PR. Breaking changes need a new API or schema version
  (see `docs/api.md` and `docs/decisions/0007-contract-package.md`).
- Store raw events unchanged in `events` before processing. Derived tables must
  be rebuildable from raw events. The one exception: deleting a user removes all
  their rows, raw events and `external_snapshots` included (see
  `docs/decisions/0003-raw-events-and-projections.md` and "Deleting a user" in
  `docs/architecture.md`).
- Changing a projection's rules for existing data bumps its `version`, and
  either gives it a `recompute` or relies on the rebuild fallback. Existing
  data is then recomputed at startup
  (`docs/decisions/0017-projection-rule-changes-recompute-at-startup.md`).
- Events are idempotent by `eventId` (UUIDv7). Never create duplicates
  (`docs/decisions/0003-raw-events-and-projections.md`).
- All timestamps are UTC ISO 8601. Day/week grouping uses `TZ` from `.env`
  ("Time and time zones" in `docs/architecture.md`).
- Accounts are identified by (user, RuneLite account hash), never by display
  name (`docs/decisions/0004-accounts-by-account-hash.md`).
- Security defaults: bind to 127.0.0.1, API keys hashed, ingest keys can send
  but only read their own name, the server's versions and clock, and which
  icons are missing, no secrets in the repo. Never weaken these without a new
  ADR in `docs/decisions/` (see `docs/decisions/0005-security-defaults.md`).
  The dashboard may be reached from outside only through the Cloudflare Tunnel
  set up as in `docs/tunnel.md`, and in no other way (never LAN or a published
  port). The server keeps binding to 127.0.0.1; remote access goes through a
  tunnel that connects locally
  (`docs/decisions/0012-remote-access-through-cloudflare-tunnel.md`).
- No external network calls unless optional and behind an `.env` flag. Every
  external call sends a descriptive User-Agent from `.env`. All of them go
  through `server/src/external/client.ts` (off unless the source's flag and
  `USER_AGENT_CONTACT` are set; ESLint bans `fetch` and network modules
  elsewhere in `server/`). Tests use a mocked fetch, never the real network
  (`docs/decisions/0014-external-calls-through-one-module.md`).
- Unknown game data (new items, bosses, quests) must never cause errors:
  store it and display it by name ("From the plugin to the database" in
  `docs/architecture.md`).
- Legal (see `docs/legal.md`):
  - Never commit Jagex assets (item icons, game screenshots, logos) to the
    repo, fixtures, seed data or the Docker image. Use placeholder icons.
    Real icons only live in the user's own database
    (`docs/decisions/0015-icons-from-the-users-client.md`). The Fireside logo
    is our own SVG, drawn in `web/src/branding/logo.ts` (copies in
    `assets/logo/`).
  - Never store data about other players. Loot from players has no name.
    One exception: a nickname (and note) the owner types in the dashboard for
    a raid drop in the split tracker. It lives in the split tracker's own tables,
    never in raw events, and is never sent by the plugin, never logged and
    never included in exports or the seed data
    (`docs/decisions/0006-no-data-about-other-players.md`).
  - The dashboard footer and README show the Jagex Fan Content Policy
    disclaimer from the branding constants.
  - Data generated from the OSRS Wiki stays under CC BY-NC-SA 3.0 with
    attribution. Do not relicense it as MIT.
  - No commercial features.
- Dashboard work follows `docs/design.md` (layout, colors, components). Do not invent a new visual style per page. Do not imitate
  Jagex's own websites or use Jagex logos.
- Code, comments, commit messages and UI text in English (`CONTRIBUTING.md`).
  Comments explain the reason themselves or link to `docs/`; never refer to
  task numbers, issue numbers or private documents.
- TypeScript strict mode. No `any` without a comment explaining why
  (`CONTRIBUTING.md`).
- Write tests for contract validation and all calculations (gains, sessions,
  screen time, weekly summaries, goals) (`CONTRIBUTING.md`).

## Workflow

- One task per branch and PR (e.g. `fix/session-end-after-hop`).
- PR titles use Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:` …).
  PRs are squash-merged. Never push directly to the default branch.
- Start with a plan, then tests, then implementation.
- Keep PRs small. Update `docs/` when behaviour or decisions change, and add an
  ADR to `docs/decisions/` for a lasting decision.
- Never run a server from a branch with an unmerged migration against data-dev
  or data. Test unmerged migrations only against a scratch or seed database,
  because a migration that is regenerated later leaves those databases unusable.
- Only stop processes you started yourself, by the PID you recorded when
  starting them. Never use `pkill`, `killall`, `pgrep`-based kills or any match
  on process names or command lines. Never stop, restart or otherwise touch a
  running production instance (its container or service) or anything on its port.
- Scratch, seed and test servers never read the real `.env`, and always run
  with `PRICES_ENABLED=false`, `RUNEPROFILE_ENABLED=false`, an empty
  `USER_AGENT_CONTACT` and an empty `TRUSTED_PROXY`, so they make no external
  calls. The server, `pnpm cli` and `pnpm seed` load `.env` from the repo root
  (variables already set win), so run them from a checkout without `.env`
  (e.g. a git worktree) and set those variables, and check the log for
  "External request".
