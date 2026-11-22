# 0008. Docker uses host networking on Linux

- **Date:** 2026-11-14 (cloudflared on the host network: 2026-11-19)
- **Status:** Accepted

## Context

In local mode the dashboard only answers requests from a loopback socket with
a localhost `Host` ([ADR 0011](0011-local-and-login-mode.md)). With a
published port (`-p 127.0.0.1:3100:3100`), the server sees the Docker bridge's
address (`172.17.0.1`) and answers `403`. Trusting the bridge address would
let every container on the bridge reach the dashboard. Listening on `0.0.0.0`
with host networking would put it on the LAN.

## Decision

- `docker-compose.yml` runs the server with `network_mode: host` and
  `HOST=127.0.0.1` fixed in `environment:`, so it listens on the host's own
  loopback, exactly as without Docker. The local check is unchanged.
- `cloudflared` (the tunnel, behind the `tunnel` profile) also runs on the
  host network and connects to `http://127.0.0.1:<port>`, so tunnel traffic
  comes from loopback too.
- Docker-only settings are their own variables (`FIRESIDE_DATA_PATH`,
  `FIRESIDE_PORT`, `FIRESIDE_UID`, `FIRESIDE_GID`), so Docker and `pnpm dev`
  can run side by side.

## Consequences

- The container shares the host's network: no network isolation, it could
  reach other services on the host's localhost, and `ports:` doesn't work.
  This is weighed up with a non-root user, `cap_drop: ALL`,
  `no-new-privileges` and a read-only file system.
- It needs Docker Engine with root on Linux. Rootless Docker and Docker Desktop
  (macOS, Windows) are not supported; there, run without Docker.
- `cloudflared`'s metrics are pinned to `127.0.0.1`, since with host
  networking its default would be the LAN.
