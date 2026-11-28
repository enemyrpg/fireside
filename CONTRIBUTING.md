# Contributing to Fireside

Thanks for your interest. Pull requests are welcome. For anything larger than
a small fix (a new feature, a new page, a change to the API contract or the
database), please open an issue first so we can agree on the approach before
you spend time on it.

Questions and ideas also go in issues. Security problems don't: see
[SECURITY.md](SECURITY.md).

## Setup

Requirements: Node.js 26 (see `.node-version`) and pnpm.

```fish
git clone https://github.com/enemyrpg/fireside.git
cd fireside
pnpm install
cp .env.example .env
pnpm dev        # server and dashboard in watch mode
```

If you also run a real Fireside server on the same machine, give the dev
server its own data folder and port, because only one server can use a
database at a time:

```fish
env DATA_DIR=./data-dev PORT=3101 pnpm dev
```

## Commands

| Command          | What it does                                                      |
| ---------------- | ----------------------------------------------------------------- |
| `pnpm dev`       | Server and dashboard in watch mode                                |
| `pnpm test`      | All tests (Vitest)                                                |
| `pnpm lint`      | ESLint and the Prettier check                                     |
| `pnpm format`    | Format with Prettier                                              |
| `pnpm typecheck` | TypeScript in every package                                       |
| `pnpm build`     | Build every package                                               |
| `pnpm test:csp`  | The built dashboard in Chromium, checked against the server's CSP |
| `pnpm icons`     | Redraw the app icons after changing `web/src/branding/logo.ts`    |
| `pnpm seed`      | Fill a separate seed database with simulated data (below)         |
| `pnpm cli …`     | The server CLI (keys, users, backup, restore, rebuild, reprocess) |

Run `pnpm lint`, `pnpm typecheck` and `pnpm test` before you open a pull
request. CI runs them too.

### Docker image

