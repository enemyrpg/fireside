# 0004. Accounts by (user, account hash)

- **Date:** 2026-11-08 (per user: 2026-11-17)
- **Status:** Accepted

## Context

OSRS players change their display names, and a name can later belong to
someone else. RuneLite gives every logged-in account a stable account hash.
From multi-user on ([ADR 0010](0010-multi-user-invite-only.md)), two users of
one instance could send data for the same account.

## Decision

- An OSRS account is identified by RuneLite's account hash (stored as text),
  never by its display name. Names are kept as history (`account_names`), with
  the current one from the latest `session.start`.
- On a multi-user instance, an account is the pair (user, account hash). If two
  users send data for the same hash, each gets their own copy.
- `account_ids` gives each pair a stable ID that the dashboard uses in URLs.
  A rebuild never changes it.

## Consequences

- Name changes never split an account's history, and a reused name never
  merges two accounts.
- An event without a valid account hash (not logged in, `-1`) is rejected.
- Every query on `events`, `accounts` or `account_ids` by account hash must
  also filter on the user. `server/src/db/owner-filter.test.ts` reads the
  source and fails if one doesn't.
