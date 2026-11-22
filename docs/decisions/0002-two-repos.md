# 0002. Two repos: server and plugin

- **Date:** 2026-11-08
- **Status:** Accepted

## Context

The RuneLite Plugin Hub builds a plugin from a repo and a commit
(`repository=` and `commit=`), from the root of the repo. There is no
documented support for a plugin in a subfolder. The plugin is Java and Gradle;
the server and dashboard are TypeScript and pnpm.

## Decision

Two repos:

- [`fireside`](https://github.com/enemyrpg/fireside): server, dashboard,
  shared schemas and docs (MIT, except generated game data).
- [`fireside-plugin`](https://github.com/enemyrpg/fireside-plugin): the
  RuneLite plugin, from RuneLite's plugin template (BSD-2-Clause, like
  RuneLite).

They share the contract through a versioned package
([ADR 0007](0007-contract-package.md)), never through a shared folder.

## Consequences

- Each repo has its own CI, releases and versions. The plugin's README says
  which server versions it works with.
- A contract change is two steps: release it from `fireside`, then pin it in
  the plugin. The server is always updated first.
- The plugin repo must stay public for the Plugin Hub.
