# Decisions

Short records of the decisions that shape Fireside: the context, what was
decided, and what follows from it. They explain why the code is the way it
is. [architecture.md](../architecture.md) describes how it works.

| #                                                            | Decision                                        | Date       |
| ------------------------------------------------------------ | ----------------------------------------------- | ---------- |
| [0001](0001-sqlite.md)                                       | SQLite with Drizzle                             | 2026-11-08 |
| [0002](0002-two-repos.md)                                    | Two repos: server and plugin                    | 2026-11-08 |
| [0003](0003-raw-events-and-projections.md)                   | Raw events unchanged, rebuildable projections   | 2026-11-08 |
| [0004](0004-accounts-by-account-hash.md)                     | Accounts by (user, account hash)                | 2026-11-08 |
| [0005](0005-security-defaults.md)                            | Security defaults                               | 2026-11-08 |
| [0006](0006-no-data-about-other-players.md)                  | No data about other players                     | 2026-11-09 |
| [0007](0007-contract-package.md)                             | The contract package                            | 2026-11-09 |
| [0008](0008-docker-host-networking.md)                       | Docker uses host networking on Linux            | 2026-11-14 |
| [0009](0009-the-name-fireside.md)                            | The name Fireside                               | 2026-11-14 |
| [0010](0010-multi-user-invite-only.md)                       | Multi-user, invite only                         | 2026-11-17 |
| [0011](0011-local-and-login-mode.md)                         | Local mode and login mode                       | 2026-11-17 |
| [0012](0012-remote-access-through-cloudflare-tunnel.md)      | Remote access only through Cloudflare Tunnel    | 2026-11-17 |
| [0013](0013-no-service-worker.md)                            | No service worker                               | 2026-11-19 |
| [0014](0014-external-calls-through-one-module.md)            | All external calls through one module           | 2026-11-16 |
| [0015](0015-icons-from-the-users-client.md)                  | Icons from the user's own client                | 2026-11-15 |
| [0016](0016-release-setup.md)                                | Releases with release-please, images on GHCR    | 2026-11-22 |
| [0017](0017-projection-rule-changes-recompute-at-startup.md) | Rule changes recompute existing data at startup | 2026-11-23 |

## Adding a decision

1. Copy [0000-template.md](0000-template.md) to the next number with a short
   slug, e.g. `0016-weekly-summaries-cached.md`.
2. Fill in the date it was decided, the context, the decision and the
   consequences. Keep it short: a page at most.
3. Add it to the table above, in the same pull request as the change it
   explains.

A decision is never edited to say something else. When it changes, write a new
one and set the old one's status to "Superseded by" with a link to the new one.
