# 0015. Icons from the user's own client

- **Date:** 2026-11-15
- **Status:** Accepted

## Context

Item, skill and boss icons are Jagex's graphics. They can't be in the repo,
fixtures, seed data or the Docker image, and fetching them from the OSRS Wiki
or Jagex would be an external call for every user. But a bank without icons is
hard to read.

## Decision

- The plugin uploads icons from the user's own RuneLite client: it asks
  `POST /ingest/icons/wanted` which ones the server is missing and uploads only
  those.
- Icons are resources, not events: they live in `item_icons` and `named_icons`,
  shared by the instance, never in `events`, and `rebuild` never touches them.
- The server checks the PNG structure and size and never decodes or re-encodes
  an image. The first icon for a key is kept.
- The dashboard shows placeholders until an icon exists. Tests and fixtures use
  images made by our own code (`shared/src/test-images.ts`).

## Consequences

- Real icons only exist in the user's own database. Screenshots in the repo
  show placeholders.
- An ingest key can learn which of the icons it asked about are missing (see
  [ADR 0005](0005-security-defaults.md)).
- An icon can't be replaced through the API. To refresh one, delete its row and
  the plugin uploads it again.
