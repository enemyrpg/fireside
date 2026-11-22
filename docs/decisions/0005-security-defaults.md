# 0005. Security defaults

- **Date:** 2026-11-08
- **Status:** Accepted

## Context

Fireside is run by people we don't know, on their gaming PC or a home server,
often without thinking about networks. It stores their play data and, from
multi-user on, other people's passwords. The defaults have to be safe for
someone who changes nothing.

## Decision

- **Bind to `127.0.0.1`.** Listening on another interface needs an explicit
  `HOST` in `.env`. Never on the LAN, never a published Docker port
  ([ADR 0008](0008-docker-host-networking.md)). Remote access only through the
  tunnel ([ADR 0012](0012-remote-access-through-cloudflare-tunnel.md)).
- **API keys are hashed.** 32 random bytes shown once as `fs_…`, stored as
  SHA-256 and compared in constant time. Each key can be revoked on its own.
- **Ingest keys can write, not read.** A key is only read in the
  `/api/v1/ingest` scope and never logs anyone in. It can send events and
  icons. Its only reads are its own name with the server's versions and clock
  (`GET /ingest/verify`, for "Test connection" and clock skew), and which of
  the icon IDs it sent are missing (`POST /ingest/icons/wanted`, so the plugin
  doesn't upload every icon every session). Item IDs and skill and boss names
  are public game data. A leaked key can't read play data, log in or delete
  anything.
- **Sessions never work on ingest, and keys never work on the dashboard.**
- **No secrets in the repo.** Only `.env.example` is committed; the tunnel
  token lives in a `0600` file outside git, and the two-factor key in
  `DATA_DIR/fireside.key`.
- **Private files.** The data and backup folders are `0700` and the files
  `0600`, set at every startup.
- Weakening any of these needs a new decision here.

## Consequences

- A fresh install is only reachable from the machine it runs on.
- The plugin must handle `401` (stop and keep the queue) and `429` (back off).
- New routes that need a key go under `/api/v1/ingest/`; anything that reads
  user data goes in the dashboard scope with an access level.
