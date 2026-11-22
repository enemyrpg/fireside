# 0011. Local mode and login mode

- **Date:** 2026-11-17
- **Status:** Accepted

## Context

Most self-hosters run Fireside for themselves on the PC they play on and don't
want a login. Others share an instance or reach it from a phone. A login that
can be left off by mistake while the server is reachable from outside would be
worse than no feature.

## Decision

Two modes, read from the database on every request:

- **Local mode** (the default): one user, no password, no login. The
  dashboard's API only answers requests from this machine: a loopback socket, a
  localhost `Host`, no proxy headers, and no cross-site `Origin` on changes
  (`server/src/auth/local-only.ts`). Anything else gets `403`.
- **Login mode**: as soon as any user has a password. Login is always required,
  also on localhost. Can't be turned off while there is more than one user, and
  the server refuses to start with several users and no password.

Outside the network check in both modes: the static dashboard files (no data),
`GET /api/v1/health` (no data) and the plugin's ingest (needs a valid key).

## Consequences

- A fresh install works with nothing to set up and can't be reached from
  another machine, through `HOST`, a proxy or DNS rebinding.
- Turning on remote access needs login mode first: in local mode the
  dashboard's API refuses everything through the tunnel. The server warns at
  startup when `TRUSTED_PROXY` is set without a password.
- The plugin can still send through a tunnel in local mode, since ingest is
  authenticated by its key.
