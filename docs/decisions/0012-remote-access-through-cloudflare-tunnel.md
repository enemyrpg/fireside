# 0012. Remote access only through Cloudflare Tunnel

- **Date:** 2026-11-17
- **Status:** Accepted

## Context

With friends on one instance ([ADR 0010](0010-multi-user-invite-only.md)), the
dashboard and the plugin must be reachable from other places, without opening
ports on a home router and without an app for each user.

## Decision

- Remote access goes only through a **Cloudflare Tunnel**: `cloudflared` on the
  same machine connects out to Cloudflare and forwards to `127.0.0.1`. The
  server keeps binding to loopback. Never the LAN, never a published port,
  never port forwarding.
- The server trusts Cloudflare's headers only with `TRUSTED_PROXY=cloudflare`,
  an https `PUBLIC_URL`, a request from loopback, and a valid
  `CF-Connecting-IP`. The `PUBLIC_URL` host only answers through that path.
- Before the tunnel could be turned on, the dashboard got security headers,
  limits per client IP, device cookies, two-factor authentication and a
  security review.
- Setup and the Cloudflare settings: [tunnel.md](../tunnel.md).

## Consequences

- Cloudflare sees the traffic. The privacy text says so.
- The server is on the public internet, and login is the only guard, so it
  must stay in login mode with every check above.
- **Tailscale Serve is not supported yet:** it forwards with headers the
  dashboard refuses (`X-Forwarded-Host`, `Tailscale-*`), so the dashboard
  answers `403`. The plugin's ingest works through it, but all clients then
  share one IP in the limits.
