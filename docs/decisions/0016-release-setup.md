# 0016. Releases with release-please, images on GHCR

- **Date:** 2026-11-22
- **Status:** Accepted

## Context

Fireside is self-hosted, so people need releases they can pin, a changelog
that tells them what changed, and an image they can pull instead of building.
The project is run by one maintainer on GitHub Free. The repository is public
and accepts pull requests from forks, so workflows run code from strangers
and must not leak write access. Contract releases
([ADR 0007](0007-contract-package.md)) already have their own tags and
version, set by hand by the contract rule.

## Decision

- **One version for the whole repo.** release-please
  (`release-please-config.json`, `.github/workflows/release-please.yml`)
  keeps a release pull request open on `main`. Merging it bumps the version
  in every `package.json` (the server reports it as `serverVersion`) and the
  image tag in `docker-compose.yml`, writes `CHANGELOG.md`, and creates the
  release and the tag `v<version>`. Versions and the changelog come from the
  Conventional Commit titles of squash-merged pull requests; before 1.0 a
  breaking change bumps the minor version.
- **The contract stays separate.** release-please only knows the package
  `.`, and only makes `v*` tags. It never creates `contract-v*` tags or
  changes `CONTRACT_VERSION` or `release-contract.yml`.
- **A GitHub App token.** Pull requests and releases made with
  `GITHUB_TOKEN` start no workflows, so the release PR would get no CI and
  the release would not build the image. release-please uses a token from a
  GitHub App installed only on this repo (contents, pull requests and issues:
  write). Without the App (forks), the job is skipped.
- **Images on GHCR.** A published `v*` release runs
  `.github/workflows/release-image.yml`: it builds linux/amd64 and
  linux/arm64, checks both (contents, argon2id and native modules, arm64
  under QEMU) and runs the smoke test before pushing
  `ghcr.io/enemyrpg/fireside:<version>`, `<major>.<minor>` and `latest`, with
  OCI labels and a build provenance attestation. `docker-compose.yml` pins
  the release image; `docker-compose.build.yml` builds from source.
- **Locked-down workflows.** Every workflow starts with
  `permissions: contents: read` and raises it per job; nothing uses
  `pull_request_target`; checks on pull requests need no secrets. Every
  action is pinned to a commit SHA with its version in a comment. Dependabot
  updates npm, Actions, the Node base image and the compose images weekly,
  grouped. Pull request titles are checked against Conventional Commits, and
  Gitleaks scans every pull request (`.github/workflows/pr.yml`).
- **Repository settings as a script.** `scripts/github/apply-repo-settings.sh`
  sets squash-only merging with the pull request title as the whole commit
  message (no description: release-please reads every `type:` line of a
  commit message as a change, so a description such as Dependabot's
  upstream release notes would add changelog entries and could bump the
  version), rulesets (pull requests and required checks on
  the default branch, no bypass; release tags can be created but never moved
  or deleted), secret scanning, private vulnerability reporting, CodeQL and
  read-only Actions defaults for the server, plugin and site repositories.

## Consequences

- A pull request title is part of the release: a wrong type means a wrong
  version or a missing changelog entry. The title check catches the format,
  not the meaning.
- A pull request description never reaches `main`. A `BEGIN_COMMIT_OVERRIDE`
  block in it still works, because release-please reads it from the pull
  request through the API, not from the commit.
- The App's private key is the one secret releases depend on. If it is lost
  or rotated, releases stop until the repo secret is updated; nothing else
  breaks.
- A checkout of `main` runs the last released image, not its own code,
  unless it builds with `docker-compose.build.yml`.
- A tag can't be fixed after it is pushed. A bad release is followed by a
  new one.
- The image is only as trusted as the workflow that built it; the
  attestation lets anyone check that it came from this repository's
  `release-image.yml`.
- A required check is a job name, and a job that is skipped counts as passed,
  also when it was skipped because a job it needs failed. So when a required
  check is split into parallel jobs, the required name goes to a summary job
  that always runs and fails unless each job passed or was skipped by the
  change filter ("Lint, test and build" in `.github/workflows/ci.yml`). The
  ruleset keeps the same check names.
