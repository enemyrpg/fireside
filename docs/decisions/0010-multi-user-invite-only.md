# 0010. Multi-user, invite only

- **Date:** 2026-11-17
- **Status:** Accepted

## Context

The first version had one owner per instance. Friends wanted to use the same
instance instead of each running a server. That means other people's
passwords and data on the owner's machine, and a server reachable from outside.

## Decision

- An instance has one or more users, with the roles `admin` and `member`.
- **Invite only:** an admin creates one-time links that expire and can be
  revoked. Never open registration. `MAX_USERS` can cap the number.
- **Users are fully separate.** No shared views, comparisons or rankings. An
  admin can't see other users' game data in the dashboard. Every row belongs
  to a user, through the API key that sent it.
- Admins decide who may create API keys, can create a key for a user and can
  revoke any key.

## Consequences

- Every dashboard query filters on the logged-in user, and another user's IDs
  answer exactly like unknown IDs (`404`). An access-control test covers every
  route.
- The admin still has the database file and backups. The about page and the
  default instance text say so.
- Deleting a user deletes all their data
  ([ADR 0003](0003-raw-events-and-projections.md)).
- Multi-user needs login mode ([ADR 0011](0011-local-and-login-mode.md)).
