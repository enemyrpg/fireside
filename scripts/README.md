# scripts

Tooling that is not part of the server or dashboard runtime.

- `ui-snapshots.ts` – full-page screenshots of every page and state from a
  temporary seed database, for comparing the dashboard with
  [docs/design.md](../docs/design.md). Writes to `.snapshots/` (git-ignored).
  Not part of CI. Needs `pnpm build`. Options (environment variables) are listed at
  the top of the file, among them:
  - `SNAPSHOT_THEMES`, `SNAPSHOT_WIDTHS`, `SNAPSHOT_ONLY` – which shots.
  - `SNAPSHOT_MEASURE=1` – also the computed styles of what is on screen
    (`<shot>.styles.json`), with colours as token names and the contrast of
    each text.
  - `SNAPSHOT_AXE=1` – also axe-core on each shot (`axe-report-<widths>.json`).
    Runs in the page, no network. `@axe-core/playwright` (MPL-2.0) is a
    devDependency of this package only: it is not in `web/` and not in the
    Docker image.
  - `SNAPSHOT_README=1` – only the README screenshots, into `docs/screenshots/`.
- `csp-check/` – runs the built dashboard in Chromium with the server's
  Content-Security-Policy (`pnpm test:csp`).
- `docs-check/` – checks that relative links in the Markdown files resolve
  (anchors included) and that `docs/self-hosting.md` lists exactly the
  variables in `.env.example`: `node scripts/docs-check/check-docs.ts`. Runs
  in CI as "Docs", with plain Node and no dependencies.
- `scratch-server.ts` – a server on a scratch database for ad hoc checks:
  `node scripts/scratch-server.ts <data-dir>`.
- `lib/scratch-server.ts` – how all of the above start a server. It never reads
  `.env`, has every external source off with no contact, its own data folder
  and a free port, and refuses to start (or stops the server) if an external
  call would be possible. The server's PID is in `<data-dir>/scratch-server.pid`
  while it runs (stop a leftover server by that PID, then delete the file),
  and its log, at `info`,
  in `<data-dir>/server.log`. When the server exits, the run fails if the log
  holds an external request.
- `docker/`, `systemd/` – checks and units for self-hosting.

Planned:

- `gamedata/` – generates the game data package in `shared/gamedata/` from the
  OSRS Wiki.
