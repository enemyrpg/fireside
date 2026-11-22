#!/usr/bin/env bash
# Checks that every Node image in the Dockerfile is the same, pinned to a full
# version and digest, and has the major version in .node-version. The image is
# written out in each FROM so Dependabot can update it (see the Dockerfile).
#
# Usage: scripts/docker/check-node-version.sh
set -euo pipefail

cd "$(dirname "$0")/../.."
major="$(tr -d '[:space:]' < .node-version)"
mapfile -t images < <(grep -oE '^FROM( --platform=[^ ]+)? node:[^ ]+' Dockerfile | awk '{print $NF}' | sort -u)

if [ "${#images[@]}" -ne 1 ]; then
  echo "::error::The Dockerfile uses ${#images[@]} different Node images, expected one: ${images[*]:-none}"
  exit 1
fi
image="${images[0]}"
if ! [[ "$image" =~ ^node:${major}\.[0-9]+\.[0-9]+-[a-z]+-slim@sha256:[0-9a-f]{64}$ ]]; then
  echo "::error::$image in the Dockerfile must be node:${major}.<minor>.<patch>-<distro>-slim@sha256:<digest> (.node-version is $major)."
  exit 1
fi
echo "Dockerfile: $image (Node $major): OK."
