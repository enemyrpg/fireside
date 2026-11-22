# Security policy

## Reporting a vulnerability

Please report security problems **privately**, through GitHub's private
vulnerability reporting: on this repository's **Security** tab, select
**Report a vulnerability**. For a problem in the RuneLite plugin, use the
same form in [fireside-plugin](https://github.com/enemyrpg/fireside-plugin).

Please don't open a public issue, pull request or discussion for a
vulnerability. There is no email address for reports.

Include what you found, how to reproduce it, the Fireside version (Settings
→ Server, or `GET /api/v1/health`), and how the server was run (Docker,
systemd, tunnel). Never include real API keys, passwords, tunnel tokens, host
names of real instances or other players' names.

Fireside is a hobby project, so responses are best effort. You'll get an
answer as soon as possible, and fixes for confirmed problems are released
before details are made public.

## Supported versions

Only the latest release gets security fixes. Fireside is before 1.0, so
please upgrade to the latest release before reporting.

## Scope

In scope:

- Login and sessions: passwords, session cookies, login limits, CSRF and the
  checks on `Origin` and `Host`.
- Two-factor authentication, recovery codes, remembered browsers and the
  key file `fireside.key`.
- Invites and password reset links.
- API keys and the plugin's ingest endpoints.
- Access control between users: one user reaching another user's data, or a
  member reaching admin functions.
- The localhost guard: local mode answering anything but this machine, and
  the handling of proxy headers and `TRUSTED_PROXY`.
- Remote access set up as in [docs/tunnel.md](docs/tunnel.md) (Cloudflare
  Tunnel, the `cloudflared` service and unit).
- The Docker image, `docker-compose.yml` and the systemd units as shipped.
- Security headers and the content security policy.
- Backups, restore and the file permissions of the data folder.
- The plugin: how it stores and sends the API key, and anything that could
  send data to a host other than the configured server.

Out of scope:

- Setups that go against the documentation, e.g. `HOST` set to anything but
  `127.0.0.1`, or a reverse proxy other than Cloudflare Tunnel.
- Problems that need access to the server's files or to the user account
  that runs it.
- Denial of service through sheer volume.
- Cloudflare's, Tailscale's or RuneLite's own services.
- Third-party dependencies, unless Fireside uses them in a vulnerable way
  (report those upstream).
