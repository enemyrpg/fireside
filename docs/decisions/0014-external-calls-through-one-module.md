# 0014. All external calls through one module

- **Date:** 2026-11-16
- **Status:** Accepted

## Context

Fireside is self-hosted and private by default: a fresh install talks to no
one. Some features need outside data (GE prices, a collection log from
RuneProfile), and every call reveals the server's IP and the owner's contact
details to a third party. It must be impossible to add a call by accident.

## Decision

- Every external call goes through `server/src/external/client.ts`, the only
  place in `server/` allowed to use `fetch`. ESLint bans `fetch`,
  `XMLHttpRequest`, `WebSocket`, `EventSource` and the network modules
  everywhere else in `server/`, with two exceptions explained in the code (the
  seed script sending to the user's own server, and the Docker health check on
  loopback).
- A source is called only when its own flag in `.env` is on **and**
  `USER_AGENT_CONTACT` is set. Every request sends a descriptive User-Agent with
  that contact.
- Each source (`server/src/external/sources.ts`) has one https origin, no
  redirects, a timeout, a size limit, retries with waits and a minimum
  interval. Logs never have headers, queries or bodies.
- Tests replace `fetch` with one that throws and use mocks; nothing in tests or
  CI touches the network.

## Consequences

- A new source is a new entry in `sources.ts` with its own flag, a check of the
  service's terms, and an update of [data-collected.md](../data-collected.md).
- Without the flags, the server makes no calls at all.
