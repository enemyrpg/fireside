# 0006. No data about other players

- **Date:** 2026-11-09
- **Status:** Accepted

## Context

Other players haven't agreed to be tracked, and Jagex's rules for third-party
clients and the Plugin Hub's rules are strict about collecting data on others.
Some game events name other players: loot from a player, a teammate's purple in
a raid chat message.

## Decision

- The plugin never sends, and the server never stores, other players' names or
  other data about them.
- Loot from a player has no name (`PLAYER`, shown as "Player").
- A raid purple's recipient is only `SELF` or `TEAMMATE`. The plugin reads the
  name from chat in memory to tell which it is, and never sends, stores or logs
  it.
- **One exception:** the owner can type a nickname (and a note) for a raid drop
  in the dashboard's split tracker. It lives only in the split tracker's own
  tables, never in raw events, is never sent by the plugin, never logged, and
  never in exports or seed data.

## Consequences

- Features that would need other players' data (party lists, comparisons with
  friends, public hiscores of others) are out.
- Seed data and fixtures use made-up account names that can't be real players.
- See [legal.md](../legal.md) and [data-collected.md](../data-collected.md).
