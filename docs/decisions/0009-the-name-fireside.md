# 0009. The name Fireside

- **Date:** 2026-11-14
- **Status:** Accepted

## Context

The project started under a working name that another Plugin Hub plugin
already used. The name had to be free on the Plugin Hub and GitHub, not a game
term or Jagex product (so it doesn't look official), and have a free domain.

## Decision

- The name is **Fireside** (slug `fireside`, API key prefix `fs_`), chosen from
  five candidates after checking the Plugin Hub, GitHub, the web and domains.
- The name lives in one place per codebase: `shared/src/branding.ts` here
  (display name, short name, key prefix, Jagex disclaimer, repo URLs), and the
  plugin's `Branding`. Code never writes it by hand.
- The RuneLite config group is `fireside` and never changes after publishing.
- The logo, a flame over crossed logs, is our own SVG
  (`web/src/branding/logo.ts`).

## Consequences

- A rename is a change to the branding constants, not a search through the
  code.
- No compatibility with the old working name is kept.