`docker-compose.yml` runs the released image from GHCR. To run the image
built from your checkout, add `docker-compose.build.yml` (see
[docs/self-hosting.md](docs/self-hosting.md#building-the-image-yourself)):

```fish
env COMPOSE_FILE=docker-compose.yml:docker-compose.build.yml docker compose up -d --build
```

The image checks CI runs are in `scripts/docker/` (`check-image.sh`,
`check-argon2.sh`, `check-native.sh`, `smoke-test.sh`).

### Seed data

`pnpm seed` fills a separate database (`data-seed/`) with simulated data for
2–3 made-up accounts over six months: sessions, AFK periods, world hops, XP,
loot and kill counts, raids (every mode, team sizes, purples for you and for
teammates, never with names), and edge cases like name changes, crashed
sessions and late events. The events go through `POST /api/v1/ingest`, the
same path as the plugin, without a running server. Two of the accounts also
get a collection log, stored as raw external data with no source turned on,
so a seed account is never looked up anywhere. Seed data contains no game
assets.

```fish
pnpm seed --reset                   # (re)create the seed database
pnpm seed --help                    # options: --seed, --accounts, --months, --until, --url, ...
env DATA_DIR=data-seed pnpm dev     # run the server on the seed data
```

The same `--seed` and `--until` always give the same data. `pnpm seed`
refuses to touch your normal database (`DATA_DIR`), and refuses a seed
database that already has data unless you pass `--reset`.

A server you start for testing should never make external calls: run it with
`PRICES_ENABLED=false`, `RUNEPROFILE_ENABLED=false` and an empty
`USER_AGENT_CONTACT` (variables set in the shell win over `.env`).

### Database migrations

The schema is in `server/src/db/schema.ts` (Drizzle). After changing it, run
`pnpm --filter @fireside/server db:generate` and commit `server/drizzle/`. CI
fails if the schema and the migrations don't match. To check pending
migrations on a copy of a real database (the original is only read):

```fish
pnpm --filter @fireside/server check-migration <db-file> [<work-dir>]
```

### Changing a projection's rules

When a change gives existing events other derived rows (a new rule, a fixed
calculation), bump the projection's `version` in the same pull request. Then
either give the projection a `recompute`, which updates only what the rule
changes, or rely on the fallback: a full rebuild. At startup, the server
recomputes every projection whose stored version is older, so existing data
needs no manual step (see
[ADR 0017](docs/decisions/0017-projection-rule-changes-recompute-at-startup.md)).

## Repository layout

| Folder     | Contents                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| `server/`  | Fastify + TypeScript + SQLite (Drizzle) server and CLI                                               |
| `web/`     | React + Vite + Tailwind + TanStack Query dashboard                                                   |
| `shared/`  | The API contract (Zod schemas, JSON Schema, fixtures), branding constants                            |
| `scripts/` | Tooling: Docker and CSP checks, screenshots, docs check, systemd install, GitHub repository settings |
| `deploy/`  | systemd unit templates                                                                               |
| `assets/`  | The Fireside logo (our own SVG)                                                                      |
| `docs/`    | User and developer documentation, decisions (ADRs)                                                   |

The RuneLite plugin lives in its own repository,
[fireside-plugin](https://github.com/enemyrpg/fireside-plugin).

## Pull requests

- **One task per pull request**, and keep it small. Unrelated fixes go in
  their own pull request.
- **Title in [Conventional Commits](https://www.conventionalcommits.org/)
  format**, e.g. `feat: weekly goals`, `fix: session end after a world hop`,
  `docs: backup on another disk`. Pull requests are squash-merged, so the
  title becomes the commit message, and the version and changelog of the
  next release (see [Releases](#releases)). The description is not part of
  the commit, so lines like `fix: …` in it don't reach the changelog. A check fails if the title
  doesn't follow the format. Types: `feat`, `fix`, `docs`, `chore`, `ci`,
  `build`, `test`, `refactor`, `perf`, `style`, `revert`, with an optional
  scope (`fix(web): …`) and `!` for a breaking change. The type follows the
  issue's type, not its labels: a Bug is usually a `fix:`, a Feature a
  `feat:`, and a Task `docs:`, `ci:`, `chore:` or another type that fits.
- **The template:** fill in what and why, how you tested it, whether the
  contract changed, and whether the docs are updated.
- **Checks:** a pull request can only be merged when these pass: Lint, test
  and build; Docs; CSP in Chromium; Docker image; PR title; Gitleaks (no
  secrets in the commits). Checks that don't apply to a change are skipped,
  which counts as passed. None of them need secrets, so they run the same
  for pull requests from forks (after a maintainer approves the first run).
  Lint, test and build sums up jobs that run in parallel: Lint and type check
  (with the migration check), Server tests (split into shards), Web, shared
  and scripts tests, and Build. It fails if any of them failed or was
  cancelled, and passes only when each one passed or was skipped because the
  change doesn't need it (a docs-only change skips them all, a change only in
  `web/` skips the server tests, one only in `server/` the other tests).
- **Tests:** contract validation and every calculation (gains, sessions,
  screen time, weekly summaries, goals) need tests. Tests use a mocked
  `fetch`, never the real network.
- **Docs:** update `docs/` when behaviour changes. Start with
  [architecture.md](docs/architecture.md), and follow
  [design.md](docs/design.md) for dashboard work. A lasting decision gets an
  ADR in [docs/decisions/](docs/decisions/README.md). Relative links in
  Markdown files are checked in CI.
- Code, comments, commit messages and UI text are in English. TypeScript is
  strict; no `any` without a comment explaining why.

### The contract rule

The API contract between the plugin and the server lives in `shared/`. Any
change to events or the API updates, in the same pull request:

- the Zod schemas in `shared/src/schemas/`,
- the fixtures,
- `CONTRACT_VERSION` in `shared/src/contract.ts`,
- and the documentation in `docs/` (for example
  [data-collected.md](docs/data-collected.md)).

`CONTRACT_VERSION` is semver: an addition is a minor version, a field that
keeps its shape but changes its documented meaning is a patch version, and a
breaking change needs a new major version and a new API or event schema
version ([ADR 0007](docs/decisions/0007-contract-package.md)). Raw events are
stored unchanged, and everything derived from them must be rebuildable
(`pnpm cli rebuild`). Events are idempotent by `eventId`.

## Issue types and labels

- **Type:** every issue has one GitHub issue type: Bug, Feature or Task.
  The issue forms set Bug or Feature. Docs and CI work is a Task.
- **What it is about:** `documentation` (docs only) and `ci` (workflows,
  build and tooling), on issues with the type Task. `question` for a
  question about use or setup.
- **Area:** usually one: `area: web`, `area: server`, `area: contract`,
  `area: deploy`.
- **Cross-cutting:** `accessibility` (barriers for people with disabilities)
  and `multi-user` (several users on one instance), alongside the area.
- **Status**, only when it applies: `needs decision`, `needs info`,
  `blocked`, `good first issue`, `help wanted`.
- **Cross-repo:** `needs plugin` when the issue also needs a change in
  [fireside-plugin](https://github.com/enemyrpg/fireside-plugin). Link the
  issues with GitHub's "blocked by" relationship, so the one that has to
  land first blocks the other.
- **Priority**, only when it applies: `priority: high` or `priority: low`.
  No priority label means normal.
- **On closing:** `wontfix` (close as "not planned" and link the ADR in
  [docs/decisions/](docs/decisions/README.md) it goes against) or
  `duplicate` (link the original issue).
- Set automatically, don't add them by hand: `dependencies` and `javascript`
  (Dependabot), `autorelease: pending` and `autorelease: tagged`
  (release-please).

## Releases

Releases are made by [release-please](https://github.com/googleapis/release-please)
([ADR 0016](docs/decisions/0016-release-setup.md)):

- Every merge to `main` updates an open release pull request,
  `chore(main): release <version>`. It bumps the version in every
  `package.json` and the image tag in `docker-compose.yml`, and adds the
  changes to `CHANGELOG.md`.
- The version follows the pull request titles since the last release:
  `fix:` gives a patch version, `feat:` a minor version. Before 1.0, a
  breaking change (`feat!:`) also gives a minor version. Other types
  (`chore:`, `ci:`, `test:`, …) are left out of the changelog.
- A maintainer merges the release pull request when it's time to release.
  That creates the tag `v<version>` and the GitHub release, which builds and
  pushes the image `ghcr.io/enemyrpg/fireside` (linux/amd64 and
  linux/arm64).
- Tags can't be moved or deleted. A bad release is fixed with a new one.

**The contract is released separately.** After a pull request that bumps
`CONTRACT_VERSION` (major, minor or patch) is merged, a maintainer pushes the
tag `contract-v<CONTRACT_VERSION>` on `main`, and
`.github/workflows/release-contract.yml` publishes the contract package
([architecture.md](docs/architecture.md#the-contract-package)).
release-please never touches these tags.

### Dependencies

Dependabot opens grouped pull requests every week for npm packages, GitHub
Actions, the Node image in the `Dockerfile` and the `cloudflared` image in
`docker-compose.yml`. Every action in `.github/workflows/` is pinned to a
commit SHA with its version in a comment (`uses: owner/action@<sha> # v1.2.3`);
a test checks this. Use the same form when you add an action.

## Rules that can't be bent

These protect users and keep the project within Jagex's and RuneLite's rules
(see [docs/legal.md](docs/legal.md)):

- **No Jagex assets** (item icons, game screenshots, logos) in the
  repository, fixtures, seed data or Docker image. Use placeholder icons.
- **No data about other players.** Loot from players has no name, and raid
  purples are only `SELF` or `TEAMMATE`.
- **No external network calls** except optional ones behind a setting,
  through `server/src/external/client.ts`, with the User-Agent from `.env`.
- **Security defaults:** the server binds to `127.0.0.1`, API keys are
  hashed, ingest keys only work for ingest, and no secrets go in the
  repository.
- **Unknown game data** (new items, bosses, quests) must never cause errors:
  store it and show it by name.
- **The name** comes from `shared/src/branding.ts`, never hard-coded.
- **No commercial features.**
